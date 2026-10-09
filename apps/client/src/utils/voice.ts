import { startAudioWhip, type WhipHandle } from "./whep.ts";
import type { ClientMessage, VoiceSeatState } from "@s2pipe/shared/types/node";

export type VoiceMode = "ptt" | "vad";

export type VoiceConfig = {
	mode: VoiceMode;
	pttKey: string;
	echoCancellation: boolean;
	noiseSuppression: boolean;
};

const DEFAULT_CONFIG: VoiceConfig = {
	mode: "ptt",
	pttKey: "KeyV",
	echoCancellation: true,
	noiseSuppression: true,
};

const ICE_SERVERS: RTCIceServer[] = [
	{ urls: "stun:stun.l.google.com:19302" },
	{ urls: "stun:stun1.l.google.com:19302" },
];

export class VoiceManager {
	private audioCtx: AudioContext | null = null;
	private micStream: MediaStream | null = null;
	private micSource: MediaStreamAudioSourceNode | null = null;
	private micGain: GainNode | null = null;
	private micAnalyser: AnalyserNode | null = null;
	private localDestination: MediaStreamAudioDestinationNode | null = null;
	private masterDestination: MediaStreamAudioDestinationNode | null = null;

	private peers = new Map<number, RTCPeerConnection>();
	private peerAudios = new Map<number, HTMLAudioElement>();
	private peerSources = new Map<number, MediaStreamAudioSourceNode>();

	private whipHandle: WhipHandle | null = null;
	private isBroadcasting = false;
	private micInitPromise: Promise<boolean> | null = null;

	private mySeat: number | null = null;
	private occupiedSeats: number[] = [];
	private nodeUrl = "";

	private sendWs: ((msg: ClientMessage) => void) | null = null;

	private config: VoiceConfig = { ...DEFAULT_CONFIG };
	private isPttActive = false;
	private isToggleMuted = true;
	private currentTalking = false;

	private vadInterval: number | null = null;
	private listeners = new Set<() => void>();

	public roster = new Map<number, VoiceSeatState>();

	constructor() {
		this.loadConfig();
	}

	private loadConfig(): void {
		try {
			const saved = localStorage.getItem("s2pipe_voice_config");
			if (saved) {
				this.config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
			}
		} catch {}
	}

	public saveConfig(config: Partial<VoiceConfig>): void {
		this.config = { ...this.config, ...config };
		try {
			localStorage.setItem("s2pipe_voice_config", JSON.stringify(this.config));
		} catch {}
		this.updateGain();
		this.notify();
	}

	public getConfig(): VoiceConfig {
		return { ...this.config };
	}

	public subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const l of this.listeners) l();
	}

	public get activeMode(): VoiceMode {
		return this.config.mode;
	}

	public get isMuted(): boolean {
		if (this.config.mode === "ptt") {
			return !this.isPttActive;
		}
		return this.isToggleMuted;
	}

	public get isTalking(): boolean {
		return this.currentTalking;
	}

	public get broadcasting(): boolean {
		return this.isBroadcasting;
	}

	public get hasMicPermission(): boolean {
		return this.micStream !== null;
	}

	public setPttPressed(pressed: boolean): void {
		if (this.config.mode !== "ptt") return;
		if (this.isPttActive === pressed) return;
		if (this.audioCtx && this.audioCtx.state === "suspended") {
			void this.audioCtx.resume().catch(() => {});
		}
		this.isPttActive = pressed;
		this.updateGain();
		this.notify();
	}

	public toggleMute(): void {
		if (this.audioCtx && this.audioCtx.state === "suspended") {
			void this.audioCtx.resume().catch(() => {});
		}
		if (this.config.mode === "ptt") {
			this.isPttActive = !this.isPttActive;
		} else {
			this.isToggleMuted = !this.isToggleMuted;
		}
		this.updateGain();
		this.notify();
	}

	public setToggleMuted(muted: boolean): void {
		this.isToggleMuted = muted;
		this.updateGain();
		this.notify();
	}

	public setMode(mode: VoiceMode): void {
		this.saveConfig({ mode });
		if (mode === "ptt") {
			this.isPttActive = false;
		} else {
			this.isToggleMuted = false;
		}
		if (this.audioCtx && this.audioCtx.state === "suspended") {
			void this.audioCtx.resume().catch(() => {});
		}
		this.updateGain();
		this.notify();
	}

	public async initMicrophone(): Promise<boolean> {
		if (this.micStream) return true;
		if (this.micInitPromise) return this.micInitPromise;

		this.micInitPromise = (async () => {
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					audio: {
						echoCancellation: this.config.echoCancellation,
						noiseSuppression: this.config.noiseSuppression,
						autoGainControl: true,
					},
				});

				this.micStream = stream;
				const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
				const ctx = new AudioContextClass();
				this.audioCtx = ctx;

				this.micSource = ctx.createMediaStreamSource(stream);
				this.micGain = ctx.createGain();
				this.micAnalyser = ctx.createAnalyser();
				this.micAnalyser.fftSize = 256;

				this.localDestination = ctx.createMediaStreamDestination();
				this.masterDestination = ctx.createMediaStreamDestination();

				this.micSource.connect(this.micGain);
				this.micGain.connect(this.micAnalyser);
				this.micGain.connect(this.localDestination);
				this.micGain.connect(this.masterDestination);

				// CORREÇÃO CRUCIAL PARA CHROMIUM/BRAVE/EDGE:
				// Em navegadores Chromium, se um AudioContext não tiver NENHUM nó conectado ao `ctx.destination`,
				// o motor Blink suspende a renderização de quantums de áudio para nós `MediaStreamAudioDestinationNode`,
				// resultando em silêncio digital absoluto (-91 dB) transmitido no WebRTC!
				// Conectamos um GainNode com volume 0 ao destination para forçar o loop de renderização do Chromium
				// sem reproduzir o microfone no autofalante local do usuário.
				const dummyGain = ctx.createGain();
				dummyGain.gain.value = 0;
				this.micGain.connect(dummyGain);
				dummyGain.connect(ctx.destination);

				if (ctx.state === "suspended") {
					void ctx.resume().catch(() => {});
				}

				this.updateGain();
				this.startVad();
				this.reconnectPeers();
				this.checkBroadcasterRole();
				this.notify();
				return true;
			} catch (err) {
				console.warn("[Voice] Microphone access failed or denied:", err);
				return false;
			} finally {
				this.micInitPromise = null;
			}
		})();

		return this.micInitPromise;
	}

	private updateGain(): void {
		if (!this.micGain) return;
		const muted = this.isMuted;
		const target = muted ? 0.0 : 1.0;
		if (this.audioCtx && this.audioCtx.state === "running") {
			try {
				this.micGain.gain.cancelScheduledValues(this.audioCtx.currentTime);
				this.micGain.gain.setTargetAtTime(target, this.audioCtx.currentTime, 0.01);
			} catch {
				this.micGain.gain.value = target;
			}
		} else {
			this.micGain.gain.value = target;
			if (this.audioCtx && this.audioCtx.state === "suspended" && !muted) {
				void this.audioCtx.resume().catch(() => {});
			}
		}

		if (muted && this.currentTalking) {
			this.currentTalking = false;
			this.broadcastVoiceState();
		}
	}

	private startVad(): void {
		if (this.vadInterval) clearInterval(this.vadInterval);
		const dataArray = new Uint8Array(this.micAnalyser?.frequencyBinCount ?? 128);

		this.vadInterval = window.setInterval(() => {
			if (!this.micAnalyser || this.isMuted) {
				if (this.currentTalking) {
					this.currentTalking = false;
					this.broadcastVoiceState();
					this.notify();
				}
				return;
			}

			this.micAnalyser.getByteFrequencyData(dataArray);
			let sum = 0;
			for (let i = 0; i < dataArray.length; i++) {
				sum += dataArray[i];
			}
			const average = sum / dataArray.length;
			const talking = average > 18;

			if (talking !== this.currentTalking) {
				this.currentTalking = talking;
				this.broadcastVoiceState();
				this.notify();
			}
		}, 60);
	}

	private broadcastVoiceState(): void {
		if (this.mySeat === null || !this.sendWs) return;
		this.sendWs({
			op: "voice_state",
			talking: this.currentTalking,
			muted: this.isMuted,
		});
	}

	public syncSession(
		nodeUrl: string,
		sendWs: (msg: ClientMessage) => void,
		mySeats: number[],
		occupied: number[],
	): void {
		this.nodeUrl = nodeUrl;
		this.sendWs = sendWs;

		// CRUCIAL: Garante que os meus assentos estejam sempre no conjunto de assentos ocupados,
		// mesmo antes de o servidor WebSocket enviar o broadcast de "status" com o novo array occupied.
		const allOccupied = new Set<number>(occupied);
		for (const s of mySeats) allOccupied.add(s);
		this.occupiedSeats = Array.from(allOccupied).sort((a, b) => a - b);

		const prevSeat = this.mySeat;
		this.mySeat = mySeats.length > 0 ? mySeats[0] : null;

		if (this.mySeat !== null && !this.micStream) {
			void this.initMicrophone();
		}

		if (this.audioCtx && this.audioCtx.state === "suspended") {
			void this.audioCtx.resume().catch(() => {});
		}

		if (prevSeat !== this.mySeat) {
			this.reconnectPeers();
		} else {
			this.updateMeshTopology();
		}

		this.checkBroadcasterRole();
	}

	private reconnectPeers(): void {
		this.closeAllPeers();
		this.updateMeshTopology();
	}

	private closeAllPeers(): void {
		for (const [_seat, pc] of this.peers) {
			pc.close();
		}
		this.peers.clear();

		for (const [_seat, audio] of this.peerAudios) {
			audio.pause();
			audio.srcObject = null;
		}
		this.peerAudios.clear();
		this.peerSources.clear();
	}

	private updateMeshTopology(): void {
		if (this.mySeat === null || !this.localDestination) return;

		const targetSeats = this.occupiedSeats.filter((s) => s !== this.mySeat);

		for (const [seat, pc] of this.peers) {
			if (!targetSeats.includes(seat)) {
				pc.close();
				this.peers.delete(seat);
				const audio = this.peerAudios.get(seat);
				if (audio) {
					audio.pause();
					audio.srcObject = null;
					this.peerAudios.delete(seat);
				}
				this.peerSources.delete(seat);
			}
		}

		for (const otherSeat of targetSeats) {
			if (!this.peers.has(otherSeat)) {
				if (this.mySeat < otherSeat) {
					void this.initiatePeerConnection(otherSeat);
				}
			}
		}
	}

	private createPeer(targetSeat: number): RTCPeerConnection {
		const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
		this.peers.set(targetSeat, pc);

		if (this.localDestination) {
			for (const track of this.localDestination.stream.getAudioTracks()) {
				pc.addTrack(track, this.localDestination.stream);
			}
		}

		pc.onicecandidate = (event) => {
			if (event.candidate && this.sendWs) {
				this.sendWs({
					op: "voice_signal",
					toSeat: targetSeat,
					data: { type: "candidate", candidate: event.candidate },
				});
			}
		};

		pc.ontrack = (event) => {
			const stream = event.streams[0] || new MediaStream([event.track]);

			let audio = this.peerAudios.get(targetSeat);
			if (!audio) {
				audio = new Audio();
				audio.autoplay = true;
				this.peerAudios.set(targetSeat, audio);
			}
			audio.srcObject = stream;
			void audio.play().catch(() => {});

			if (this.audioCtx && this.masterDestination && !this.peerSources.has(targetSeat)) {
				try {
					const source = this.audioCtx.createMediaStreamSource(stream);
					source.connect(this.masterDestination);
					this.peerSources.set(targetSeat, source);
				} catch (err) {
					console.warn("[Voice] Error attaching peer to master mixer:", err);
				}
			}
		};

		return pc;
	}

	private async initiatePeerConnection(targetSeat: number): Promise<void> {
		const pc = this.createPeer(targetSeat);
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);

		if (this.sendWs) {
			this.sendWs({
				op: "voice_signal",
				toSeat: targetSeat,
				data: { type: "offer", sdp: offer.sdp },
			});
		}
	}

	public async handleSignal(fromSeat: number, data: any): Promise<void> {
		if (this.mySeat === null) return;

		let pc = this.peers.get(fromSeat);

		if (data?.type === "offer") {
			if (!pc) pc = this.createPeer(fromSeat);
			await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: data.sdp }));
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);

			if (this.sendWs) {
				this.sendWs({
					op: "voice_signal",
					toSeat: fromSeat,
					data: { type: "answer", sdp: answer.sdp },
				});
			}
		} else if (data?.type === "answer") {
			if (pc) {
				await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: data.sdp }));
			}
		} else if (data?.type === "candidate" && data.candidate) {
			if (pc) {
				await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
			}
		}
	}

	private checkBroadcasterRole(): void {
		const leaderSeat = this.occupiedSeats.length > 0 ? this.occupiedSeats[0] : null;
		const shouldBroadcast = this.mySeat !== null && this.mySeat === leaderSeat;

		if (shouldBroadcast && !this.isBroadcasting) {
			this.startBroadcast();
		} else if (!shouldBroadcast && this.isBroadcasting) {
			this.stopBroadcast();
		}
	}

	private async startBroadcast(): Promise<void> {
		if (!this.masterDestination || !this.nodeUrl) return;
		if (this.audioCtx && this.audioCtx.state === "suspended") {
			await this.audioCtx.resume().catch(() => {});
		}
		this.isBroadcasting = true;
		this.notify();

		try {
			this.whipHandle = await startAudioWhip(
				this.nodeUrl,
				this.masterDestination.stream,
				"/switch-voice/whip",
			);
			if (!this.whipHandle) {
				this.isBroadcasting = false;
				this.notify();
				// Se ainda devemos transmitir, agenda nova tentativa automática
				setTimeout(() => this.checkBroadcasterRole(), 2500);
				return;
			}
			this.whipHandle.pc.addEventListener("connectionstatechange", () => {
				const state = this.whipHandle?.pc.connectionState;
				if (state === "failed" || state === "closed") {
					this.stopBroadcast();
					this.checkBroadcasterRole();
				}
			});
		} catch (err) {
			console.warn("[Voice] WHIP broadcast failed:", err);
			this.isBroadcasting = false;
			this.notify();
			setTimeout(() => this.checkBroadcasterRole(), 2500);
		}
	}

	private stopBroadcast(): void {
		if (this.whipHandle) {
			void this.whipHandle.close();
			this.whipHandle = null;
		}
		this.isBroadcasting = false;
		this.notify();
	}

	public updateRoster(seats: VoiceSeatState[]): void {
		this.roster.clear();
		for (const s of seats) {
			this.roster.set(s.seat, s);
		}
		this.notify();
	}

	public updateSeatState(seat: number, talking: boolean, muted: boolean): void {
		this.roster.set(seat, { seat, talking, muted });
		this.notify();
	}

	public resumeAudios(): void {
		if (this.audioCtx && this.audioCtx.state === "suspended") {
			void this.audioCtx.resume().catch(() => {});
		}
		for (const audio of this.peerAudios.values()) {
			if (audio.paused) {
				void audio.play().catch(() => {});
			}
		}
	}

	public async getDiagnostics(): Promise<Record<string, unknown>> {
		let whipStats: Record<string, unknown> | null = null;
		if (this.whipHandle?.pc) {
			try {
				const stats = await this.whipHandle.pc.getStats();
				for (const report of stats.values()) {
					if (report.type === "outbound-rtp" && report.kind === "audio") {
						whipStats = {
							bytesSent: report.bytesSent,
							packetsSent: report.packetsSent,
						};
					}
				}
			} catch {}
		}

		let currentLevelPercent = 0;
		if (this.micAnalyser) {
			const buf = new Uint8Array(this.micAnalyser.frequencyBinCount);
			this.micAnalyser.getByteFrequencyData(buf);
			let sum = 0;
			for (let i = 0; i < buf.length; i++) sum += buf[i];
			const avg = sum / buf.length;
			currentLevelPercent = Math.round((avg / 255) * 100);
		}

		return {
			role: this.mySeat !== null ? `Player (Seat ${this.mySeat + 1})` : "Spectator",
			broadcaster: this.isBroadcasting ? "Active (WHIP)" : "Inactive",
			mode: this.config.mode,
			isMuted: this.isMuted,
			isTalking: this.currentTalking,
			inputLevelPercent: `${currentLevelPercent}%`,
			audioContextState: this.audioCtx?.state ?? "none",
			audioContextTime: this.audioCtx ? `${this.audioCtx.currentTime.toFixed(1)}s` : "-",
			micStreamActive: this.micStream?.active ?? false,
			micTrackEnabled: this.micStream?.getAudioTracks()[0]?.enabled ?? false,
			micGainValue: this.micGain?.gain.value ?? "-",
			whipConnectionState: this.whipHandle?.pc.connectionState ?? "-",
			whipIceState: this.whipHandle?.pc.iceConnectionState ?? "-",
			whipStats: whipStats ?? "no stats yet",
			peerConnections: this.peers.size,
		};
	}

	public destroy(): void {
		if (this.vadInterval) clearInterval(this.vadInterval);
		this.stopBroadcast();
		this.closeAllPeers();

		if (this.micStream) {
			for (const t of this.micStream.getTracks()) t.stop();
			this.micStream = null;
		}
		if (this.audioCtx) {
			void this.audioCtx.close();
			this.audioCtx = null;
		}
		this.listeners.clear();
	}
}

export const voiceManager = new VoiceManager();

if (typeof globalThis !== "undefined") {
	// deno-lint-ignore no-explicit-any
	const g = globalThis as any;
	g.__voiceManager = voiceManager;
	g.__voiceDebug = async () => {
		const diag = await voiceManager.getDiagnostics();
		console.log("%c=== [Voice] DIAGNÓSTICO DO MICROFONE / WHIP ===", "color: #00ff88; font-weight: bold; font-size: 14px;");
		console.table(diag);
		return diag;
	};
}
