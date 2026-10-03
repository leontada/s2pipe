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
	occupied: number[];
	playing: number;
	viewers?: number;
	pinRequired?: boolean;
	chatEnabled?: boolean;
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
	chatEnabled: boolean;
};

export type ChatMessage = {
	id: string;
	nick: string;
	text: string;
	time: number;
	seat?: number;
	isAdmin?: boolean;
	isSystem?: boolean;
};

export type ClientMessage =
	| { op: "play"; data?: { count?: number }; pin?: string }
	| { op: "watch" }
	| { op: "pad"; data: PadState; seat?: number }
	| { op: "pong" }
	| { op: "admin_login"; password: string }
	| { op: "admin_kick"; seat: number }
	| { op: "admin_kick_all" }
	| { op: "admin_mute_seat"; seat: number; muted: boolean }
	| { op: "admin_mute_all"; muted: boolean }
	| { op: "admin_wake" }
	| { op: "admin_home" }
	| { op: "admin_toggle_chat"; enabled: boolean }
	| { op: "admin_clear_chat" }
	| { op: "chat_send"; text: string }
	| { op: "chat_nick"; nick: string };

export type ServerMessage =
	| { op: "status"; data: StatusData }
	| { op: "play"; data: { playing: boolean; seats?: number[]; error?: string } }
	| { op: "ping" }
	| { op: "admin_auth"; data: { ok: boolean } }
	| { op: "admin_state"; data: AdminState }
	| { op: "input_status"; data: { muted: boolean; reason?: string } }
	| { op: "admin_wake_ack"; data: { success: boolean; reason?: string } }
	| { op: "admin_home_ack"; data: { success: boolean; reason?: string } }
	| { op: "chat_init"; data: { enabled: boolean; userNick: string; history: ChatMessage[] } }
	| { op: "chat_msg"; data: ChatMessage }
	| { op: "chat_nick_ack"; data: { nick: string; success: boolean; error?: string } }
	| { op: "chat_status"; data: { enabled: boolean } }
	| { op: "chat_cleared"; data: { history: ChatMessage[] } };
