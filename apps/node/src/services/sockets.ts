import { PAD_COUNT } from "@s2pipe/shared/types/pad";

const seats: (WebSocket | null)[] = Array.from({ length: PAD_COUNT }, () => null);
const viewers = new Set<WebSocket>();

const mutedSeats: boolean[] = Array.from({ length: PAD_COUNT }, () => false);
let allMuted = false;

export function playingCount(): number {
	let n = 0;
	for (const seat of seats) if (seat !== null) n++;
	return n;
}

export function viewerCount(): number {
	return viewers.size;
}

export function addViewer(ws: WebSocket): void {
	viewers.add(ws);
}

export function padOf(ws: WebSocket): number | undefined {
	const i = seats.indexOf(ws);
	return i < 0 ? undefined : i;
}

export function playPad(ws: WebSocket): number | undefined {
	const current = padOf(ws);
	if (current !== undefined) return current;
	const i = seats.indexOf(null);
	if (i < 0) return undefined;
	seats[i] = ws;
	mutedSeats[i] = false;
	return i;
}

export function watchPad(ws: WebSocket): number | undefined {
	const i = padOf(ws);
	if (i === undefined) return undefined;
	seats[i] = null;
	mutedSeats[i] = false;
	return i;
}

export function dropViewer(ws: WebSocket): number | undefined {
	viewers.delete(ws);
	return watchPad(ws);
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

