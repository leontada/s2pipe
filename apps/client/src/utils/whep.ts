export type WhepHandle = {
	pc: RTCPeerConnection;
	close: () => Promise<void>;
};

export type AudioWhepHandle = {
	pc: RTCPeerConnection;
	audio: HTMLAudioElement;
	close: () => Promise<void>;
};

const ice = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function preferLowJitter(receiver: RTCRtpReceiver): void {
	try {
		// Hint in ms. Chrome clamps; 50 would *add* delay. 0 is invalid (must be > 0).
		receiver.jitterBufferTarget = 1;
	} catch {
		const legacy = receiver as RTCRtpReceiver & { playoutDelayHint?: number };
		if ("playoutDelayHint" in legacy) legacy.playoutDelayHint = 0.001;
	}
}

function waitIceGathering(pc: RTCPeerConnection): Promise<void> {
	if (pc.iceGatheringState === "complete") return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			pc.removeEventListener("icegatheringstatechange", onChange);
			resolve();
		};
		const onChange = () => {
			if (pc.iceGatheringState === "complete") done();
		};
		const timer = setTimeout(done, 2000);
		pc.addEventListener("icegatheringstatechange", onChange);
	});
}

async function postWhep(
	nodeUrl: string,
	route: string,
	pc: RTCPeerConnection,
): Promise<string | null> {
	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	await waitIceGathering(pc);

	const response = await fetch(`${nodeUrl}${route}`, {
		method: "POST",
		headers: { "content-type": "application/sdp" },
		body: pc.localDescription?.sdp ?? offer.sdp,
	});

	if (!response.ok) {
		pc.close();
		return null;
	}

	const answer = await response.text();
	const location = response.headers.get("location");
	await pc.setRemoteDescription({ type: "answer", sdp: answer });
	return location;
}

function closeWhep(pc: RTCPeerConnection, nodeUrl: string, location: string | null): () => Promise<void> {
	return async () => {
		pc.close();
		if (!location) return;
		const resource = new URL(location, `${nodeUrl}/`).href;
		await fetch(resource, { method: "DELETE" }).catch(() => {});
	};
}

/** Fires once when the peer dies. `hadMedia` is true if it was connected before. */
export function onWhepDead(pc: RTCPeerConnection, fn: (hadMedia: boolean) => void): () => void {
	let hadMedia = false;
	let fired = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const fire = () => {
		if (fired) return;
		fired = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		fn(hadMedia);
	};

	const onState = () => {
		const state = pc.connectionState;
		if (state === "connected") {
			hadMedia = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			return;
		}
		if (state === "failed") fire();
		if (state !== "disconnected" || timer) return;
		timer = setTimeout(() => {
			timer = null;
			if (pc.connectionState === "disconnected" || pc.connectionState === "failed") fire();
		}, 1500);
	};

	pc.addEventListener("connectionstatechange", onState);
	return () => {
		fired = true;
		if (timer) clearTimeout(timer);
		pc.removeEventListener("connectionstatechange", onState);
	};
}

export async function startWhep(nodeUrl: string, video: HTMLVideoElement): Promise<WhepHandle> {
	const pc = new RTCPeerConnection(ice);
	pc.addTransceiver("video", { direction: "recvonly" });
	video.muted = true;

	pc.addEventListener("track", (event) => {
		if (event.track.kind !== "video") return;
		if (event.receiver) preferLowJitter(event.receiver);
		video.srcObject = new MediaStream([event.track]);
		void video.play().catch(() => {});
	});

	const location = await postWhep(nodeUrl, "/switch/whep", pc);
	if (!pc.remoteDescription) throw new Error("whep");

	const close = closeWhep(pc, nodeUrl, location);
	return {
		pc,
		close: async () => {
			video.srcObject = null;
			await close();
		},
	};
}

export async function startAudioWhep(
	nodeUrl: string,
	path = "/switch-audio/whep",
): Promise<AudioWhepHandle | null> {
	const pc = new RTCPeerConnection(ice);
	const audio = new Audio();
	audio.autoplay = true;
	audio.setAttribute("playsinline", "true");
	audio.style.display = "none";
	try {
		document.body.appendChild(audio);
	} catch {}

	pc.addTransceiver("audio", { direction: "recvonly" });
	pc.addEventListener("track", (event) => {
		if (event.track.kind !== "audio") return;
		if (event.receiver) preferLowJitter(event.receiver);
		audio.srcObject = new MediaStream([event.track]);
		void audio.play().catch(() => {});
	});

	const location = await postWhep(nodeUrl, path, pc);
	if (!pc.remoteDescription) {
		audio.pause();
		try { audio.remove(); } catch {}
		return null;
	}

	const close = closeWhep(pc, nodeUrl, location);
	return {
		pc,
		audio,
		close: async () => {
			audio.pause();
			audio.srcObject = null;
			try { audio.remove(); } catch {}
			await close();
		},
	};
}

export type WhipHandle = {
	pc: RTCPeerConnection;
	close: () => Promise<void>;
};

export async function startAudioWhip(
	nodeUrl: string,
	stream: MediaStream,
	path = "/switch-voice/whip",
): Promise<WhipHandle | null> {
	const pc = new RTCPeerConnection(ice);
	for (const track of stream.getAudioTracks()) {
		track.enabled = true;
		pc.addTrack(track, stream);
	}
	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	await waitIceGathering(pc);

	const url = `${nodeUrl}${path}`;
	let location: string | null = null;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/sdp" },
			body: pc.localDescription?.sdp ?? offer.sdp,
		});
		if (!res.ok) {
			pc.close();
			return null;
		}
		const answerSdp = await res.text();
		await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
		location = res.headers.get("location");
	} catch {
		pc.close();
		return null;
	}

	return {
		pc,
		close: async () => {
			pc.close();
			if (location) {
				const deleteUrl = location.startsWith("http") ? location : `${nodeUrl}${location}`;
				await fetch(deleteUrl, { method: "DELETE" }).catch(() => {});
			}
		},
	};
}


export type StreamStats = {
	bitrateKbps: number;
	fps: number;
	packetsLost: number;
	rttMs: number | null;
	jitterMs: number | null;
};

export async function readStreamStats(
	pc: RTCPeerConnection,
	prev: { bytes: number; at: number } | null,
): Promise<{ stats: StreamStats; prev: { bytes: number; at: number } }> {
	const report = await pc.getStats();
	let bytes = 0;
	let fps = 0;
	let packetsLost = 0;
	let rttMs: number | null = null;
	let jitterMs: number | null = null;
	let at = performance.now();

	for (const item of report.values()) {
		if (item.type === "inbound-rtp" && item.kind === "video") {
			bytes = item.bytesReceived ?? 0;
			fps = item.framesPerSecond ?? 0;
			packetsLost = item.packetsLost ?? 0;
			at = item.timestamp ?? at;
			if (typeof item.jitter === "number") {
				jitterMs = Math.round(item.jitter * 1000);
			}
		} else if (
			item.type === "candidate-pair" &&
			(item.state === "succeeded" || item.nominated || item.selected)
		) {
			const rtt = item.currentRoundTripTime ?? item.roundTripTime;
			if (typeof rtt === "number") {
				rttMs = Math.round(rtt * 1000);
			}
		} else if (item.type === "remote-inbound-rtp" && rttMs === null) {
			if (typeof item.roundTripTime === "number") {
				rttMs = Math.round(item.roundTripTime * 1000);
			}
		}
	}

	const elapsed = prev ? Math.max(1, at - prev.at) : 1000;
	const delta = prev ? Math.max(0, bytes - prev.bytes) : 0;
	const bitrateKbps = Math.round((delta * 8) / elapsed);

	return { stats: { bitrateKbps, fps, packetsLost, rttMs, jitterMs }, prev: { bytes, at } };
}
