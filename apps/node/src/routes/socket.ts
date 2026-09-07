import { Router } from "@webtools/expressapi";
import { config } from "@/config.ts";
import { captureStatus } from "@/services/capture.ts";
import { clearPad, picoStatus, setPad, setWakeHold } from "@/services/pico.ts";
import {
	addViewer,
	dropViewer,
	forEachViewer,
	getSeatStates,
	kickAllSeats,
	kickSeat,
	padOf,
	playingCount,
	playPad,
	viewerCount,
	watchPad,
} from "@/services/sockets.ts";
import type { ClientMessage, ServerMessage } from "@s2pipe/shared/types/node";

const HEARTBEAT_INTERVAL = 30_000;
const adminSockets = new Set<WebSocket>();

let lastCapture = "";

function send(ws: WebSocket, message: ServerMessage): void {
	if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function pushAdminState(targetWs?: WebSocket): void {
	const message: ServerMessage = {
		op: "admin_state",
		data: {
			viewers: viewerCount(),
			seats: getSeatStates(),
		},
	};
	if (targetWs) {
		send(targetWs, message);
	} else {
		for (const ws of adminSockets) {
			if (ws.readyState === WebSocket.OPEN) send(ws, message);
		}
	}
}

async function currentStatus(): Promise<ServerMessage> {
	const capture = await captureStatus();
	lastCapture = `${capture.running}:${capture.error ?? ""}`;
	return {
		op: "status",
		data: {
			capture,
			pico: picoStatus(),
			playing: playingCount(),
			viewers: viewerCount(),
			pinRequired: Boolean(config.playerPin),
		},
	};
}

async function pushStatus(): Promise<void> {
	const message = await currentStatus();
	forEachViewer((ws) => send(ws, message));
	pushAdminState();
}

setInterval(() => {
	void captureStatus().then((status) => {
		const key = `${status.running}:${status.error ?? ""}`;
		if (key === lastCapture) return;
		void pushStatus();
	});
}, 2000);

function bind(ws: WebSocket): void {
	addViewer(ws);
	setWakeHold(viewerCount() > 0);
	void pushStatus();

	const heartbeat = setInterval(() => {
		send(ws, { op: "ping" });
	}, HEARTBEAT_INTERVAL);

	const greet = () => {
		void currentStatus().then((status) => send(ws, status));
	};
	if (ws.readyState === WebSocket.OPEN) greet();
	else ws.addEventListener("open", greet, { once: true });

	ws.addEventListener("message", (event) => {
		if (typeof event.data !== "string") return;
		try {
			const msg = JSON.parse(event.data) as ClientMessage;
			switch (msg.op) {
				case "play": {
					if (config.playerPin) {
						const providedPin = msg.pin ? msg.pin.trim() : "";
						if (providedPin !== config.playerPin) {
							send(ws, { op: "play", data: { playing: false, error: "invalid_pin" } });
							return;
						}
					}
					const existing = padOf(ws);
					const seat = playPad(ws);
					send(ws, {
						op: "play",
						data: {
							playing: seat !== undefined,
							error: seat === undefined ? "all_seats_full" : undefined,
						},
					});
					if (existing === undefined && seat !== undefined) {
						clearPad(seat);
						void pushStatus();
					}
					return;
				}
				case "watch": {
					const released = watchPad(ws);
					if (released === undefined) return;
					clearPad(released);
					void pushStatus();
					return;
				}
				case "pad": {
					const seat = padOf(ws);
					if (seat !== undefined) setPad(seat, msg.data);
					return;
				}
				case "admin_login": {
					const expected = config.adminPassword;
					const provided = msg.password ? msg.password.trim() : "";
					if (expected && provided === expected) {
						adminSockets.add(ws);
						send(ws, { op: "admin_auth", data: { ok: true } });
						pushAdminState(ws);
					} else {
						send(ws, { op: "admin_auth", data: { ok: false } });
					}
					return;
				}
				case "admin_kick": {
					if (!adminSockets.has(ws)) return;
					const kickedWs = kickSeat(msg.seat);
					if (kickedWs) {
						clearPad(msg.seat);
						send(kickedWs, { op: "play", data: { playing: false, error: "kicked_by_admin" } });
						void pushStatus();
					}
					return;
				}
				case "admin_kick_all": {
					if (!adminSockets.has(ws)) return;
					const kickedList = kickAllSeats();
					for (const item of kickedList) {
						clearPad(item.seat);
						send(item.ws, { op: "play", data: { playing: false, error: "kicked_by_admin" } });
					}
					if (kickedList.length > 0) {
						void pushStatus();
					}
					return;
				}
			}
		} catch {
			// ignore bad frames
		}
	});

	ws.addEventListener("close", () => {
		clearInterval(heartbeat);
		adminSockets.delete(ws);
		const released = dropViewer(ws);
		setWakeHold(viewerCount() > 0);
		if (released === undefined) {
			void pushStatus();
			return;
		}
		clearPad(released);
		void pushStatus();
	});
}

export default new Router()
	.get("/socket", (req, res) => {
		if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return res.status(426).json({
				success: false as const,
				error: "upgrade_required",
			});
		}

		const { socket, response } = Deno.upgradeWebSocket(req.raw);
		bind(socket);

		return response;
	});
