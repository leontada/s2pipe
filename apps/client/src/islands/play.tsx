import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { Activity, Eye, Gamepad2, Lock, Maximize, Minimize, Pause, Play as PlayIcon, Settings, Shield, UserX, Volume2, VolumeX, X, Zap } from "lucide-preact";

import type { AdminState, CaptureStatus, ClientMessage, PicoStatus, ServerMessage } from "@s2pipe/shared/types/node";
import { PAD_COUNT, type PadState, samePad } from "@s2pipe/shared/types/pad";

import {
	createInputTracker,
	type GamepadOption,
	type InputSource,
	KEYBOARD_HELP,
	listGamepads,
} from "../utils/input.ts";
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

type Props = {
	nodeUrl: string;
	nodeLocked: boolean;
};

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

function firstPad(list: GamepadOption[]): InputSource | null {
	return list[0] ? { kind: "gamepad", index: list[0].index } : null;
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

export default function Play({ nodeUrl, nodeLocked }: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const stageRef = useRef<HTMLElement>(null);
	const whepRef = useRef<WhepHandle | null>(null);
	const audioRef = useRef<AudioWhepHandle | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const inputRef = useRef<ReturnType<typeof createInputTracker> | null>(null);
	const statsPrev = useRef<{ bytes: number; at: number } | null>(null);
	const toastSeq = useRef(0);
	const playRequested = useRef(false);
	const persistPrefs = useRef(false);

	const playing = useSignal(false);
	const playingCount = useSignal(0);
	const connected = useSignal(false);
	const capture = useSignal<CaptureStatus | null>(null);
	const pico = useSignal<PicoStatus | null>(null);
	const pads = useSignal<GamepadOption[]>([]);
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
		});
	}, [muted.value, volume.value, fill.value, showStats.value]);

	function toast(text: string): void {
		const id = ++toastSeq.current;
		toasts.value = [...toasts.value, { id, text }];
		setTimeout(() => {
			toasts.value = toasts.value.filter((item) => item.id !== id);
		}, 4200);
	}

	// Gestion de la connexion WHeP (Vidéo + Audio)
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		let cancelled = false;
		let videoHandle: WhepHandle | null = null;
		let audioHandle: AudioWhepHandle | null = null;
		let retryTimer = 0;
		let iceHinted = false;

		const cleanupWhep = () => {
			void videoHandle?.close();
			void audioHandle?.close();
			videoHandle = null;
			audioHandle = null;
			whepRef.current = null;
			audioRef.current = null;
		};

		const connect = async () => {
			try {
				videoHandle = await startWhep(nodeUrl, video);
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
	}, [nodeUrl]);

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
		let socket: WebSocket | null = null;
		let retryTimer = 0;
		let isClosed = false;

		function connectWs() {
			if (isClosed) return;
			socket = new WebSocket(wsUrl(nodeUrl));
			wsRef.current = socket;

			socket.addEventListener("open", () => {
				connected.value = true;
				try {
					const savedAdmin = sessionStorage.getItem("s2pipe_admin_pass");
					if (savedAdmin) {
						send(socket, { op: "admin_login", password: savedAdmin });
					}
				} catch {}
			});

			socket.addEventListener("message", (event) => {
				if (typeof event.data !== "string") return;
				try {
					const msg = JSON.parse(event.data) as ServerMessage;
					if (msg.op === "play") {
						if (msg.data.playing) {
							playing.value = true;
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
							playing.value = false;
							inputMuted.value = false;
							if (msg.data.error === "invalid_pin") {
								pinModalOpen.value = true;
								pinError.value = "Incorrect PIN. Please try again.";
								try {
									localStorage.removeItem("s2pipe_player_pin");
								} catch {}
							} else if (msg.data.error === "kicked_by_admin") {
								toast("You were moved to the audience by an admin.");
							} else if (msg.data.error === "all_seats_full") {
								toast("All remote pads are currently occupied.");
							} else {
								toast("Unable to take a pad.");
							}
						}
					} else if (msg.op === "status") {
						capture.value = msg.data.capture;
						if (!msg.data.capture.running) live.value = false;
						pico.value = msg.data.pico;
						playingCount.value = msg.data.playing;
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
							toast("⚡ Wake beacon sent to Nintendo Switch 2!");
						} else {
							toast("⚠️ Wake disabled or Pico disconnected.");
						}
					} else if (msg.op === "ping") {
						send(socket, { op: "pong" });
					}
				} catch {
					// Ignorer les messages invalides
				}
			});

			socket.addEventListener("close", () => {
				wsRef.current = null;
				playRequested.current = false;
				playing.value = false;
				inputMuted.value = false;
				connected.value = false;
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
			socket?.close();
			wsRef.current = null;
		};
	}, [nodeUrl]);

	// Gestion des manettes (Gamepads)
	useEffect(() => {
		const tracker = createInputTracker();
		inputRef.current = tracker;
		tracker.attach();

		const updatePads = () => {
			const next = listGamepads();
			pads.value = next;
			const current = source.value;
			if (!current || !next.some((pad) => pad.index === current.index)) {
				source.value = firstPad(next);
			}
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
		if (!playing.value) return;
		let frame = 0;
		let lastState: PadState | null = null;

		const loop = () => {
			frame = requestAnimationFrame(loop);
			const tracker = inputRef.current;
			const ws = wsRef.current;
			const pad = source.value;

			if (!tracker || !pad || !ws || ws.readyState !== WebSocket.OPEN) return;

			const state = tracker.sample(pad);
			if (lastState !== null && samePad(lastState, state)) return;

			lastState = state;
			send(ws, { op: "pad", data: state });
		};

		frame = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(frame);
	}, [playing.value]);

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

	function requestPlay(pin?: string): void {
		if (playing.value || wsRef.current?.readyState !== WebSocket.OPEN) return;
		playRequested.current = true;
		lastAttemptedPin.value = pin ?? "";
		send(wsRef.current, { op: "play", pin });
	}

	function play(): void {
		if (playing.value || wsRef.current?.readyState !== WebSocket.OPEN) return;
		if (pinRequired.value) {
			let savedPin = "";
			try {
				savedPin = localStorage.getItem("s2pipe_player_pin") ?? "";
			} catch {}
			if (savedPin) {
				requestPlay(savedPin);
				return;
			}
			pinInput.value = "";
			pinError.value = "";
			pinModalOpen.value = true;
			return;
		}
		requestPlay();
	}

	function submitPin(event?: Event): void {
		event?.preventDefault();
		const pin = pinInput.value.trim();
		if (!pin) {
			pinError.value = "Please enter the PIN.";
			return;
		}
		requestPlay(pin);
	}

	function cancelPin(): void {
		pinModalOpen.value = false;
		pinError.value = "";
		playRequested.current = false;
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
		playRequested.current = false;
		playing.value = false;
		inputMuted.value = false;
		send(wsRef.current, { op: "watch" });
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
	const padsFull = playingCount.value >= PAD_COUNT && !playing.value;
	const banner = streamBanner(connected.value, capture.value, live.value);

	return (
		<section
			id="play"
			ref={stageRef}
			data-fill={fill.value ? "true" : undefined}
			data-idle={hideHud ? "true" : undefined}
			onClick={onStageClick}
			onDblClick={(event) => {
				event.preventDefault();
				toggleFullscreen();
			}}
		>
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
						<span>s2</span>pipe
					</span>
					<div class="play-slots">
						<span class="play-count">
							{playingCount.value}/{PAD_COUNT} playing
							{viewersCount.value > 0 && (
								<span class="play-viewers-tag" title={`${viewersCount.value} connected viewer${viewersCount.value > 1 ? "s" : ""}`}>
									· {viewersCount.value} viewer{viewersCount.value > 1 ? "s" : ""}
								</span>
							)}
						</span>
						<button
							type="button"
							class="play-slot"
							data-state={playing.value ? "you" : "free"}
							disabled={padsFull}
							onClick={play}
						>
							{pinRequired.value && !playing.value ? <Lock size={14} aria-hidden="true" /> : <Gamepad2 size={14} aria-hidden="true" />}
							Play
						</button>
						<button
							type="button"
							class="play-slot"
							data-state={!playing.value ? "you" : "free"}
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
					<label class="play-controller">
						<select
							aria-label="Controller"
							value={source.value ? String(source.value.index) : ""}
							onChange={(e) => {
								const val = Number((e.target as HTMLSelectElement).value);
								if (Number.isFinite(val)) source.value = { kind: "gamepad", index: val };
							}}
						>
							{pads.value.length === 0 && <option value="" disabled>Connect a gamepad</option>}
							{pads.value.map((pad) => <option value={String(pad.index)}>{pad.id}</option>)}
						</select>
						{connected.value && !playing.value && (
							<span class="play-hint">Click Play, then use a gamepad.</span>
						)}
						{connected.value && playing.value && inputMuted.value && (
							<span class="play-hint play-hint-warn">⚠️ Gamepad inputs paused by admin</span>
						)}
					</label>
					<div class="play-tools">
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

					<label class="field">
						<span>Volume</span>
						<input
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

					<label class="play-check">
						<input
							type="checkbox"
							checked={fill.value}
							onChange={(event) => fill.value = (event.target as HTMLInputElement).checked}
						/>
						Fill (crop) instead of letterbox
					</label>

					<label class="play-check">
						<input
							type="checkbox"
							checked={showStats.value}
							onChange={(event) => showStats.value = (event.target as HTMLInputElement).checked}
						/>
						Overlay WebRTC stats
					</label>

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
										type="password"
										class="admin-input"
										placeholder="Admin password..."
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
											title="Send BLE wake-up beacon to Nintendo Switch 2"
										>
											<Zap size={12} /> Wake Console
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
									{(adminState.value?.seats ?? [0, 1, 2, 3].map((i) => ({ seat: i, occupied: false, muted: false }))).map((s) => (
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
								type="password"
								class="play-modal-input"
								placeholder="Enter PIN..."
								autoFocus
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
