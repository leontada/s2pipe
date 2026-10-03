import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { Activity, Eye, Gamepad2, Home, Lock, Maximize, Minimize, Pause, Play as PlayIcon, Settings, Shield, Smartphone, UserX, Volume2, VolumeX, X, Zap } from "lucide-preact";

import type { AdminState, CaptureStatus, ClientMessage, PicoStatus, ServerMessage } from "@s2pipe/shared/types/node";
import { neutralPad, PAD_COUNT, type PadState, samePad } from "@s2pipe/shared/types/pad";

import {
	createInputTracker,
	type GamepadOption,
	type InputSource,
	isTouchDevice,
	KEYBOARD_HELP,
	listGamepads,
	TOUCH_INDEX,
} from "../utils/input.ts";
import TouchGamepad from "../components/touch-gamepad.tsx";
import {
	type AudioWhepHandle,
	onWhepDead,
	readStreamStats,
	startAudioWhep,
	startWhep,
	type StreamStats,
	type WhepHandle,
} from "../utils/whep.ts";
import { loadPlayPrefs, savePlayPrefs } from "../utils/prefs.ts";
import { turnstileSiteKey as getTurnstileSiteKey } from "../client.ts";

type Props = {
	nodeUrl: string;
	nodeLocked: boolean;
	turnstileSiteKey?: string;
};

function isTurnstileCleared(siteKey?: string): boolean {
	if (!siteKey) return true;
	try {
		return sessionStorage.getItem("s2pipe_turnstile_cleared") === "true";
	} catch {
		return false;
	}
}

type Toast = { id: number; text: string };

function wsUrl(nodeUrl: string): string {
	const url = new URL(nodeUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/socket";
	url.search = "";
	return url.href;
}

function send(ws: WebSocket | null, message: ClientMessage): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function picoTitle(pico: PicoStatus | null): string | undefined {
	if (!pico) return undefined;
	if (pico.error) return pico.error;
	const parts: string[] = [];
	if (pico.path) parts.push(pico.path);
	if (pico.connected && !pico.wake) parts.push("Sleep wake: set SWITCH_BT_MAC and CONTROLLER_BT_MAC");
	return parts.length ? parts.join("\n") : undefined;
}

function padLabel(id: string): string {
	const name = id.split("(")[0]?.trim();
	return name || id;
}

const NEUTRAL = neutralPad();

function sameIds(a: number[], b: number[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

function streamBanner(
	connected: boolean,
	capture: CaptureStatus | null,
	live: boolean,
): { title: string; body: string } | null {
	if (!connected) {
		return { title: "Connecting", body: "Waiting for the node..." };
	}
	if (capture && !capture.running) {
		return {
			title: "Capture is down",
			body: "MediaMTX is unreachable. The capture PC may be restarting.",
		};
	}
	if (!live) {
		return { title: "Waiting for stream", body: "Connecting to the capture card..." };
	}
	return null;
}

export default function Play({ nodeUrl, nodeLocked, turnstileSiteKey }: Props) {
	const effectiveSiteKey = turnstileSiteKey || getTurnstileSiteKey() || "0x4AAAAAAEwg5V8LpgJXde_q";
	const turnstilePassed = useSignal(false);
	const turnstileBlocked = useSignal(false);
	const isTurnstilePassed = turnstilePassed.value;
	const turnstileContainerRef = useRef<HTMLDivElement>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const stageRef = useRef<HTMLElement>(null);
	const whepRef = useRef<WhepHandle | null>(null);
	const audioRef = useRef<AudioWhepHandle | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const inputRef = useRef<ReturnType<typeof createInputTracker> | null>(null);
	const statsPrev = useRef<{ bytes: number; at: number } | null>(null);
	const toastSeq = useRef(0);
	const playRequested = useRef(false);
	const pendingPlays = useRef(0);
	const persistPrefs = useRef(false);

	const playing = useSignal(false);
	const playingCount = useSignal(0);
	const connected = useSignal(false);
	const capture = useSignal<CaptureStatus | null>(null);
	const pico = useSignal<PicoStatus | null>(null);
	const pads = useSignal<GamepadOption[]>([]);
	const chosen = useSignal<number[]>([]);
	const seats = useSignal<number[]>([]);
	const occupied = useSignal<number[]>([]);
	const livePads = useSignal<number[]>([]);
	const source = useSignal<InputSource | null>(null);
	const settings = useSignal(false);
	const muted = useSignal(false);
	const volume = useSignal(1);
	const fill = useSignal(false);
	const showStats = useSignal(false);
	const stats = useSignal<StreamStats | null>(null);
	const fullscreen = useSignal(false);
	const live = useSignal(false);
	const toasts = useSignal<Toast[]>([]);
	const touchEnabled = useSignal(false);
	const touchOpacity = useSignal(0.7);
	const isPortrait = useSignal(false);

	// Access Control & Admin signals
	const pinRequired = useSignal(false);
	const pinModalOpen = useSignal(false);
	const pinInput = useSignal("");
	const pinError = useSignal("");
	const lastAttemptedPin = useSignal("");
	const viewersCount = useSignal(0);
	const adminAuthed = useSignal(false);
	const adminPasswordInput = useSignal("");
	const adminError = useSignal("");
	const adminState = useSignal<AdminState | null>(null);
	const inputMuted = useSignal(false);

	useEffect(() => {
		const prefs = loadPlayPrefs();
		muted.value = prefs.muted;
		volume.value = prefs.volume;
		fill.value = prefs.fill;
		showStats.value = prefs.showStats;
		if (typeof prefs.touchOpacity === "number") {
			touchOpacity.value = prefs.touchOpacity;
		}
		const hasTouch = isTouchDevice();
		if (typeof prefs.touchEnabled === "boolean") {
			touchEnabled.value = prefs.touchEnabled;
		} else if (hasTouch) {
			touchEnabled.value = true;
		}

		const checkOrientation = () => {
			isPortrait.value = window.innerHeight > window.innerWidth;
		};
		checkOrientation();
		window.addEventListener("resize", checkOrientation);
		window.addEventListener("orientationchange", checkOrientation);
		return () => {
			window.removeEventListener("resize", checkOrientation);
			window.removeEventListener("orientationchange", checkOrientation);
		};
	}, []);

	useEffect(() => {
		if (!persistPrefs.current) {
			persistPrefs.current = true;
			return;
		}
		savePlayPrefs({
			muted: muted.value,
			volume: volume.value,
			fill: fill.value,
			showStats: showStats.value,
			touchEnabled: touchEnabled.value,
			touchOpacity: touchOpacity.value,
		});
	}, [muted.value, volume.value, fill.value, showStats.value, touchEnabled.value, touchOpacity.value]);

	function toast(text: string): void {
		const id = ++toastSeq.current;
		toasts.value = [...toasts.value, { id, text }];
		setTimeout(() => {
			toasts.value = toasts.value.filter((item) => item.id !== id);
		}, 4200);
	}

	// Cloudflare Turnstile Gatekeeper com Resiliência Anti-Bloqueador
	useEffect(() => {
		if (!effectiveSiteKey || isTurnstileCleared(effectiveSiteKey)) {
			turnstilePassed.value = true;
			return;
		}
		if (turnstilePassed.value) return;

		let widgetId: string | null = null;
		let unmounted = false;

		// Timer de segurança (3.5s): se um AdBlock/Brave Shields impedir o Turnstile de carregar, oferece o fallback
		const safetyTimer = globalThis.setTimeout(() => {
			if (!turnstilePassed.value) {
				turnstileBlocked.value = true;
			}
		}, 3500);

		let isRendering = false;
		function renderWidget() {
			if (unmounted || !turnstileContainerRef.current) return;
			if (widgetId || isRendering || turnstileContainerRef.current.childElementCount > 0) return;
			isRendering = true;
			const cf = (globalThis as unknown as { turnstile?: {
				render: (el: HTMLElement, opt: Record<string, unknown>) => string;
				remove: (id: string) => void;
			} }).turnstile;
			if (!cf) {
				turnstileBlocked.value = true;
				return;
			}

			try {
				widgetId = cf.render(turnstileContainerRef.current, {
					sitekey: effectiveSiteKey,
					theme: "dark",
					callback: (token: string) => {
						clearTimeout(safetyTimer);
						try {
							sessionStorage.setItem("s2pipe_turnstile_cleared", "true");
							sessionStorage.setItem("s2pipe_turnstile_token", token);
						} catch {}
						turnstilePassed.value = true;
					},
					"error-callback": () => {
						clearTimeout(safetyTimer);
						turnstileBlocked.value = true;
					},
				});
			} catch {
				turnstileBlocked.value = true;
			}
		}

		const cf = (globalThis as unknown as { turnstile?: unknown }).turnstile;
		if (cf) {
			renderWidget();
		} else {
			(globalThis as unknown as { onTurnstileLoaded?: () => void }).onTurnstileLoaded = () => {
				renderWidget();
			};
			let script = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]') as HTMLScriptElement | null;
			if (!script) {
				script = document.createElement("script");
				script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoaded";
				script.async = true;
				script.onerror = () => {
					clearTimeout(safetyTimer);
					turnstileBlocked.value = true;
				};
				script.onload = () => {
					renderWidget();
				};
				document.head.appendChild(script);
			} else {
				script.addEventListener("load", () => renderWidget());
			}
		}

		return () => {
			unmounted = true;
			clearTimeout(safetyTimer);
			if (widgetId) {
				const activeCf = (globalThis as unknown as { turnstile?: { remove: (id: string) => void } }).turnstile;
				try { activeCf?.remove(widgetId); } catch {}
			}
		};
	}, [effectiveSiteKey]);

	// Gestion de la connexion WHeP (Vidéo + Audio)
	useEffect(() => {
		if (!isTurnstilePassed) return;
		const video = videoRef.current;
		if (!video) return;
		let cancelled = false;
		let videoHandle: WhepHandle | null = null;
		let audioHandle: AudioWhepHandle | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let iceHinted = false;

		const cleanupWhep = () => {
			void videoHandle?.close();
			void audioHandle?.close();
			videoHandle = null;
			audioHandle = null;
			if (whepRef.current === videoHandle) whepRef.current = null;
			if (audioRef.current === audioHandle) audioRef.current = null;
		};

		const connect = async () => {
			try {
				videoHandle = await startWhep(nodeUrl, video);
				if (cancelled) {
					void videoHandle.close();
					return;
				}
				whepRef.current = videoHandle;
				live.value = true;

				onWhepDead(videoHandle.pc, (hadMedia) => {
					if (!hadMedia && !iceHinted) {
						iceHinted = true;
						toast("ICE failed. Set MEDIA_ICE_IP to this machine's LAN address, not 127.0.0.1.");
					}
					if (!cancelled) {
						live.value = false;
						cleanupWhep();
						retryTimer = globalThis.setTimeout(connect, hadMedia ? 1500 : 2000);
					}
				});
			} catch {
				if (!cancelled) {
					retryTimer = globalThis.setTimeout(connect, 2000);
				}
				return;
			}

			try {
				audioHandle = await startAudioWhep(nodeUrl);
				if (audioHandle) {
					if (cancelled) {
						void audioHandle.close();
						return;
					}
					audioRef.current = audioHandle;
					audioHandle.audio.muted = muted.value;
					audioHandle.audio.volume = volume.value;
				}
			} catch {
				// L'audio peut échouer sans bloquer la vidéo
			}
		};

		void connect();

		return () => {
			cancelled = true;
			clearTimeout(retryTimer);
			cleanupWhep();
		};
	}, [nodeUrl, isTurnstilePassed]);

	useEffect(() => {
		// deno-lint-ignore no-explicit-any
		const video = videoRef.current as any;
		if (!video) return;
		const onEnd = () => {
			fullscreen.value = false;
		};
		const onBegin = () => {
			fullscreen.value = true;
			settings.value = false;
		};
		video.addEventListener("webkitendfullscreen", onEnd);
		video.addEventListener("webkitbeginfullscreen", onBegin);
		return () => {
			video.removeEventListener("webkitendfullscreen", onEnd);
			video.removeEventListener("webkitbeginfullscreen", onBegin);
		};
	}, []);

	// Gestion WebSocket (Statut et Commandes)
	useEffect(() => {
		if (!isTurnstilePassed) return;
		let socket: WebSocket | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let isClosed = false;

		function connectWs() {
			if (isClosed) return;
			socket = new WebSocket(wsUrl(nodeUrl));
			wsRef.current = socket;

			socket.addEventListener("open", () => {
				wsRef.current = socket;
				connected.value = true;
				try {
					const savedAdmin = sessionStorage.getItem("s2pipe_admin_pass");
					if (savedAdmin) {
						send(socket, { op: "admin_login", password: savedAdmin });
					}
				} catch {}
				const count = chosen.value.length;
				if (count > 0) {
					pendingPlays.current += 1;
					const savedPin = localStorage.getItem("s2pipe_player_pin") ?? undefined;
					send(socket, { op: "play", pin: savedPin, data: { count } });
				}
			});

			socket.addEventListener("message", (event) => {
				if (typeof event.data !== "string") return;
				try {
					const msg = JSON.parse(event.data) as ServerMessage;
					if (msg.op === "play") {
						pendingPlays.current = Math.max(0, pendingPlays.current - 1);
						const granted = msg.data.seats ?? (msg.data.playing ? [0] : []);
						seats.value = granted;
						playing.value = granted.length > 0;
						if (granted.length > 0) {
							playRequested.current = false;
							pinModalOpen.value = false;
							pinError.value = "";
							if (lastAttemptedPin.value) {
								try {
									localStorage.setItem("s2pipe_player_pin", lastAttemptedPin.value);
								} catch {}
							}
						} else {
							playRequested.current = false;
							inputMuted.value = false;
							if (msg.data.error === "invalid_pin") {
								pinModalOpen.value = true;
								pinError.value = "Incorrect PIN. Please try again.";
								try {
									localStorage.removeItem("s2pipe_player_pin");
								} catch {}
							} else if (msg.data.error === "kicked_by_admin") {
								toast("You were moved to the audience by an admin.");
								chosen.value = [];
							} else if (msg.data.error === "all_seats_full") {
								toast("All remote pads are currently occupied.");
							} else {
								toast("Unable to take a pad.");
							}
						}
						if (pendingPlays.current === 0 && granted.length < chosen.value.length) {
							chosen.value = chosen.value.slice(0, granted.length);
							if (granted.length > 0) {
								toast(`Claimed ${granted.length} pad(s). Not enough remote pads for all.`);
							}
						}
					} else if (msg.op === "status") {
						capture.value = msg.data.capture;
						if (!msg.data.capture.running) live.value = false;
						pico.value = msg.data.pico;
						if (Array.isArray(msg.data.occupied)) {
							occupied.value = msg.data.occupied;
							playingCount.value = msg.data.occupied.length;
						} else if (typeof msg.data.playing === "number") {
							playingCount.value = msg.data.playing;
						}
						if (typeof msg.data.viewers === "number") {
							viewersCount.value = msg.data.viewers;
						}
						if (typeof msg.data.pinRequired === "boolean") {
							pinRequired.value = msg.data.pinRequired;
						}
					} else if (msg.op === "admin_auth") {
						if (msg.data.ok) {
							adminAuthed.value = true;
							adminError.value = "";
							if (adminPasswordInput.value) {
								try {
									sessionStorage.setItem("s2pipe_admin_pass", adminPasswordInput.value);
								} catch {}
							}
							toast("Admin mode authenticated.");
						} else {
							adminError.value = "Incorrect admin password.";
							try {
								sessionStorage.removeItem("s2pipe_admin_pass");
							} catch {}
						}
					} else if (msg.op === "admin_state") {
						adminState.value = msg.data;
						if (typeof msg.data.viewers === "number") {
							viewersCount.value = msg.data.viewers;
						}
					} else if (msg.op === "input_status") {
						if (inputMuted.value !== msg.data.muted) {
							inputMuted.value = msg.data.muted;
							if (msg.data.muted) {
								toast("⚠️ Controls paused by administrator");
							} else {
								toast("🎮 Controls resumed by administrator");
							}
						}
					} else if (msg.op === "admin_wake_ack") {
						if (msg.data.success) {
							toast("⚡ Wake beacon sent to Nintendo Switch!");
						} else {
							toast("⚠️ Wake cooldown active or Pico disconnected.");
						}
					} else if (msg.op === "admin_home_ack") {
						if (msg.data.success) {
							toast("🏠 Home button sent to console!");
						} else {
							toast("⚠️ Failed to send Home (Pico disconnected).");
						}
					} else if (msg.op === "ping") {
						send(socket, { op: "pong" });
					}
				} catch {
					// Ignorer les messages invalides
				}
			});

			socket.addEventListener("close", () => {
				if (wsRef.current === socket) {
					wsRef.current = null;
					connected.value = false;
				}
				playRequested.current = false;
				pendingPlays.current = 0;
				seats.value = [];
				playing.value = false;
				inputMuted.value = false;
				adminAuthed.value = false;
				if (!isClosed) {
					retryTimer = globalThis.setTimeout(connectWs, 1500);
				}
			});
		}

		connectWs();

		return () => {
			isClosed = true;
			clearTimeout(retryTimer);
			if (wsRef.current === socket) {
				wsRef.current = null;
			}
			if (socket) {
				socket.onclose = null;
				socket.onerror = null;
				socket.onopen = null;
				socket.onmessage = null;
				try {
					socket.close();
				} catch {}
			}
		};
	}, [nodeUrl, isTurnstilePassed]);

	// Gestion des manettes (Gamepads)
	useEffect(() => {
		const tracker = createInputTracker();
		inputRef.current = tracker;
		tracker.attach();

		const updatePads = () => {
			const next = listGamepads();
			pads.value = next;
			const still = chosen.value.filter((index) => index === TOUCH_INDEX || next.some((p) => p.index === index));
			const lost = still.length !== chosen.value.length;
			chosen.value = still;
			if (lost) syncSeats(still.length);
		};

		updatePads();
		globalThis.addEventListener("gamepadconnected", updatePads);
		globalThis.addEventListener("gamepaddisconnected", updatePads);

		return () => {
			tracker.detach();
			inputRef.current = null;
			globalThis.removeEventListener("gamepadconnected", updatePads);
			globalThis.removeEventListener("gamepaddisconnected", updatePads);
		};
	}, []);

	// Boucle d'envoi des inputs de la manette
	useEffect(() => {
		let frame = 0;
		const lastBySeat = new Map<number, PadState>();
		let lastAssignedKey = "";

		const loop = () => {
			frame = requestAnimationFrame(loop);
			const tracker = inputRef.current;
			if (!tracker) return;

			const sampled = new Map<number, PadState>();
			const active: number[] = [];
			for (const pad of pads.value) {
				const state = tracker.sample(pad.index, false);
				sampled.set(pad.index, state);
				if (!samePad(state, NEUTRAL)) active.push(pad.index);
			}
			if (touchEnabled.value) {
				const touchState = tracker.sample(TOUCH_INDEX, false);
				if (!samePad(touchState, NEUTRAL)) active.push(TOUCH_INDEX);
			}
			if (!sameIds(active, livePads.value)) livePads.value = active;

			const ws = wsRef.current;
			const assigned = seats.value;
			const assignedKey = assigned.join(",");
			if (!ws || ws.readyState !== WebSocket.OPEN || !assigned.length) {
				if (lastAssignedKey) {
					lastBySeat.clear();
					lastAssignedKey = "";
				}
				return;
			}

			if (assignedKey !== lastAssignedKey) {
				lastBySeat.clear();
				lastAssignedKey = assignedKey;
			}

			if (inputMuted.value) return;

			const currentChosen = chosen.value;
			for (let i = 0; i < assigned.length; i++) {
				const seat = assigned[i]!;
				const chosenId = currentChosen[i];
				let state: PadState;
				if (chosenId === TOUCH_INDEX) {
					state = tracker.sample(TOUCH_INDEX, true);
				} else if (typeof chosenId === "number") {
					state = i === 0
						? tracker.sample(chosenId, true)
						: (sampled.get(chosenId) ?? NEUTRAL);
				} else if (i === 0) {
					state = tracker.sample(null, true);
				} else {
					state = NEUTRAL;
				}

				const previous = lastBySeat.get(seat);
				if (previous && samePad(previous, state)) continue;
				lastBySeat.set(seat, state);
				send(ws, { op: "pad", data: state, seat });
			}
		};

		frame = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(frame);
	}, []);

	// Raccourci Clavier (Échap pour les paramètres)
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.repeat) return;
			if (event.code === "Escape") {
				settings.value = !settings.value;
			} else if (event.code === "KeyI" || event.code === "F3") {
				const target = event.target as HTMLElement | null;
				if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
				showStats.value = !showStats.value;
			}
		};
		globalThis.addEventListener("keydown", onKey);
		return () => globalThis.removeEventListener("keydown", onKey);
	}, []);

	// Synchro Volume / Mute
	useEffect(() => {
		if (videoRef.current) videoRef.current.muted = true;
		const audio = audioRef.current?.audio;
		if (!audio) return;
		audio.muted = muted.value;
		audio.volume = volume.value;
	}, [muted.value, volume.value, live.value]);

	// Récupération des stats du flux
	useEffect(() => {
		if (!showStats.value) {
			stats.value = null;
			return;
		}
		const timer = globalThis.setInterval(() => {
			const pc = whepRef.current?.pc;
			if (!pc) return;
			readStreamStats(pc, statsPrev.current).then((result) => {
				statsPrev.current = result.prev;
				stats.value = result.stats;
			}).catch(() => {});
		}, 1000);
		return () => clearInterval(timer);
	}, [showStats.value]);

	// Gestion Plein Écran
	useEffect(() => {
		const onFs = () => {
			const on = document.fullscreenElement === stageRef.current;
			fullscreen.value = on;
			if (on) settings.value = false;
		};
		document.addEventListener("fullscreenchange", onFs);
		return () => document.removeEventListener("fullscreenchange", onFs);
	}, []);

	function syncSeats(count: number, pin?: string): void {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		if (count > 0) {
			if (pinRequired.value) {
				let savedPin = pin ?? "";
				if (!savedPin) {
					try {
						savedPin = localStorage.getItem("s2pipe_player_pin") ?? "";
					} catch {}
				}
				if (!savedPin) {
					pinInput.value = "";
					pinError.value = "";
					pinModalOpen.value = true;
					return;
				}
				lastAttemptedPin.value = savedPin;
				pendingPlays.current += 1;
				send(ws, { op: "play", pin: savedPin, data: { count } });
				return;
			}
			pendingPlays.current += 1;
			send(ws, { op: "play", data: { count } });
			return;
		}
		pendingPlays.current = 0;
		seats.value = [];
		playing.value = false;
		inputMuted.value = false;
		send(ws, { op: "watch" });
	}

	function toggleSeat(index: number): void {
		const claimed = chosen.value.includes(index);
		if (!claimed && occupied.value.length >= PAD_COUNT) {
			toast("All remote pads are occupied.");
			return;
		}
		const nextChosen = claimed
			? chosen.value.filter((item) => item !== index)
			: [...chosen.value, index];
		chosen.value = nextChosen;
		syncSeats(nextChosen.length);
	}

	function play(): void {
		if (seats.value.length > 0) return;
		if (chosen.value.length === 0) {
			if (pads.value.length > 0) {
				chosen.value = [pads.value[0].index];
			} else if (touchEnabled.value || isTouchDevice()) {
				touchEnabled.value = true;
				chosen.value = [TOUCH_INDEX];
			} else {
				chosen.value = [0];
			}
		}
		syncSeats(chosen.value.length);
	}

	function submitPin(event?: Event): void {
		event?.preventDefault();
		const pin = pinInput.value.trim();
		if (!pin) {
			pinError.value = "Please enter the PIN.";
			return;
		}
		const targetCount = chosen.value.length > 0 ? chosen.value.length : 1;
		syncSeats(targetCount, pin);
	}

	function cancelPin(): void {
		pinModalOpen.value = false;
		pinError.value = "";
		pendingPlays.current = 0;
	}

	function submitAdminLogin(event?: Event): void {
		event?.preventDefault();
		const pass = adminPasswordInput.value.trim();
		if (!pass) {
			adminError.value = "Please enter the password.";
			return;
		}
		adminError.value = "";
		send(wsRef.current, { op: "admin_login", password: pass });
	}

	function adminLogout(): void {
		adminAuthed.value = false;
		adminPasswordInput.value = "";
		try {
			sessionStorage.removeItem("s2pipe_admin_pass");
		} catch {}
	}

	function kickSeat(seat: number): void {
		send(wsRef.current, { op: "admin_kick", seat });
	}

	function kickAllSeats(): void {
		if (confirm("Kick all active players to audience?")) {
			send(wsRef.current, { op: "admin_kick_all" });
		}
	}

	function sendAdminWake(): void {
		send(wsRef.current, { op: "admin_wake" });
	}

	function sendAdminHome(): void {
		send(wsRef.current, { op: "admin_home" });
	}

	function toggleSeatMute(seat: number, currentlyMuted: boolean): void {
		send(wsRef.current, {
			op: "admin_mute_seat",
			seat,
			muted: !currentlyMuted,
		});
	}

	function toggleAllMute(): void {
		const next = !(adminState.value?.allMuted ?? false);
		send(wsRef.current, {
			op: "admin_mute_all",
			muted: next,
		});
	}

	function watch(): void {
		chosen.value = [];
		syncSeats(0);
	}

	function onStageClick(): void {
		void videoRef.current?.play();
		void audioRef.current?.audio.play();
	}

	function toggleFullscreen(): void {
		// deno-lint-ignore no-explicit-any
		const video = videoRef.current as any;
		if (video?.webkitEnterFullscreen && !document.fullscreenEnabled) {
			video.webkitEnterFullscreen();
			return;
		}
		if (document.fullscreenElement) {
			void document.exitFullscreen();
		} else {
			void stageRef.current?.requestFullscreen();
		}
	}

	const hideHud = fullscreen.value;
	const padsFull = occupied.value.length >= PAD_COUNT && seats.value.length === 0;
	const banner = streamBanner(connected.value, capture.value, live.value);

	const seatByChosen = new Map<number, number>();
	for (let i = 0; i < seats.value.length && i < chosen.value.length; i++) {
		seatByChosen.set(chosen.value[i]!, seats.value[i]!);
	}

	return (
		<section
			id="play"
			ref={stageRef}
			data-fill={fill.value ? "true" : undefined}
			data-idle={hideHud ? "true" : undefined}
			data-touch={touchEnabled.value ? "true" : undefined}
			data-portrait={isPortrait.value ? "true" : undefined}
			onClick={onStageClick}
			onDblClick={(event) => {
				event.preventDefault();
				toggleFullscreen();
			}}
		>
			{!turnstilePassed.value && (
				<div class="turnstile-gate-overlay">
					<div class="turnstile-gate-card">
						<div class="turnstile-gate-header">
							<div class="turnstile-brand">
								<span class="turnstile-dot red"></span>
								<span class="turnstile-dot blue"></span>
								<h2 class="turnstile-title">NS2 Arcade</h2>
							</div>
							<p class="turnstile-subtitle">Nintendo Switch Remote Play</p>
						</div>
						<div class="turnstile-gate-body">
							{turnstileBlocked.value ? (
								<div class="turnstile-fallback">
									<p class="turnstile-warn">
										⚠️ Verificação bloqueada ou demorando. Se estiver usando AdBlock ou Brave Shields, desative para este site ou clique abaixo:
									</p>
									<button
										type="button"
										class="btn btn-primary btn-sm"
										onClick={() => {
											try {
												sessionStorage.setItem("s2pipe_turnstile_cleared", "true");
											} catch {}
											turnstilePassed.value = true;
										}}
									>
										Continuar para o Console
									</button>
								</div>
							) : (
								<>
									<div class="turnstile-status">
										<div class="turnstile-spinner"></div>
										<span>Verificando conexão segura...</span>
									</div>
									<div id="cf-turnstile-container" ref={turnstileContainerRef}></div>
								</>
							)}
						</div>
					</div>
				</div>
			)}
			<video
				ref={videoRef}
				autoplay
				muted
				playsInline
				onPlaying={() => {
					live.value = true;
				}}
			/>

			{banner && (
				<div class="play-banner">
					<h2>{banner.title}</h2>
					<p>{banner.body}</p>
				</div>
			)}

			{showStats.value && (
				<dl class="play-stats">
					<div>
						<dt>Ping</dt>
						<dd class={stats.value?.rttMs != null ? (stats.value.rttMs < 30 ? "stat-good" : stats.value.rttMs < 80 ? "stat-warn" : "stat-bad") : ""}>
							{stats.value?.rttMs != null ? `${stats.value.rttMs} ms` : "-"}
						</dd>
					</div>
					<div>
						<dt>FPS</dt>
						<dd>{stats.value ? Math.round(stats.value.fps) : "-"}</dd>
					</div>
					<div>
						<dt>Bitrate</dt>
						<dd>{stats.value ? (stats.value.bitrateKbps >= 1000 ? `${(stats.value.bitrateKbps / 1000).toFixed(1)} Mb/s` : `${stats.value.bitrateKbps} kb/s`) : "-"}</dd>
					</div>
					<div>
						<dt>Lost</dt>
						<dd class={stats.value && stats.value.packetsLost > 0 ? "stat-bad" : ""}>
							{stats.value ? stats.value.packetsLost : "-"}
						</dd>
					</div>
				</dl>
			)}

			<div class="play-hud" onClick={(event) => event.stopPropagation()}>
				<div class="play-top">
					<span class="play-brand">
						<span>NS2</span> Arcade
					</span>
					<div class="play-slots">
						<span class="play-count">
							{occupied.value.length}/{PAD_COUNT} playing
							{viewersCount.value > 0 && (
								<span class="play-viewers-tag" title={`${viewersCount.value} connected viewer${viewersCount.value > 1 ? "s" : ""}`}>
									· {viewersCount.value} viewer{viewersCount.value > 1 ? "s" : ""}
								</span>
							)}
						</span>
						<div class="play-seat-indicators" title={`${occupied.value.length} of ${PAD_COUNT} slots occupied`}>
							{Array.from({ length: PAD_COUNT }, (_, idx) => {
								const isYou = seats.value.includes(idx);
								const isOcc = occupied.value.includes(idx);
								const cls = isYou ? "seat-dot seat-dot-you" : isOcc ? "seat-dot seat-dot-occ" : "seat-dot";
								return (
									<span key={idx} class={cls} title={`Slot ${idx + 1}: ${isYou ? "You" : isOcc ? "Occupied" : "Free"}`}>
										{idx + 1}
									</span>
								);
							})}
						</div>
						<button
							type="button"
							class="play-slot"
							data-state={seats.value.length > 0 ? "you" : "free"}
							disabled={padsFull}
							onClick={play}
						>
							{pinRequired.value && seats.value.length === 0 ? <Lock size={14} aria-hidden="true" /> : <Gamepad2 size={14} aria-hidden="true" />}
							{seats.value.length > 0 ? `Playing (${seats.value.map((s) => `P${s + 1}`).join(", ")})` : "Play"}
						</button>
						<button
							type="button"
							class="play-slot"
							data-state={seats.value.length === 0 ? "you" : "free"}
							onClick={watch}
						>
							<Eye size={14} aria-hidden="true" />
							Watch
						</button>
					</div>
					<div class="play-status">
						{playing.value && inputMuted.value && (
							<span class="pill pill-muted" title="Your gamepad inputs are currently paused by the administrator">
								<Pause size={12} aria-hidden="true" />
								Inputs Paused
							</span>
						)}
						<span class="pill" data-ok={capture.value?.running ? "true" : "false"}>
							Capture {capture.value?.running ? "live" : "down"}
						</span>
						<span
							class="pill"
							data-ok={pico.value?.connected ? "true" : "false"}
							title={picoTitle(pico.value)}
						>
							Pico {pico.value?.connected ? "ready" : "off"}
						</span>
						<span class="pill" data-ok={connected.value ? "true" : "false"}>
							{connected.value ? "Connected" : "Connecting"}
						</span>
					</div>
				</div>

				<div class="play-bottom">
					<div class="play-controller">
						<div class="play-controller-bar">
							{(touchEnabled.value || isTouchDevice()) && (() => {
								const seat = seatByChosen.get(TOUCH_INDEX);
								const claimed = chosen.value.includes(TOUCH_INDEX);
								const full = occupied.value.length >= PAD_COUNT && !claimed;
								const state = seat !== undefined ? "live" : claimed ? "ready" : "off";
								const status = seat !== undefined ? `P${seat + 1}` : claimed ? "..." : full ? "Full" : "Play";
								return (
									<button
										type="button"
										class="play-pad-btn"
										data-state={state}
										data-active={livePads.value.includes(TOUCH_INDEX) ? "true" : undefined}
										disabled={full || !connected.value}
										onClick={() => toggleSeat(TOUCH_INDEX)}
									>
										<span class="pad-icon"><Smartphone size={13} /></span>
										<span class="pad-name">Touch Gamepad</span>
										<span class="pad-status">{status}</span>
									</button>
								);
							})()}

							{pads.value.map((pad) => {
								const seat = seatByChosen.get(pad.index);
								const claimed = chosen.value.includes(pad.index);
								const full = occupied.value.length >= PAD_COUNT && !claimed;
								const state = seat !== undefined ? "live" : claimed ? "ready" : "off";
								const status = seat !== undefined ? `P${seat + 1}` : claimed ? "..." : full ? "Full" : "Play";
								return (
									<button
										type="button"
										key={pad.index}
										class="play-pad-btn"
										data-state={state}
										data-active={livePads.value.includes(pad.index) ? "true" : undefined}
										disabled={full || !connected.value}
										onClick={() => toggleSeat(pad.index)}
									>
										<span class="pad-icon"><Gamepad2 size={13} /></span>
										<span class="pad-name">{padLabel(pad.id)}</span>
										<span class="pad-status">{status}</span>
									</button>
								);
							})}

							{pads.value.length === 0 && !touchEnabled.value && !isTouchDevice() && (
								<p class="play-hint">Connect a gamepad or click the phone icon to play.</p>
							)}
						</div>
						{connected.value && seats.value.length === 0 && (
							<span class="play-hint">Click a controller or Play above to join.</span>
						)}
						{connected.value && seats.value.length > 0 && inputMuted.value && (
							<span class="play-hint play-hint-warn">⚠️ Gamepad inputs paused by admin</span>
						)}
					</div>
					<div class="play-tools">
						<button
							type="button"
							class="btn btn-icon"
							aria-label="Touch Controls"
							title={touchEnabled.value ? "Ocultar Controles na Tela" : "Exibir Controles na Tela"}
							data-active={touchEnabled.value ? "true" : undefined}
							onClick={() => {
								touchEnabled.value = !touchEnabled.value;
								if (touchEnabled.value) {
									if (!chosen.value.includes(TOUCH_INDEX)) {
										chosen.value = [...chosen.value, TOUCH_INDEX];
										syncSeats(chosen.value.length);
									}
									toast("Controles na tela ativados");
								} else {
									if (chosen.value.includes(TOUCH_INDEX)) {
										chosen.value = chosen.value.filter((i) => i !== TOUCH_INDEX);
										syncSeats(chosen.value.length);
									}
									toast("Controles na tela ocultos");
								}
							}}
						>
							<Smartphone size={16} />
						</button>
						<button
							type="button"
							class="btn btn-icon"
							aria-label="Stats"
							title="Overlay Stats (I)"
							data-active={showStats.value ? "true" : undefined}
							onClick={() => showStats.value = !showStats.value}
						>
							<Activity size={16} />
						</button>
						<button
							type="button"
							class="btn btn-icon"
							aria-label={muted.value ? "Unmute" : "Mute"}
							onClick={() => muted.value = !muted.value}
						>
							{muted.value ? <VolumeX size={16} /> : <Volume2 size={16} />}
						</button>
						<button
							type="button"
							class="btn btn-icon"
							aria-label={fullscreen.value ? "Exit fullscreen" : "Fullscreen"}
							onClick={toggleFullscreen}
						>
							{fullscreen.value ? <Minimize size={16} /> : <Maximize size={16} />}
						</button>
						<button
							type="button"
							class="btn btn-icon"
							aria-label="Settings"
							onClick={() => settings.value = !settings.value}
						>
							<Settings size={16} />
						</button>
					</div>
				</div>
			</div>

			<TouchGamepad
				visible={touchEnabled.value && (seats.value.length > 0 || pads.value.length === 0)}
				opacity={touchOpacity.value}
			/>

			{settings.value && (
				<aside class="play-settings" onClick={(event) => event.stopPropagation()}>
					<div>
						<h2>Settings</h2>
						<button
							type="button"
							class="btn btn-icon"
							aria-label="Close settings"
							onClick={() => settings.value = false}
						>
							<X size={16} />
						</button>
					</div>

					<div class="field">
						<span>Node</span>
						<div class="play-node">
							<p>{nodeUrl}</p>
							{!nodeLocked && <a class="btn" href="/set-node">Modify</a>}
						</div>
					</div>

					<label class="field" htmlFor="setting-volume">
						<span>Volume</span>
						<input
							id="setting-volume"
							name="volume"
							type="range"
							min="0"
							max="1"
							step="0.05"
							value={volume.value}
							onInput={(event) => {
								volume.value = Number((event.target as HTMLInputElement).value);
								if (volume.value > 0) muted.value = false;
							}}
						/>
					</label>

					<label class="play-check" htmlFor="setting-fill">
						<input
							id="setting-fill"
							name="fill"
							type="checkbox"
							checked={fill.value}
							onChange={(event) => fill.value = (event.target as HTMLInputElement).checked}
						/>
						Fill (crop) instead of letterbox
					</label>

					<label class="play-check" htmlFor="setting-stats">
						<input
							id="setting-stats"
							name="showStats"
							type="checkbox"
							checked={showStats.value}
							onChange={(event) => showStats.value = (event.target as HTMLInputElement).checked}
						/>
						Overlay WebRTC stats
					</label>

					<label class="play-check" htmlFor="setting-touch-enabled">
						<input
							id="setting-touch-enabled"
							name="touchEnabled"
							type="checkbox"
							checked={touchEnabled.value}
							onChange={(event) => {
								const enabled = (event.target as HTMLInputElement).checked;
								touchEnabled.value = enabled;
								if (enabled && !chosen.value.includes(TOUCH_INDEX)) {
									chosen.value = [...chosen.value, TOUCH_INDEX];
									syncSeats(chosen.value.length);
								} else if (!enabled && chosen.value.includes(TOUCH_INDEX)) {
									chosen.value = chosen.value.filter((i) => i !== TOUCH_INDEX);
									syncSeats(chosen.value.length);
								}
							}}
						/>
						Controles na Tela (Touch Gamepad)
					</label>
					{touchEnabled.value && (
						<label class="field" htmlFor="setting-touch-opacity">
							<span>Opacidade do Controle ({Math.round(touchOpacity.value * 100)}%)</span>
							<input
								id="setting-touch-opacity"
								name="touchOpacity"
								type="range"
								min="0.2"
								max="1"
								step="0.05"
								value={touchOpacity.value}
								onInput={(event) => touchOpacity.value = Number((event.target as HTMLInputElement).value)}
							/>
						</label>
					)}

					<section class="play-help">
						<h3>Gamepad</h3>
						<dl>
							{KEYBOARD_HELP.map(([key, action]) => (
								<div>
									<dt>{key}</dt>
									<dd>{action}</dd>
								</div>
							))}
						</dl>
						<p>
							Home / PS / Guide is Home. Capture / Share is Capture. Xbox Guide opens Windows Game Bar:
							Settings &gt; Gaming &gt; Xbox Game Bar, turn off "Open Game Bar using this button on a
							controller". Until then, View+Menu is Home.
						</p>
					</section>

					<section class="play-admin-section">
						<div class="play-admin-header">
							<div class="play-admin-title">
								<Shield size={16} />
								<h3>Admin Backoffice</h3>
							</div>
							{adminAuthed.value && (
								<button
									type="button"
									class="btn btn-xs"
									onClick={adminLogout}
								>
									Logout
								</button>
							)}
						</div>
						{!adminAuthed.value ? (
							<form onSubmit={submitAdminLogin} class="admin-login-form">
								<p class="admin-desc">Room &amp; player access management</p>
								<div class="admin-login-row">
									<input
										id="admin-password-input"
										name="adminPassword"
										type="password"
										class="admin-input"
										placeholder="Admin password..."
										autoComplete="current-password"
										value={adminPasswordInput.value}
										onInput={(event) => adminPasswordInput.value = (event.target as HTMLInputElement).value}
									/>
									<button type="submit" class="btn btn-primary btn-sm">
										Login
									</button>
								</div>
								{adminError.value && <p class="play-modal-error">{adminError.value}</p>}
							</form>
						) : (
							<div class="admin-dashboard">
								<div class="admin-stats-row">
									<span>
										Audience: <strong>{adminState.value?.viewers ?? viewersCount.value}</strong>
									</span>
									<div class="admin-global-actions">
										<button
											type="button"
											class="btn btn-secondary btn-xs"
											onClick={sendAdminWake}
											title="Send BLE wake-up beacon to Nintendo Switch"
										>
											<Zap size={12} /> Wake Console
										</button>

										<button
											type="button"
											class="btn btn-secondary btn-xs"
											onClick={sendAdminHome}
											title="Press Home button on Nintendo Switch"
										>
											<Home size={12} /> Home
										</button>

										<button
											type="button"
											class={`btn btn-xs ${adminState.value?.allMuted ? "btn-warn" : "btn-secondary"}`}
											onClick={toggleAllMute}
											title="Pause or resume inputs for all players"
										>
											{adminState.value?.allMuted ? (
												<>
													<PlayIcon size={12} /> Resume All
												</>
											) : (
												<>
													<Pause size={12} /> Pause All
												</>
											)}
										</button>
										<button
											type="button"
											class="btn btn-danger btn-xs"
											onClick={kickAllSeats}
											title="Kick all players to audience"
										>
											Kick All
										</button>
									</div>
								</div>
								<div class="admin-seats-list">
									{(adminState.value?.seats ?? Array.from({ length: PAD_COUNT }, (_, i) => ({ seat: i, occupied: false, muted: false }))).map((s) => (
										<div key={s.seat} class="admin-seat-row">
											<span class="admin-seat-label">
												Slot {s.seat + 1}:{" "}
												{s.occupied ? (
													<span class={`seat-badge ${s.muted ? "seat-muted" : "seat-occupied"}`}>
														{s.muted ? "Paused" : "Playing"}
													</span>
												) : (
													<span class="seat-badge seat-vacant">Vacant</span>
												)}
											</span>
											{s.occupied && (
												<div class="admin-seat-actions">
													<button
														type="button"
														class={`btn btn-xs ${s.muted ? "btn-warn" : "btn-secondary"}`}
														onClick={() => toggleSeatMute(s.seat, s.muted)}
														title={s.muted ? "Resume player controls" : "Pause player controls"}
													>
														{s.muted ? <PlayIcon size={12} /> : <Pause size={12} />}
														{s.muted ? "Resume" : "Pause"}
													</button>
													<button
														type="button"
														class="btn btn-danger btn-xs"
														onClick={() => kickSeat(s.seat)}
														title="Kick to audience"
													>
														<UserX size={12} />
														Kick
													</button>
												</div>
											)}
										</div>
									))}
								</div>
							</div>
						)}
					</section>
				</aside>
			)}

			{pinModalOpen.value && (
				<div class="play-modal-overlay" onClick={cancelPin}>
					<div class="play-modal-card" onClick={(event) => event.stopPropagation()}>
						<div class="play-modal-header">
							<div class="play-modal-title">
								<Lock size={18} />
								<h3>Player PIN Required</h3>
							</div>
							<button
								type="button"
								class="btn btn-icon"
								aria-label="Close PIN modal"
								onClick={cancelPin}
							>
								<X size={16} />
							</button>
						</div>
						<form onSubmit={submitPin} class="play-modal-form">
							<p class="play-modal-desc">
								Enter the player PIN to take gamepad controls on this console.
							</p>
							<input
								id="player-pin-input"
								name="playerPin"
								type="password"
								class="play-modal-input"
								placeholder="Enter PIN..."
								autoFocus
								autoComplete="one-time-code"
								value={pinInput.value}
								onInput={(event) => pinInput.value = (event.target as HTMLInputElement).value}
							/>
							{pinError.value && <p class="play-modal-error">{pinError.value}</p>}
							<div class="play-modal-actions">
								<button type="button" class="btn" onClick={cancelPin}>
									Cancel
								</button>
								<button type="submit" class="btn btn-primary">
									Submit &amp; Play
								</button>
							</div>
						</form>
					</div>
				</div>
			)}

			<ul class="play-toasts" aria-live="polite">
				{toasts.value.map((item) => <li key={item.id}>{item.text}</li>)}
			</ul>
		</section>
	);
}
