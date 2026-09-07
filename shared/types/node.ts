import type { PadState } from "./pad.ts";

export type CaptureStatus = {
	running: boolean;
	source: string;
	error: string | null;
};

export type PicoStatus = {
	connected: boolean;
	path: string | null;
	error: string | null;
	wake: boolean;
};

export type StatusData = {
	capture: CaptureStatus;
	pico: PicoStatus;
	playing: number;
	viewers?: number;
	pinRequired?: boolean;
};

export type NodeStatus = {
	service: "s2pipe-node";
	uptimeSec: number;
} & StatusData;

export type SeatInfo = {
	seat: number;
	occupied: boolean;
	muted: boolean;
};

export type AdminState = {
	viewers: number;
	seats: SeatInfo[];
	allMuted: boolean;
};

export type ClientMessage =
	| { op: "play"; pin?: string }
	| { op: "watch" }
	| { op: "pad"; data: PadState }
	| { op: "pong" }
	| { op: "admin_login"; password: string }
	| { op: "admin_kick"; seat: number }
	| { op: "admin_kick_all" }
	| { op: "admin_mute_seat"; seat: number; muted: boolean }
	| { op: "admin_mute_all"; muted: boolean };

export type ServerMessage =
	| { op: "status"; data: StatusData }
	| { op: "play"; data: { playing: boolean; error?: string } }
	| { op: "ping" }
	| { op: "admin_auth"; data: { ok: boolean } }
	| { op: "admin_state"; data: AdminState }
	| { op: "input_status"; data: { muted: boolean; reason?: string } };

