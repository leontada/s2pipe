import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { Activity, Eye, EyeOff, Gamepad2, Home, Keyboard, Lock, Maximize, MessageSquare, Minimize, Pause, Play as PlayIcon, Send, Settings, Shield, Smartphone, Trash2, UserX, Volume2, VolumeX, X, Zap } from "lucide-preact";

import type { AdminState, CaptureStatus, ChatMessage, ClientMessage, PicoStatus, ServerMessage } from "@s2pipe/shared/types/node";
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
import StealthTerminal from "../components/stealth-terminal.tsx";
import {
	type AudioWhepHandle,
	onWhepDead,
	readStreamStats,
	startAudioWhep,
	startWhep,
	type StreamStats,
	type WhepHandle,
} from "../utils/whep.ts";
import { holdPage } from "../utils/page-session.ts";
import { loadPlayPrefs, savePlayPrefs } from "../utils/prefs.ts";
import {
	createVirtualPad,
	defaultVirtualPrefs,
	loadVirtualPrefs,
	saveVirtualPrefs,
	VIRTUAL_PREFS_KEY,
	type VirtualPad,
	type VirtualPrefs,
} from "../utils/virtual/mod.ts";
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

function playChatChime(volume: number): void {
	if (volume <= 0 || typeof window === "undefined") return;
	try {
		const AudioContextClass = globalThis.AudioContext ||
			(globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		if (!AudioContextClass) return;
		const ctx = new AudioContextClass();
		if (ctx.state === "suspended") {
			ctx.resume().catch(() => {});
		}
		const now = ctx.currentTime;
		const masterGain = ctx.createGain();
		masterGain.gain.setValueAtTime(volume * 0.35, now);
		masterGain.connect(ctx.destination);

		// Note 1: C6 (1046.5 Hz)
		const osc1 = ctx.createOscillator();
		const gain1 = ctx.createGain();
		osc1.type = "sine";
		osc1.frequency.setValueAtTime(1046.5, now);
		gain1.gain.setValueAtTime(0.8, now);
		gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
		osc1.connect(gain1);
		gain1.connect(masterGain);
		osc1.start(now);
		osc1.stop(now + 0.32);

		// Note 2: G6 (1567.98 Hz) with 0.07s delay
		const osc2 = ctx.createOscillator();
		const gain2 = ctx.createGain();
		osc2.type = "sine";
		osc2.frequency.setValueAtTime(1567.98, now + 0.07);
		gain2.gain.setValueAtTime(0.001, now);
		gain2.gain.setValueAtTime(1.0, now + 0.07);
		gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
		osc2.connect(gain2);
		gain2.connect(masterGain);
		osc2.start(now + 0.07);
		osc2.stop(now + 0.6);

		setTimeout(() => {
			try {
				ctx.close();
			} catch {}
		}, 800);
	} catch {
		// Ignore audio autoplay / initialization errors
	}
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
	standby: boolean,
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
	if (standby) {
		return null;
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
	const virtualRef = useRef<VirtualPad | null>(null);
	const persistVirtual = useRef(false);
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
	const virtualPrefs = useSignal<VirtualPrefs>(defaultVirtualPrefs());
	const virtualLive = useSignal(false);
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

	// UI Visibility signal (Clean View)
	const uiHidden = useSignal(false);

	// Privacy, Standby & Stealth signals
	const privacyMode = useSignal(false);
	const switchStandby = useSignal(false);
	const stealthMode = useSignal(false);

	// Chat signals
	const chatOpen = useSignal(false);
	const chatEnabled = useSignal(true);
	const chatNick = useSignal("");
	const chatMessages = useSignal<ChatMessage[]>([]);
	const chatInput = useSignal("");
	const chatUnread = useSignal(0);
	const chatEditingNick = useSignal(false);
	const chatNewNickInput = useSignal("");
	const chatMessagesEndRef = useRef<HTMLDivElement>(null);

	// Chat Toast & Audio signals
	const chatToastsEnabled = useSignal(true);
	const chatSoundVolume = useSignal(0.6);
	const chatToastsOnHidden = useSignal(true);
	const activeChatToast = useSignal<{
		id: string;
		nick: string;
		text: string;
		seat?: number;
		isAdmin?: boolean;
		time: number;
	} | null>(null);
	const chatToastTimer = useRef<number | null>(null);

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
		if (typeof prefs.chatToastsEnabled === "boolean") {
			chatToastsEnabled.value = prefs.chatToastsEnabled;
		}
		if (typeof prefs.chatSoundVolume === "number") {
			chatSoundVolume.value = prefs.chatSoundVolume;
		}
		if (typeof prefs.chatToastsOnHidden === "boolean") {
			chatToastsOnHidden.value = prefs.chatToastsOnHidden;
		}
		virtualPrefs.value = loadVirtualPrefs();

		const checkOrientation = () => {
			isPortrait.value = window.innerHeight > window.innerWidth;
		};
		checkOrientation();
		window.addEventListener("resize", checkOrientation);
		window.addEventListener("orientationchange", checkOrientation);
		return holdPage(() => {
			window.removeEventListener("resize", checkOrientation);
			window.removeEventListener("orientationchange", checkOrientation);
		});
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
			chatToastsEnabled: chatToastsEnabled.value,
			chatSoundVolume: chatSoundVolume.value,
			chatToastsOnHidden: chatToastsOnHidden.value,
		});
	}, [
		muted.value,
		volume.value,
		fill.value,
		showStats.value,
		touchEnabled.value,
		touchOpacity.value,
		chatToastsEnabled.value,
		chatSoundVolume.value,
		chatToastsOnHidden.value,
	]);

	useEffect(() => {
		if (!persistVirtual.current) {
			persistVirtual.current = true;
			return;
		}
		saveVirtualPrefs(virtualPrefs.value);
	}, [virtualPrefs.value]);

	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (event.key !== VIRTUAL_PREFS_KEY) return;
			const next = loadVirtualPrefs();
			virtualPrefs.value = { ...next, enabled: virtualPrefs.value.enabled };
		};
		globalThis.addEventListener("storage", onStorage);
		return holdPage(() => globalThis.removeEventListener("storage", onStorage));
	}, []);

	useEffect(() => {
		if (!virtualPrefs.value.enabled || !connected.value) return;
		if (seats.value.length > 0) return;
		syncSeats(1);
	}, [virtualPrefs.value.enabled, connected.value]);

	function toast(text: string): void {
		const id = ++toastSeq.current;
		toasts.value = [...toasts.value, { id, text }];
		setTimeout(() => {
			toasts.value = toasts.value.filter((item) => item.id !== id);
		}, 4200);
	}

	function sendChatMessage(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (trimmed === "/clear" || trimmed === "/limpar") {
			clearChat();
			chatInput.value = "";
			return;
		}
		send(wsRef.current, { op: "chat_send", text: trimmed });
		chatInput.value = "";
	}

	function clearAdminChat(): void {
		if (confirm("Deseja realmente limpar todo o histórico do chat da sala?")) {
			send(wsRef.current, { op: "admin_clear_chat" });
		}
	}

	function clearChat(): void {
		if (adminAuthed.value) {
			clearAdminChat();
		} else {
			if (confirm("Deseja limpar as mensagens da sua tela?")) {
				chatMessages.value = [];
				chatUnread.value = 0;
				activeChatToast.value = null;
				toast("Mensagens locais limpas.");
			}
		}
	}

	function updateNick(newNick: string): void {
		const trimmed = newNick.trim();
		if (!trimmed) return;
		send(wsRef.current, { op: "chat_nick", nick: trimmed });
	}

	function toggleAdminChat(enabled: boolean): void {
		send(wsRef.current, { op: "admin_toggle_chat", enabled });
	}

	function toggleAdminPrivacy(enabled: boolean): void {
		send(wsRef.current, { op: "admin_toggle_privacy", enabled });
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

		return holdPage(() => {
			unmounted = true;
			clearTimeout(safetyTimer);
			if (widgetId) {
				const activeCf = (globalThis as unknown as { turnstile?: { remove: (id: string) => void } }).turnstile;
				try { activeCf?.remove(widgetId); } catch {}
			}
		});
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

		return holdPage(() => {
			cancelled = true;
			clearTimeout(retryTimer);
			if (video) {
				try {
					video.pause();
					video.srcObject = null;
				} catch {}
			}
			cleanupWhep();
		});
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
		return holdPage(() => {
			video.removeEventListener("webkitendfullscreen", onEnd);
			video.removeEventListener("webkitbeginfullscreen", onBegin);
		});
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
				const count = virtualPrefs.value.enabled ? 1 : chosen.value.length;
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
						if (virtualPrefs.value.enabled) {
							if (granted.length >= 1) return;
							toast("All remote pads are taken.");
							return;
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
						if (typeof msg.data.privacyMode === "boolean") {
							privacyMode.value = msg.data.privacyMode;
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
						if (typeof msg.data.privacyMode === "boolean") {
							privacyMode.value = msg.data.privacyMode;
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
					} else if (msg.op === "chat_init") {
						chatEnabled.value = msg.data.enabled;
						let chosenNick = msg.data.userNick;
						try {
							const saved = localStorage.getItem("ns2_arcade_nick");
							if (saved && saved.trim()) {
								chosenNick = saved.trim();
								send(socket, { op: "chat_nick", nick: chosenNick });
							} else {
								localStorage.setItem("ns2_arcade_nick", chosenNick);
							}
						} catch {}
						chatNick.value = chosenNick;
						chatMessages.value = msg.data.history;
					} else if (msg.op === "chat_msg") {
						chatMessages.value = [...chatMessages.value, msg.data];
						if (!chatOpen.value && !msg.data.isSystem && msg.data.nick !== chatNick.value) {
							chatUnread.value = chatUnread.value + 1;
							const shouldShowToast = chatToastsEnabled.value && (!uiHidden.value || chatToastsOnHidden.value);
							if (shouldShowToast) {
								activeChatToast.value = {
									id: msg.data.id,
									nick: msg.data.nick,
									text: msg.data.text,
									seat: msg.data.seat,
									isAdmin: msg.data.isAdmin,
									time: msg.data.time,
								};
								if (chatToastTimer.current) {
									clearTimeout(chatToastTimer.current);
								}
								chatToastTimer.current = window.setTimeout(() => {
									activeChatToast.value = null;
								}, 6500);
							}
							if (chatSoundVolume.value > 0) {
								playChatChime(chatSoundVolume.value);
							}
						}
						setTimeout(() => {
							chatMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
						}, 50);
					} else if (msg.op === "chat_nick_ack") {
						if (msg.data.success) {
							chatNick.value = msg.data.nick;
							chatEditingNick.value = false;
							try {
								localStorage.setItem("ns2_arcade_nick", msg.data.nick);
							} catch {}
							toast(`Apelido atualizado para "${msg.data.nick}"`);
						} else {
							toast(`Erro ao trocar apelido: ${msg.data.error || "inválido"}`);
						}
					} else if (msg.op === "chat_cleared") {
						chatMessages.value = msg.data.history;
						chatUnread.value = 0;
						activeChatToast.value = null;
						toast("O histórico do chat foi limpo pelo administrador.");
					} else if (msg.op === "chat_status") {
						chatEnabled.value = msg.data.enabled;
						toast(msg.data.enabled ? "Chat da sala ativado" : "Chat desativado pelo administrador");
					} else if (msg.op === "privacy_status") {
						privacyMode.value = msg.data.enabled;
						toast(msg.data.enabled ? "🔒 Modo Privacidade ativado pelo Administrador." : "🔓 Modo Privacidade desativado.");
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

		return holdPage(() => {
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
					if (socket.readyState === WebSocket.OPEN) {
						send(socket, { op: "watch" });
					}
					socket.close();
				} catch {}
			}
			if (document.pointerLockElement) document.exitPointerLock();
			if (document.fullscreenElement) void document.exitFullscreen();
		});
	}, [nodeUrl, isTurnstilePassed]);

	// Gestion des manettes (Gamepads)
	useEffect(() => {
		const tracker = createInputTracker();
		inputRef.current = tracker;
		tracker.attach();

		const updatePads = () => {
			const next = listGamepads();
			pads.value = next;
			if (virtualPrefs.value.enabled) return;
			const still = chosen.value.filter((index) => index === TOUCH_INDEX || next.some((p) => p.index === index));
			const lost = still.length !== chosen.value.length;
			chosen.value = still;
			if (lost) syncSeats(still.length);
		};

		updatePads();
		globalThis.addEventListener("gamepadconnected", updatePads);
		globalThis.addEventListener("gamepaddisconnected", updatePads);

		return holdPage(() => {
			tracker.detach();
			inputRef.current = null;
			globalThis.removeEventListener("gamepadconnected", updatePads);
			globalThis.removeEventListener("gamepaddisconnected", updatePads);
		});
	}, []);

	useEffect(() => {
		if (!virtualPrefs.value.enabled) {
			virtualRef.current?.detach();
			virtualRef.current = null;
			virtualLive.value = false;
			return;
		}
		const pad = createVirtualPad();
		virtualRef.current = pad;
		pad.attach();
		return holdPage(() => {
			pad.detach();
			if (virtualRef.current === pad) virtualRef.current = null;
		});
	}, [virtualPrefs.value.enabled]);

	// Boucle d'envoi des inputs de la manette
	useEffect(() => {
		let frame = 0;
		const lastBySeat = new Map<number, PadState>();
		let lastAssignedKey = "";

		let alive = true;
		const loop = () => {
			if (!alive) return;
			frame = requestAnimationFrame(loop);

			if (virtualPrefs.value.enabled) {
				const virtual = virtualRef.current;
				const state = virtual?.sample(virtualPrefs.value) ?? NEUTRAL;
				const active = !samePad(state, NEUTRAL);
				if (active !== virtualLive.value) virtualLive.value = active;

				const ws = wsRef.current;
				const assigned = seats.value;
				if (!ws || ws.readyState !== WebSocket.OPEN || !assigned.length) {
					if (lastAssignedKey) {
						lastBySeat.clear();
						lastAssignedKey = "";
					}
					return;
				}
				const assignedKey = assigned.join(",");
				if (assignedKey !== lastAssignedKey) {
					lastBySeat.clear();
					lastAssignedKey = assignedKey;
				}

				if (inputMuted.value || stealthMode.value) {
					for (let i = 0; i < assigned.length; i++) {
						const seat = assigned[i]!;
						const previous = lastBySeat.get(seat);
						if (previous && !samePad(previous, NEUTRAL)) {
							lastBySeat.set(seat, NEUTRAL);
							send(ws, { op: "pad", data: NEUTRAL, seat });
						}
					}
					return;
				}

				const seat = assigned[0]!;
				const previous = lastBySeat.get(seat);
				if (previous && samePad(previous, state)) return;
				lastBySeat.set(seat, state);
				send(ws, { op: "pad", data: state, seat });
				return;
			}

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

			if (inputMuted.value || stealthMode.value) {
				// Ao pausar ou camuflar, reseta inputs ativos para neutralizar no Switch
				for (let i = 0; i < assigned.length; i++) {
					const seat = assigned[i]!;
					const previous = lastBySeat.get(seat);
					if (previous && !samePad(previous, NEUTRAL)) {
						lastBySeat.set(seat, NEUTRAL);
						send(ws, { op: "pad", data: NEUTRAL, seat });
					}
				}
				return;
			}

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
		return holdPage(() => {
			alive = false;
			cancelAnimationFrame(frame);
		});
	}, []);

	// Raccourci Clavier
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.repeat) return;

			// Atalho Secreto (Boss Key / Modo Camuflagem: Ctrl+Alt+Shift+B)
			if (event.ctrlKey && event.altKey && event.shiftKey && event.code === "KeyB") {
				event.preventDefault();
				event.stopPropagation();
				if (!stealthMode.value) {
					stealthMode.value = true;
				}
				return;
			}

			// Se camuflado, ignorar qualquer outro atalho do sistema
			if (stealthMode.value) return;

			if (event.code === "Escape") {
				if (document.pointerLockElement) return;
				if (chatOpen.value) {
					chatOpen.value = false;
				} else if (uiHidden.value) {
					uiHidden.value = false;
				} else {
					settings.value = !settings.value;
				}
			} else if (event.code === "Delete") {
				const target = event.target as HTMLElement | null;
				if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
				uiHidden.value = !uiHidden.value;
				if (uiHidden.value) {
					if (settings.value) settings.value = false;
					if (chatOpen.value) chatOpen.value = false;
				}
			} else if (event.shiftKey && event.code === "KeyC") {
				const target = event.target as HTMLElement | null;
				if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
				chatOpen.value = !chatOpen.value;
				if (chatOpen.value) {
					if (uiHidden.value) uiHidden.value = false;
					chatUnread.value = 0;
					if (settings.value) settings.value = false;
				}
			} else if (event.shiftKey && event.code === "KeyP") {
				const target = event.target as HTMLElement | null;
				if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
				if (adminAuthed.value) {
					event.preventDefault();
					toggleAdminPrivacy(!privacyMode.value);
				}
			} else if ((event.shiftKey && event.code === "KeyI") || event.code === "F3") {
				const target = event.target as HTMLElement | null;
				if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
				showStats.value = !showStats.value;
			}
		};
		globalThis.addEventListener("keydown", onKey);
		return holdPage(() => globalThis.removeEventListener("keydown", onKey));
	}, []);

	// Synchro Volume / Mute (Mutando para o público em Modo Privacidade e Mudo total em Modo Camuflagem)
	useEffect(() => {
		if (videoRef.current) videoRef.current.muted = true;
		const audio = audioRef.current?.audio;
		if (!audio) return;
		if (stealthMode.value) {
			audio.muted = true;
		} else {
			const isPrivateForMe = privacyMode.value && !adminAuthed.value;
			if (isPrivateForMe) {
				audio.muted = true;
			} else {
				audio.muted = muted.value;
				audio.volume = volume.value;
			}
		}
	}, [muted.value, volume.value, live.value, privacyMode.value, adminAuthed.value, stealthMode.value]);

	// Detecção inteligente de Standby / Console em Repouso
	useEffect(() => {
		let canvas: HTMLCanvasElement | null = null;
		let ctx: CanvasRenderingContext2D | null = null;
		let blackStreak = 0;
		let notLiveStreak = 0;

		// 60 amostras a cada 2000ms = 120 segundos (2 minutos) contínuos de tela 100% preta
		// Garante que telas de loading ou transições entre fases nunca disparem o modo Standby por engano
		const BLACK_STANDBY_MAX_TICKS = 60;

		const timer = globalThis.setInterval(() => {
			if (stealthMode.value) return;
			if (privacyMode.value) {
				blackStreak = 0;
				if (switchStandby.value) switchStandby.value = false;
				return;
			}

			// Se o servidor WebSocket está conectado e MediaMTX está ativo, mas o vídeo não está ao vivo (Switch desligado/sem sinal HDMI)
			if (!live.value) {
				blackStreak = 0;
				if (connected.value && (!capture.value || capture.value.running)) {
					notLiveStreak++;
					// Após 2 checagens (~4s) sem sinal de vídeo ativo, aciona a tela de Standby
					if (notLiveStreak >= 2) {
						if (!switchStandby.value) switchStandby.value = true;
					}
				} else {
					notLiveStreak = 0;
					if (switchStandby.value) switchStandby.value = false;
				}
				return;
			}

			// Se o vídeo está ao vivo, reseta o streak de stream inativo
			notLiveStreak = 0;

			const video = videoRef.current;
			if (!video || video.readyState < 2) {
				return;
			}

			// Amostragem de luminância para detectar tela preta com vídeo conectado (ex: console suspenso com placa gerando sinal preto)
			// Exige 2 minutos (120s) de escuridão contínua para evitar falsos positivos em telas de loading
			try {
				if (!canvas) {
					canvas = document.createElement("canvas");
					canvas.width = 4;
					canvas.height = 4;
					ctx = canvas.getContext("2d", { willReadFrequently: true });
				}
				if (!ctx) return;
				ctx.drawImage(video, 0, 0, 4, 4);
				const imgData = ctx.getImageData(0, 0, 4, 4).data;
				let maxLum = 0;
				for (let i = 0; i < imgData.length; i += 4) {
					const lum = (imgData[i]! + imgData[i + 1]! + imgData[i + 2]!) / 3;
					if (lum > maxLum) maxLum = lum;
				}
				if (maxLum < 6) {
					blackStreak++;
					if (blackStreak >= BLACK_STANDBY_MAX_TICKS) {
						if (!switchStandby.value) switchStandby.value = true;
					}
				} else {
					blackStreak = 0;
					if (switchStandby.value) {
						switchStandby.value = false;
					}
				}
			} catch {
				// Ignora se indisponível
			}
		}, 2000);

		return holdPage(() => clearInterval(timer));
	}, [isTurnstilePassed]);

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
		return holdPage(() => clearInterval(timer));
	}, [showStats.value]);

	// Gestion Plein Écran
	useEffect(() => {
		const onFs = () => {
			const on = document.fullscreenElement === stageRef.current;
			fullscreen.value = on;
			if (on) settings.value = false;
		};
		document.addEventListener("fullscreenchange", onFs);
		return holdPage(() => document.removeEventListener("fullscreenchange", onFs));
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
		if (virtualPrefs.value.enabled) return;
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
		if (virtualPrefs.value.enabled) {
			syncSeats(1);
			return;
		}
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
		toast("Enviando sinal de ativação (BLE) ao Switch...");
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
		if (virtualPrefs.value.enabled) {
			setVirtualEnabled(false);
			return;
		}
		chosen.value = [];
		syncSeats(0);
	}

	function setVirtualEnabled(enabled: boolean): void {
		if (enabled === virtualPrefs.value.enabled) {
			if (enabled) syncSeats(1);
			return;
		}
		if (enabled) {
			if (occupied.value.length >= PAD_COUNT && seats.value.length === 0) {
				toast("All remote pads are taken.");
				return;
			}
			chosen.value = [];
			virtualPrefs.value = { ...virtualPrefs.value, enabled: true };
			syncSeats(1);
			return;
		}
		virtualPrefs.value = { ...virtualPrefs.value, enabled: false };
		syncSeats(0);
	}

	function onStageClick(): void {
		void videoRef.current?.play();
		void audioRef.current?.audio.play();
		if (settings.value) return;
		const virtual = virtualRef.current;
		if (!virtual || !virtualPrefs.value.enabled) return;
		if (virtual.usesMouseAxis(virtualPrefs.value) && stageRef.current) {
			virtual.requestPointerLock(stageRef.current);
		}
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
	const banner = streamBanner(connected.value, capture.value, live.value, switchStandby.value);

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
			onContextMenu={(event) => {
				if (virtualPrefs.value.enabled) event.preventDefault();
			}}
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
				class={privacyMode.value && !adminAuthed.value ? "video-privacy-hidden" : undefined}
				onPlaying={() => {
					live.value = true;
				}}
			/>

			{/* Admin Privacy Banner (Admin can still see the console feed, but gets a clear warning bar) */}
			{adminAuthed.value && privacyMode.value && (
				<div class="admin-privacy-banner">
					<div class="admin-privacy-banner-content">
						<EyeOff size={16} class="admin-privacy-banner-icon" />
						<span class="admin-privacy-banner-text">
							<strong>MODO PRIVACIDADE ATIVO:</strong> O público está vendo a tela de censura e o áudio dos espectadores está mutado.
						</span>
					</div>
					<button
						type="button"
						class="btn btn-xs btn-warn admin-privacy-banner-btn"
						onClick={() => toggleAdminPrivacy(false)}
						title="Desativar Modo Privacidade (Shift + P)"
					>
						Desativar (Shift + P)
					</button>
				</div>
			)}

			{/* Spectator Privacy Overlay */}
			{privacyMode.value && !adminAuthed.value && (
				<div class="play-privacy-overlay">
					<div class="privacy-card">
						<div class="privacy-shield-container">
							<div class="privacy-shield-glow"></div>
							<div class="privacy-shield-icon">
								<EyeOff size={42} />
							</div>
						</div>
						<h2 class="privacy-title">Transmissão em Pausa Privada</h2>
						<p class="privacy-subtitle">
							O administrador pausou a transmissão para configuração segura do console ou troca de credenciais.
						</p>
						<div class="privacy-badge">
							<span class="privacy-dot"></span>
							<span>Retornando em instantes...</span>
						</div>
					</div>
				</div>
			)}

			{/* Standby / Sleep Screen (When Switch is sleeping or video signal is dark) */}
			{switchStandby.value && !privacyMode.value && (
				<div class="play-standby-overlay">
					<div class="standby-card">
						<div class="standby-dock-art">
							<div class="dock-zzz-container">
								<span class="dock-zzz z1">Z</span>
								<span class="dock-zzz z2">z</span>
								<span class="dock-zzz z3">z</span>
							</div>
							<div class="dock-console">
								<div class="dock-screen-bezel">
									<div class="dock-screen-content">
										<div class="dock-screen-glow"></div>
									</div>
								</div>
								<div class="dock-base">
									<div class="dock-cutout"></div>
									<div class="dock-led-container" title="Modo Repouso">
										<span class="dock-led-pulse"></span>
										<span class="dock-led-core"></span>
									</div>
								</div>
							</div>
						</div>

						<h2 class="standby-title">Nintendo Switch em Repouso</h2>
						<p class="standby-subtitle">
							O console está em modo de suspensão / aguardando ativação.
						</p>

						{adminAuthed.value ? (
							<div class="standby-admin-box">
								<button
									type="button"
									class="btn btn-primary standby-wake-btn"
									onClick={() => {
										sendAdminWake();
										sendAdminHome();
									}}
								>
									<Zap size={16} /> Acordar Console (Admin)
								</button>
								<span class="standby-admin-note">
									Beacon BLE + Botão Home transmitidos ao console
								</span>
							</div>
						) : (
							<div class="standby-spectator-box">
								<div class="standby-spectator-badge">
									<span class="standby-pulse-dot"></span>
									<span>Aguardando administrador acordar o Switch...</span>
								</div>
								<button
									type="button"
									class="standby-login-link"
									title="Fazer login como administrador para acessar os controles de despertar"
									onClick={() => {
										settings.value = true;
									}}
								>
									<Lock size={12} /> É o administrador? Entrar para acordar
								</button>
							</div>
						)}
					</div>
				</div>
			)}

			{banner && (
				<div class="play-banner">
					<h2>{banner.title}</h2>
					<p>{banner.body}</p>
				</div>
			)}

			{showStats.value && !uiHidden.value && (
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

			<div class={`play-hud ${uiHidden.value ? "ui-hidden" : ""}`} onClick={(event) => event.stopPropagation()}>
				<div class="play-top">
					<button
						type="button"
						class="play-brand brand-interactive"
						title={uiHidden.value ? "Restaurar interface (Delete)" : "Ocultar interface (Delete)"}
						onClick={(e: MouseEvent) => {
							e.stopPropagation();
							uiHidden.value = !uiHidden.value;
							if (uiHidden.value) {
								if (settings.value) settings.value = false;
								if (chatOpen.value) chatOpen.value = false;
							}
						}}
					>
						<span>NS2</span> Arcade
					</button>
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
							{virtualPrefs.value.enabled ? (
								<button
									type="button"
									class="play-pad-btn"
									data-state={seats.value[0] !== undefined ? "live" : "ready"}
									data-active={virtualLive.value ? "true" : undefined}
									disabled={!connected.value}
									onClick={() => setVirtualEnabled(false)}
								>
									<span class="pad-icon"><Keyboard size={13} /></span>
									<span class="pad-name">Virtual Controller</span>
									<span class="pad-status">{seats.value[0] !== undefined ? `P${seats.value[0] + 1}` : "..."}</span>
								</button>
							) : (
								<>
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
										<>
											<p class="play-hint">Connect a gamepad or click the phone icon to play.</p>
											<button
												type="button"
												class="btn btn-xs"
												disabled={!connected.value || occupied.value.length >= PAD_COUNT}
												onClick={() => setVirtualEnabled(true)}
											>
												<Keyboard size={13} /> Use virtual controller
											</button>
										</>
									)}
								</>
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
							title="Overlay Stats (Shift + I / F3)"
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
							class="btn btn-icon play-chat-btn"
							aria-label="Chat da Sala"
							title={chatOpen.value ? "Fechar Chat (Shift + C)" : "Abrir Chat da Sala (Shift + C)"}
							data-active={chatOpen.value ? "true" : undefined}
							onClick={() => {
								chatOpen.value = !chatOpen.value;
								if (chatOpen.value) {
									chatUnread.value = 0;
									if (settings.value) settings.value = false;
								}
							}}
						>
							<MessageSquare size={16} />
							{chatUnread.value > 0 && !chatOpen.value && (
								<span class="chat-badge">{chatUnread.value > 9 ? "9+" : chatUnread.value}</span>
							)}
						</button>
						<button
							type="button"
							class="btn btn-icon"
							aria-label="Settings"
							onClick={() => {
								settings.value = !settings.value;
								if (settings.value && chatOpen.value) chatOpen.value = false;
							}}
						>
							<Settings size={16} />
						</button>
					</div>
				</div>
			</div>

			<TouchGamepad
				visible={!uiHidden.value && touchEnabled.value && (seats.value.length > 0 || pads.value.length === 0)}
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

					<div class="settings-divider" />
					<h3 class="settings-subtitle">Notificações do Chat</h3>

					<label class="play-check" htmlFor="setting-chat-toasts">
						<input
							id="setting-chat-toasts"
							name="chatToastsEnabled"
							type="checkbox"
							checked={chatToastsEnabled.value}
							onChange={(event) => chatToastsEnabled.value = (event.target as HTMLInputElement).checked}
						/>
						Pop-up flutuante ao receber mensagens
					</label>

					{chatToastsEnabled.value && (
						<label class="play-check" htmlFor="setting-chat-toasts-hidden">
							<input
								id="setting-chat-toasts-hidden"
								name="chatToastsOnHidden"
								type="checkbox"
								checked={chatToastsOnHidden.value}
								onChange={(event) => chatToastsOnHidden.value = (event.target as HTMLInputElement).checked}
							/>
							Exibir pop-up mesmo com interface oculta
						</label>
					)}

					<div class="field setting-volume-field">
						<div class="field-header-row">
							<span>Som de Notificação ({Math.round(chatSoundVolume.value * 100)}%)</span>
							<button
								type="button"
								class="btn btn-xs btn-outline"
								onClick={() => playChatChime(chatSoundVolume.value || 0.6)}
								title="Ouvir som de teste"
							>
								<Volume2 size={12} /> Testar
							</button>
						</div>
						<input
							id="setting-chat-sound"
							name="chatSoundVolume"
							type="range"
							min="0"
							max="1"
							step="0.05"
							value={chatSoundVolume.value}
							onInput={(event) => chatSoundVolume.value = Number((event.target as HTMLInputElement).value)}
						/>
					</div>

					<div class="settings-divider" />
					<section class="play-help">
						<h3>Virtual controller</h3>
						<label class="play-check" htmlFor="setting-virtual-enabled">
							<input
								id="setting-virtual-enabled"
								type="checkbox"
								checked={virtualPrefs.value.enabled}
								onChange={(event) => setVirtualEnabled((event.target as HTMLInputElement).checked)}
							/>
							Enable virtual controller
						</label>
						<p>
							Keyboard and mouse drive one Pico seat. Physical gamepads on this browser are ignored while
							this is on. It stays off after a reload.
						</p>
						<a class="btn btn-block" href="/controller" target="_blank" rel="noopener noreferrer">Map buttons ↗</a>
					</section>

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
								<div class="admin-privacy-box">
									<div class="admin-privacy-header-row">
										<span class="admin-privacy-title">
											<Shield size={13} style="vertical-align: -2px; margin-right: 4px;" />
											Modo Privacidade / Censura
										</span>
										<span class={`admin-privacy-status ${privacyMode.value ? "active" : "inactive"}`}>
											{privacyMode.value ? "ATIVO (Oculto)" : "Desativado"}
										</span>
									</div>
									<div class="admin-privacy-btn-row">
										<button
											type="button"
											class={`btn btn-xs ${privacyMode.value ? "btn-warn" : "btn-danger"}`}
											onClick={() => toggleAdminPrivacy(!privacyMode.value)}
											title="Pausa a transmissão pública e silencia o áudio dos espectadores (Atalho: Shift + P)"
										>
											<EyeOff size={12} />
											{privacyMode.value ? "Desativar Modo Privacidade (Shift + P)" : "Ativar Modo Privacidade (Shift + P)"}
										</button>
									</div>
									<p class="admin-privacy-hint">
										Dica: Você também pode usar o atalho <strong>Shift + P</strong> ou o comando <strong>/censura</strong> no chat.
									</p>
								</div>
								<div class="admin-chat-box">
									<div class="admin-chat-header-row">
										<span class="admin-chat-title">Chat da Sala</span>
										<span class={`admin-chat-status ${adminState.value?.chatEnabled ? "active" : "inactive"}`}>
											{adminState.value?.chatEnabled ? "Ativado" : "Desativado"}
										</span>
									</div>
									<div class="admin-chat-btn-row">
										<button
											type="button"
											class={`btn btn-xs ${adminState.value?.chatEnabled ? "btn-danger" : "btn-primary"}`}
											onClick={() => toggleAdminChat(!adminState.value?.chatEnabled)}
										>
											{adminState.value?.chatEnabled ? "Desativar Chat" : "Ativar Chat"}
										</button>
										<button
											type="button"
											class="btn btn-xs btn-outline"
											title="Limpar todo o histórico do chat da sala"
											onClick={clearAdminChat}
										>
											<Trash2 size={12} /> Limpar Histórico
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

			{chatOpen.value && (
				<aside class="play-chat-drawer" onClick={(event) => event.stopPropagation()}>
					<div class="chat-header">
						<div class="chat-header-title">
							<MessageSquare size={16} />
							<h3>Chat da Sala</h3>
							<span class={`chat-status-pill ${chatEnabled.value ? "online" : "offline"}`}>
								{chatEnabled.value ? "Ao Vivo" : "Desativado"}
							</span>
						</div>
						<div class="chat-header-actions">
							<button
								type="button"
								class="btn btn-icon btn-sm chat-clear-btn"
								title={adminAuthed.value ? "Limpar histórico do chat da sala (Admin)" : "Limpar mensagens da sua tela"}
								onClick={clearChat}
							>
								<Trash2 size={15} />
							</button>
							<button
								type="button"
								class="btn btn-icon btn-sm"
								aria-label="Fechar Chat"
								onClick={() => (chatOpen.value = false)}
							>
								<X size={16} />
							</button>
						</div>
					</div>

					<div class="chat-user-bar">
						{chatEditingNick.value ? (
							<form
								class="chat-nick-form"
								onSubmit={(e) => {
									e.preventDefault();
									if (chatNewNickInput.value.trim()) {
										updateNick(chatNewNickInput.value.trim());
									}
								}}
							>
								<input
									type="text"
									id="chat-new-nick"
									name="chat-new-nick"
									autoComplete="off"
									maxLength={24}
									value={chatNewNickInput.value}
									onInput={(e) => (chatNewNickInput.value = (e.target as HTMLInputElement).value)}
									placeholder="Novo apelido..."
									autoFocus
								/>
								<button type="submit" class="btn btn-xs btn-primary">Salvar</button>
								<button
									type="button"
									class="btn btn-xs"
									onClick={() => (chatEditingNick.value = false)}
								>
									Cancelar
								</button>
							</form>
						) : (
							<div class="chat-nick-display">
								<span class="chat-nick-label">Seu Apelido:</span>
								<span class="chat-current-nick">{chatNick.value || "Visitante"}</span>
								<button
									type="button"
									class="chat-nick-edit-btn"
									title="Alterar seu apelido"
									onClick={() => {
										chatNewNickInput.value = chatNick.value;
										chatEditingNick.value = true;
									}}
								>
									Alterar
								</button>
							</div>
						)}
					</div>

					<div class="chat-messages-container">
						{chatMessages.value.length === 0 ? (
							<div class="chat-empty">
								<p>Nenhuma mensagem ainda.</p>
								<span>Envie uma mensagem ou use <code>/nick &lt;nome&gt;</code> para mudar seu apelido!</span>
							</div>
						) : (
							chatMessages.value.map((m) => {
								const timeStr = new Date(m.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
								if (m.isSystem) {
									return (
										<div key={m.id} class="chat-msg chat-msg-system">
											<span class="chat-msg-time">{timeStr}</span>
											<span class="chat-msg-content">{m.text}</span>
										</div>
									);
								}
								const isMe = m.nick === chatNick.value;
								const hasSeat = typeof m.seat === "number" && m.seat >= 0 && m.seat < PAD_COUNT;
								return (
									<div key={m.id} class={`chat-msg ${isMe ? "chat-msg-me" : ""}`}>
										<div class="chat-msg-header">
											<span class="chat-msg-time">{timeStr}</span>
											{hasSeat && (
												<span class={`chat-player-badge player-${m.seat! + 1}`}>
													P{m.seat! + 1}
												</span>
											)}
											{m.isAdmin && (
												<span class="chat-admin-badge">ADMIN</span>
											)}
											<span class="chat-msg-nick">{m.nick}</span>
										</div>
										<p class="chat-msg-text">{m.text}</p>
									</div>
								);
							})
						)}
						<div ref={chatMessagesEndRef} />
					</div>

					<form
						class="chat-input-bar"
						onSubmit={(e) => {
							e.preventDefault();
							sendChatMessage(chatInput.value);
						}}
					>
						<input
							type="text"
							id="chat-message-input"
							name="chat-message-input"
							autoComplete="off"
							maxLength={250}
							disabled={!chatEnabled.value && !adminAuthed.value}
							placeholder={
								!chatEnabled.value && !adminAuthed.value
									? "Chat desativado pelo administrador"
									: "Digite uma mensagem (ou /nick novo)..."
							}
							value={chatInput.value}
							onInput={(e) => (chatInput.value = (e.target as HTMLInputElement).value)}
							onKeyDown={(e) => {
								e.stopPropagation();
							}}
						/>
						<button
							type="submit"
							class="btn btn-primary btn-icon chat-send-btn"
							disabled={(!chatEnabled.value && !adminAuthed.value) || !chatInput.value.trim()}
							aria-label="Enviar mensagem"
						>
							<Send size={15} />
						</button>
					</form>
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

			{activeChatToast.value && (!uiHidden.value || chatToastsOnHidden.value) && (
				<div
					class="play-chat-toast"
					role="alert"
					onMouseEnter={() => {
						if (chatToastTimer.current) clearTimeout(chatToastTimer.current);
					}}
					onMouseLeave={() => {
						chatToastTimer.current = window.setTimeout(() => {
							activeChatToast.value = null;
						}, 3500);
					}}
					onClick={() => {
						if (uiHidden.value) uiHidden.value = false;
						chatOpen.value = true;
						chatUnread.value = 0;
						activeChatToast.value = null;
					}}
				>
					<div class="chat-toast-header">
						<span class="chat-toast-tag">
							<MessageSquare size={13} aria-hidden="true" />
							Chat
						</span>
						{typeof activeChatToast.value.seat === "number" && activeChatToast.value.seat >= 0 && activeChatToast.value.seat < PAD_COUNT && (
							<span class={`chat-player-badge player-${activeChatToast.value.seat + 1}`}>
								P{activeChatToast.value.seat + 1}
							</span>
						)}
						{activeChatToast.value.isAdmin && (
							<span class="chat-admin-badge">ADMIN</span>
						)}
						<strong class="chat-toast-nick">{activeChatToast.value.nick}</strong>
						<span class="chat-toast-time">
							{new Date(activeChatToast.value.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
						</span>
						<button
							type="button"
							class="chat-toast-close"
							aria-label="Fechar notificação"
							onClick={(e) => {
								e.stopPropagation();
								activeChatToast.value = null;
							}}
						>
							<X size={13} />
						</button>
					</div>
					<div class="chat-toast-body">
						{activeChatToast.value.text}
					</div>
				</div>
			)}

			<ul class="play-toasts" aria-live="polite">
				{toasts.value.map((item: { id: number; text: string }) => <li key={item.id}>{item.text}</li>)}
			</ul>

			{/* Modo Camuflagem (Boss Key / Terminal de Diagnóstico Falso) */}
			{stealthMode.value && (
				<StealthTerminal onExit={() => (stealthMode.value = false)} />
			)}
		</section>
	);
}
