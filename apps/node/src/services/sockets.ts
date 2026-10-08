import { PAD_COUNT } from "@s2pipe/shared/types/pad";

const seats: (WebSocket | null)[] = Array.from({ length: PAD_COUNT }, () => null);
const viewers = new Set<WebSocket>();

const mutedSeats: boolean[] = Array.from({ length: PAD_COUNT }, () => false);
let allMuted = false;

export function occupiedSeats(): number[] {
	const out: number[] = [];
	for (let i = 0; i < seats.length; i++) {
		if (seats[i] !== null) out.push(i);
	}
	return out;
}

export function playingCount(): number {
	return occupiedSeats().length;
}

export function viewerCount(): number {
	return viewers.size;
}

export function addViewer(ws: WebSocket): void {
	viewers.add(ws);
}

export function padsOf(ws: WebSocket): number[] {
	const out: number[] = [];
	for (let i = 0; i < seats.length; i++) {
		if (seats[i] === ws) out.push(i);
	}
	return out;
}

export function padOf(ws: WebSocket): number | undefined {
	const i = seats.indexOf(ws);
	return i < 0 ? undefined : i;
}

export function ownsSeat(ws: WebSocket, seat: number): boolean {
	return Number.isInteger(seat) && seat >= 0 && seat < seats.length && seats[seat] === ws;
}

export function playPads(ws: WebSocket, count: number): number[] {
	const want = Math.max(0, Math.min(PAD_COUNT, Math.floor(count)));
	const have = padsOf(ws);

	while (have.length > want) {
		const released = have.pop()!;
		seats[released] = null;
		mutedSeats[released] = false;
	}

	for (let i = 0; i < PAD_COUNT && have.length < want; i++) {
		if (seats[i] === null) {
			seats[i] = ws;
			mutedSeats[i] = false;
			have.push(i);
		}
	}

	return have;
}

export function watchPads(ws: WebSocket): number[] {
	const released = padsOf(ws);
	for (const i of released) {
		seats[i] = null;
		mutedSeats[i] = false;
	}
	return released;
}

export function dropViewer(ws: WebSocket): number[] {
	viewers.delete(ws);
	return watchPads(ws);
}

export function forEachViewer(fn: (ws: WebSocket) => void): void {
	for (const viewer of viewers) {
		if (viewer.readyState === WebSocket.OPEN) fn(viewer);
	}
}

export function kickSeat(seatIndex: number): WebSocket | null {
	if (seatIndex < 0 || seatIndex >= seats.length) return null;
	const ws = seats[seatIndex];
	if (ws) {
		seats[seatIndex] = null;
		mutedSeats[seatIndex] = false;
		return ws;
	}
	return null;
}

export function kickAllSeats(): { seat: number; ws: WebSocket }[] {
	const kicked: { seat: number; ws: WebSocket }[] = [];
	for (let i = 0; i < seats.length; i++) {
		const ws = seats[i];
		if (ws) {
			kicked.push({ seat: i, ws });
			seats[i] = null;
			mutedSeats[i] = false;
		}
	}
	return kicked;
}

export function isSeatMuted(seatIndex: number): boolean {
	return allMuted || Boolean(mutedSeats[seatIndex]);
}

export function isAllMuted(): boolean {
	return allMuted;
}

export function setSeatMuted(seatIndex: number, muted: boolean): WebSocket | null {
	if (seatIndex < 0 || seatIndex >= PAD_COUNT) return null;
	mutedSeats[seatIndex] = muted;
	return seats[seatIndex];
}

export function setAllMuted(muted: boolean): { seat: number; ws: WebSocket }[] {
	allMuted = muted;
	const active: { seat: number; ws: WebSocket }[] = [];
	for (let i = 0; i < seats.length; i++) {
		const ws = seats[i];
		if (ws) active.push({ seat: i, ws });
	}
	return active;
}

export function getSeatSocket(seatIndex: number): WebSocket | null {
	if (seatIndex < 0 || seatIndex >= PAD_COUNT) return null;
	return seats[seatIndex];
}

export function getSeatStates(): { seat: number; occupied: boolean; muted: boolean }[] {
	return seats.map((ws, i) => ({
		seat: i,
		occupied: ws !== null,
		muted: allMuted || mutedSeats[i],
	}));
}

const voiceTalking: boolean[] = Array.from({ length: PAD_COUNT }, () => false);
const voiceMuted: boolean[] = Array.from({ length: PAD_COUNT }, () => true);

export function setVoiceState(seat: number, talking: boolean, muted: boolean): void {
	if (seat >= 0 && seat < PAD_COUNT) {
		voiceTalking[seat] = talking;
		voiceMuted[seat] = muted;
	}
}

export function resetVoiceState(seat: number): void {
	if (seat >= 0 && seat < PAD_COUNT) {
		voiceTalking[seat] = false;
		voiceMuted[seat] = true;
	}
}

export function getVoiceRoster(): { seat: number; talking: boolean; muted: boolean }[] {
	const out: { seat: number; talking: boolean; muted: boolean }[] = [];
	for (let i = 0; i < seats.length; i++) {
		if (seats[i] !== null) {
			out.push({
				seat: i,
				talking: voiceTalking[i],
				muted: voiceMuted[i],
			});
		}
	}
	return out;
}


