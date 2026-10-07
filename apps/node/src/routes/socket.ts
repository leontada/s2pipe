import { Router } from "@webtools/expressapi";
import { config } from "@/config.ts";
import { captureStatus } from "@/services/capture.ts";
import { clearPad, picoStatus, setPad, triggerHome, triggerWake } from "@/services/pico.ts";
import {
	addViewer,
	dropViewer,
	forEachViewer,
	getSeatStates,
	isAllMuted,
	isSeatMuted,
	kickAllSeats,
	kickSeat,
	occupiedSeats,
	ownsSeat,
	padOf,
	padsOf,
	playingCount,
	playPads,
	setAllMuted,
	setSeatMuted,
	viewerCount,
	watchPads,
} from "@/services/sockets.ts";
import {
	canSend,
	clearChatHistory,
	createMessage,
	findSocketByNick,
	getChatHistory,
	getSocketNick,
	isChatEnabled,
	muteSocket,
	removeSocket,
	setChatEnabled,
	setSocketNick,
	unmuteSocket,
} from "@/services/chat.ts";
import { PAD_COUNT, PadButton } from "@s2pipe/shared/types/pad";
import type { ClientMessage, ServerMessage } from "@s2pipe/shared/types/node";

const HEARTBEAT_INTERVAL = 30_000;
const adminSockets = new Set<WebSocket>();

let lastCapture = "";
let privacyMode = false;

function send(ws: WebSocket, message: ServerMessage): void {
	if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function pushAdminState(targetWs?: WebSocket): void {
	const message: ServerMessage = {
		op: "admin_state",
		data: {
			viewers: viewerCount(),
			seats: getSeatStates(),
			allMuted: isAllMuted(),
			chatEnabled: isChatEnabled(),
			privacyMode,
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
			occupied: occupiedSeats(),
			playing: playingCount(),
			viewers: viewerCount(),
			pinRequired: Boolean(config.playerPin),
			chatEnabled: isChatEnabled(),
			privacyMode,
		},
	};
}

async function pushStatus(): Promise<void> {
	const message = await currentStatus();
	forEachViewer((ws) => send(ws, message));
	pushAdminState();
}

function resetSeats(indices: number[]): void {
	if (!indices.length) return;
	for (const seat of indices) clearPad(seat);
	void pushStatus();
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
	void pushStatus();

	const heartbeat = setInterval(() => {
		send(ws, { op: "ping" });
	}, HEARTBEAT_INTERVAL);

	const greet = () => {
		void currentStatus().then((status) => send(ws, status));
		const userNick = getSocketNick(ws);
		send(ws, {
			op: "chat_init",
			data: {
				enabled: isChatEnabled(),
				userNick,
				history: getChatHistory(),
			},
		});
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
							send(ws, { op: "play", data: { playing: false, seats: [], error: "invalid_pin" } });
							return;
						}
					}
					const previous = padsOf(ws);
					const raw = msg.data?.count;
					const count = typeof raw === "number" && Number.isFinite(raw) ? raw : 1;
					const assigned = playPads(ws, count);
					send(ws, {
						op: "play",
						data: {
							playing: assigned.length > 0,
							seats: assigned,
							error: assigned.length === 0 ? "all_seats_full" : undefined,
						},
					});
					if (assigned.length > 0) {
						triggerWake(false);
					}
					for (const seat of assigned) {
						if (!previous.includes(seat) && isSeatMuted(seat)) {
							send(ws, {
								op: "input_status",
								data: { muted: true, reason: "admin" },
							});
							break;
						}
					}
					resetSeats([
						...previous.filter((seat) => !assigned.includes(seat)),
						...assigned.filter((seat) => !previous.includes(seat)),
					]);
					return;
				}
				case "watch": {
					resetSeats(watchPads(ws));
					return;
				}
				case "pad": {
					const seat = typeof msg.seat === "number" ? msg.seat : padOf(ws);
					if (seat !== undefined && ownsSeat(ws, seat) && !isSeatMuted(seat) && !privacyMode) {
						setPad(seat, {
							...msg.data,
							buttons: msg.data.buttons & ~(PadButton.Home | PadButton.Capture),
						});
					}
					return;
				}
				case "chat_send": {
					const isAdmin = adminSockets.has(ws);
					const rawText = msg.text?.trim() || "";
					if (!rawText) return;

					const check = canSend(ws, rawText, isAdmin);
					if (!check.ok) {
						send(ws, {
							op: "chat_msg",
							data: {
								id: crypto.randomUUID(),
								nick: "Sistema",
								text: check.reason,
								time: Date.now(),
								isSystem: true,
							},
						});
						return;
					}

					// Admin command: /mute [apelido] [minutos]
					if (rawText.startsWith("/mute ")) {
						if (isAdmin) {
							const parts = rawText.slice(6).trim().split(/\s+/);
							const targetNick = parts[0] || "";
							const durationMins = parts[1] ? Number.parseInt(parts[1], 10) || 5 : 5;
							const targetWs = findSocketByNick(targetNick);
							if (targetWs) {
								muteSocket(targetWs, durationMins);
								send(targetWs, {
									op: "chat_msg",
									data: {
										id: crypto.randomUUID(),
										nick: "Sistema",
										text: `Você foi silenciado por um administrador por ${durationMins} minuto(s).`,
										time: Date.now(),
										isSystem: true,
									},
								});
								const notice = createMessage({
									text: `O usuário "${targetNick}" foi silenciado por ${durationMins} minuto(s).`,
									nick: "Sistema",
									isSystem: true,
								});
								if (notice) {
									forEachViewer((v) => send(v, { op: "chat_msg", data: notice }));
								}
							} else {
								send(ws, {
									op: "chat_msg",
									data: {
										id: crypto.randomUUID(),
										nick: "Sistema",
										text: `Usuário "${targetNick}" não encontrado online.`,
										time: Date.now(),
										isSystem: true,
									},
								});
							}
						} else {
							send(ws, {
								op: "chat_msg",
								data: {
									id: crypto.randomUUID(),
									nick: "Sistema",
									text: "Comando exclusivo para administradores.",
									time: Date.now(),
									isSystem: true,
								},
							});
						}
						return;
					}

					// Admin command: /unmute [apelido]
					if (rawText.startsWith("/unmute ")) {
						if (isAdmin) {
							const targetNick = rawText.slice(8).trim();
							const targetWs = findSocketByNick(targetNick);
							if (targetWs) {
								unmuteSocket(targetWs);
								send(targetWs, {
									op: "chat_msg",
									data: {
										id: crypto.randomUUID(),
										nick: "Sistema",
										text: "Seu silenciamento foi removido pelo administrador.",
										time: Date.now(),
										isSystem: true,
									},
								});
								const notice = createMessage({
									text: `O silenciamento de "${targetNick}" foi removido.`,
									nick: "Sistema",
									isSystem: true,
								});
								if (notice) {
									forEachViewer((v) => send(v, { op: "chat_msg", data: notice }));
								}
							} else {
								send(ws, {
									op: "chat_msg",
									data: {
										id: crypto.randomUUID(),
										nick: "Sistema",
										text: `Usuário "${targetNick}" não encontrado online.`,
										time: Date.now(),
										isSystem: true,
									},
								});
							}
						} else {
							send(ws, {
								op: "chat_msg",
								data: {
									id: crypto.randomUUID(),
									nick: "Sistema",
									text: "Comando exclusivo para administradores.",
									time: Date.now(),
									isSystem: true,
								},
							});
						}
						return;
					}

					if (rawText === "/censura" || rawText === "/privacidade" || rawText === "/privacy") {
						if (isAdmin) {
							privacyMode = !privacyMode;
							if (privacyMode) {
								for (let i = 0; i < PAD_COUNT; i++) {
									clearPad(i);
								}
							}
							forEachViewer((v) => {
								send(v, { op: "privacy_status", data: { enabled: privacyMode } });
							});
							pushAdminState();
							void pushStatus();
						} else {
							send(ws, {
								op: "chat_msg",
								data: {
									id: crypto.randomUUID(),
									nick: "Sistema",
									text: "Comando exclusivo para administradores.",
									time: Date.now(),
									isSystem: true,
								},
							});
						}
						return;
					}

					// Command /nick [novo_nome]
					if (rawText.startsWith("/nick ")) {
						const requestedNick = rawText.slice(6).trim();
						const oldNick = getSocketNick(ws);
						const result = setSocketNick(ws, requestedNick);
						if (result.ok) {
							send(ws, {
								op: "chat_nick_ack",
								data: { nick: result.nick, success: true },
							});
							if (oldNick !== result.nick) {
								const notice = createMessage({
									text: `"${oldNick}" agora é conhecido como "${result.nick}"`,
									nick: "Sistema",
									isSystem: true,
								});
								if (notice) {
									forEachViewer((v) => send(v, { op: "chat_msg", data: notice }));
								}
							}
						} else {
							send(ws, {
								op: "chat_nick_ack",
								data: { nick: oldNick, success: false, error: result.error },
							});
						}
						return;
					}

					if (rawText === "/clear" || rawText === "/limpar") {
						if (isAdmin) {
							clearChatHistory();
							const notice = createMessage({
								text: "O histórico do chat foi limpo pelo administrador.",
								nick: "Sistema",
								isSystem: true,
							});
							forEachViewer((v) => {
								send(v, {
									op: "chat_cleared",
									data: { history: notice ? [notice] : [] },
								});
							});
						} else {
							send(ws, {
								op: "chat_cleared",
								data: { history: [] },
							});
						}
						return;
					}

					const senderSeat = padOf(ws);
					const chatMsg = createMessage({
						text: rawText,
						nick: getSocketNick(ws),
						seat: senderSeat,
						isAdmin,
					});
					if (chatMsg) {
						forEachViewer((v) => send(v, { op: "chat_msg", data: chatMsg }));
					}
					return;
				}
				case "chat_nick": {
					const requestedNick = msg.nick?.trim() || "";
					const isSilent = Boolean(msg.silent);
					const oldNick = getSocketNick(ws);
					const result = setSocketNick(ws, requestedNick);
					if (result.ok) {
						send(ws, {
							op: "chat_nick_ack",
							data: { nick: result.nick, success: true },
						});
						if (!isSilent && oldNick !== result.nick) {
							const notice = createMessage({
								text: `"${oldNick}" agora é conhecido como "${result.nick}"`,
								nick: "Sistema",
								isSystem: true,
							});
							if (notice) {
								forEachViewer((v) => send(v, { op: "chat_msg", data: notice }));
							}
						}
					} else {
						send(ws, {
							op: "chat_nick_ack",
							data: { nick: oldNick, success: false, error: result.error },
						});
					}
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
						send(kickedWs, { op: "play", data: { playing: false, seats: padsOf(kickedWs), error: "kicked_by_admin" } });
						void pushStatus();
					}
					return;
				}
				case "admin_kick_all": {
					if (!adminSockets.has(ws)) return;
					const kickedList = kickAllSeats();
					for (const item of kickedList) {
						clearPad(item.seat);
						send(item.ws, { op: "play", data: { playing: false, seats: [], error: "kicked_by_admin" } });
					}
					if (kickedList.length > 0) {
						void pushStatus();
					}
					return;
				}
				case "admin_mute_seat": {
					if (!adminSockets.has(ws)) return;
					const playerWs = setSeatMuted(msg.seat, msg.muted);
					if (playerWs) {
						if (msg.muted) clearPad(msg.seat);
						send(playerWs, {
							op: "input_status",
							data: { muted: msg.muted, reason: "admin" },
						});
					}
					pushAdminState();
					return;
				}
				case "admin_wake": {
					if (!adminSockets.has(ws)) return;
					const success = triggerWake(true);
					send(ws, { op: "admin_wake_ack", data: { success } });
					return;
				}
				case "admin_home": {
					if (!adminSockets.has(ws)) return;
					const success = triggerHome();
					send(ws, { op: "admin_home_ack", data: { success } });
					return;
				}
				case "admin_mute_all": {
					if (!adminSockets.has(ws)) return;
					const activePlayers = setAllMuted(msg.muted);
					for (const item of activePlayers) {
						if (msg.muted) clearPad(item.seat);
						send(item.ws, {
							op: "input_status",
							data: { muted: msg.muted, reason: "admin" },
						});
					}
					pushAdminState();
					return;
				}
				case "admin_toggle_chat": {
					if (!adminSockets.has(ws)) return;
					setChatEnabled(msg.enabled);
					const statusNotice = createMessage({
						text: msg.enabled
							? "O chat foi reativado pelo administrador."
							: "O chat foi temporariamente desativado pelo administrador.",
						nick: "Sistema",
						isSystem: true,
					});
					forEachViewer((v) => {
						send(v, { op: "chat_status", data: { enabled: msg.enabled } });
						if (statusNotice) send(v, { op: "chat_msg", data: statusNotice });
					});
					pushAdminState();
					void pushStatus();
					return;
				}
				case "admin_clear_chat": {
					if (!adminSockets.has(ws)) return;
					clearChatHistory();
					const notice = createMessage({
						text: "O histórico do chat foi limpo pelo administrador.",
						nick: "Sistema",
						isSystem: true,
					});
					forEachViewer((v) => {
						send(v, {
							op: "chat_cleared",
							data: { history: notice ? [notice] : [] },
						});
					});
					return;
				}
				case "admin_toggle_privacy": {
					if (!adminSockets.has(ws)) return;
					privacyMode = Boolean(msg.enabled);
					if (privacyMode) {
						for (let i = 0; i < PAD_COUNT; i++) {
							clearPad(i);
						}
					}
					forEachViewer((v) => {
						send(v, { op: "privacy_status", data: { enabled: privacyMode } });
					});
					pushAdminState();
					void pushStatus();
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
		removeSocket(ws);
		const released = dropViewer(ws);
		resetSeats(released);
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
