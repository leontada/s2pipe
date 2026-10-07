import type { ChatMessage } from "@s2pipe/shared/types/node";

const NICK_PREFIXES = [
	"Mario",
	"Luigi",
	"Peach",
	"Bowser",
	"Yoshi",
	"Toad",
	"Wario",
	"Waluigi",
	"DonkeyKong",
	"DiddyKong",
	"Link",
	"Zelda",
	"Kirby",
	"Dedede",
	"MetaKnight",
	"Fox",
	"Falco",
	"Pikachu",
	"Charizard",
	"Samus",
	"Ridley",
	"Ganon",
	"Koopa",
	"Boo",
	"ShyGuy",
	"DryBones",
	"Sonic",
	"Tails",
	"Knuckles",
	"MegaMan",
];

const NICK_ADJECTIVES = [
	"Radical",
	"Veloz",
	"Furioso",
	"Maroto",
	"Festeiro",
	"Pixelado",
	"Galactico",
	"Cosplay",
	"Dorminhoco",
	"Turbo",
	"Saltitante",
	"Ninja",
	"Cansado",
	"Brilhante",
	"Caotico",
	"Gamer",
	"Retro",
	"Estelar",
	"Arcade",
	"Pipoca",
	"Heroico",
];

const MAX_HISTORY = 100;
const MAX_MESSAGE_LEN = 250;

// Rate limiting: Janela deslizante + proteção contra duplicatas
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_MESSAGES = 4;
const MIN_SEND_INTERVAL_MS = 250;
const DUPLICATE_COOLDOWN_MS = 7000;

interface RateLimitState {
	timestamps: number[];
	lastText: string;
	lastTextTime: number;
}

let chatEnabled = true;
const socketNicks = new Map<WebSocket, string>();
const rateLimitMap = new Map<WebSocket, RateLimitState>();
const mutedSockets = new Map<WebSocket, number>(); // ws -> unmutedAt timestamp
const messageHistory: ChatMessage[] = [];

const RESERVED_NICKS = new Set([
	"sistema",
	"system",
	"admin",
	"administrador",
	"server",
	"servidor",
	"mod",
	"moderador",
]);

export function isChatEnabled(): boolean {
	return chatEnabled;
}

export function setChatEnabled(enabled: boolean): void {
	chatEnabled = enabled;
}

export function generateRandomNick(): string {
	const prefix = NICK_PREFIXES[Math.floor(Math.random() * NICK_PREFIXES.length)];
	const adj = NICK_ADJECTIVES[Math.floor(Math.random() * NICK_ADJECTIVES.length)];
	const num = Math.floor(10 + Math.random() * 90);
	return `${prefix}${adj}${num}`;
}

export function cleanNick(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed.length < 2 || trimmed.length > 24) return null;
	// Permite alfanuméricos, acentos, espaços, underscores, hífens
	const sanitized = trimmed.replace(/[^\w\s\u00C0-\u017F-]/gi, "").trim();
	if (sanitized.length < 2 || sanitized.length > 24) return null;
	return sanitized;
}

export function getSocketNick(ws: WebSocket): string {
	let nick = socketNicks.get(ws);
	if (!nick) {
		nick = generateRandomNick();
		socketNicks.set(ws, nick);
	}
	return nick;
}

export function setSocketNick(
	ws: WebSocket,
	newNick: string,
): { ok: true; nick: string } | { ok: false; error: string } {
	const valid = cleanNick(newNick);
	if (!valid) {
		return { ok: false, error: "Nome inválido (use de 2 a 24 caracteres)." };
	}
	const lower = valid.toLowerCase();
	if (RESERVED_NICKS.has(lower)) {
		return { ok: false, error: "Este apelido é reservado pelo sistema." };
	}

	// Previne personificação e squatting de apelidos
	for (const [otherWs, otherNick] of socketNicks) {
		if (otherWs !== ws && otherNick.toLowerCase() === lower) {
			if (otherWs.readyState !== WebSocket.OPEN) {
				socketNicks.delete(otherWs);
				rateLimitMap.delete(otherWs);
				mutedSockets.delete(otherWs);
				continue;
			}
			return { ok: false, error: "Este apelido já está em uso na sala." };
		}
	}

	socketNicks.set(ws, valid);
	return { ok: true, nick: valid };
}

export function muteSocket(ws: WebSocket, durationMinutes = 5): void {
	const unmutedAt = Date.now() + Math.max(1, durationMinutes) * 60 * 1000;
	mutedSockets.set(ws, unmutedAt);
}

export function unmuteSocket(ws: WebSocket): boolean {
	return mutedSockets.delete(ws);
}

export function isSocketMuted(ws: WebSocket): { muted: boolean; remainingSec?: number } {
	const unmutedAt = mutedSockets.get(ws);
	if (!unmutedAt) return { muted: false };
	const remaining = Math.ceil((unmutedAt - Date.now()) / 1000);
	if (remaining <= 0) {
		mutedSockets.delete(ws);
		return { muted: false };
	}
	return { muted: true, remainingSec: remaining };
}

export function findSocketByNick(nick: string): WebSocket | undefined {
	const lower = nick.trim().toLowerCase();
	for (const [ws, name] of socketNicks) {
		if (name.toLowerCase() === lower && ws.readyState === WebSocket.OPEN) {
			return ws;
		}
	}
	return undefined;
}

export function removeSocket(ws: WebSocket): void {
	socketNicks.delete(ws);
	rateLimitMap.delete(ws);
	mutedSockets.delete(ws);
}

export function getChatHistory(): ChatMessage[] {
	return [...messageHistory];
}

export function clearChatHistory(): void {
	messageHistory.length = 0;
}

export function canSend(
	ws: WebSocket,
	text: string,
	isAdmin = false,
): { ok: true } | { ok: false; reason: string } {
	if (!chatEnabled && !isAdmin) {
		return { ok: false, reason: "O chat está desativado pelo administrador." };
	}

	const muteCheck = isSocketMuted(ws);
	if (muteCheck.muted && !isAdmin) {
		return {
			ok: false,
			reason: `Você está silenciado temporariamente (${muteCheck.remainingSec}s restantes).`,
		};
	}

	if (isAdmin) return { ok: true };

	const now = Date.now();
	let state = rateLimitMap.get(ws);
	if (!state) {
		state = { timestamps: [], lastText: "", lastTextTime: 0 };
		rateLimitMap.set(ws, state);
	}

	// Limpa timestamps fora da janela de análise
	state.timestamps = state.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

	// Checagem de intervalo mínimo
	const lastSend = state.timestamps[state.timestamps.length - 1] || 0;
	if (now - lastSend < MIN_SEND_INTERVAL_MS) {
		return { ok: false, reason: "Você está digitando rápido demais. Aguarde um instante." };
	}

	// Checagem de mensagens máximas dentro da janela deslizante
	if (state.timestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
		const oldest = state.timestamps[0];
		const waitSec = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000));
		return { ok: false, reason: `Limite de mensagens excedido. Aguarde ${waitSec}s.` };
	}

	// Checagem de texto duplicado (anti-spam idêntico)
	const clean = text.trim().toLowerCase();
	if (clean.length > 0 && clean === state.lastText && now - state.lastTextTime < DUPLICATE_COOLDOWN_MS) {
		return { ok: false, reason: "Mensagem repetida. Aguarde alguns segundos antes de reenviar." };
	}

	// Atualiza estado de rate limit
	state.timestamps.push(now);
	state.lastText = clean;
	state.lastTextTime = now;

	return { ok: true };
}

export function pushMessage(msg: ChatMessage): void {
	messageHistory.push(msg);
	if (messageHistory.length > MAX_HISTORY) {
		messageHistory.shift();
	}
}

export function createMessage(params: {
	text: string;
	nick: string;
	seat?: number;
	isAdmin?: boolean;
	isSystem?: boolean;
}): ChatMessage | null {
	const raw = params.text.trim();
	if (!raw) return null;
	const text = raw.slice(0, MAX_MESSAGE_LEN);
	const msg: ChatMessage = {
		id: crypto.randomUUID(),
		nick: params.nick,
		text,
		time: Date.now(),
		seat: params.seat,
		isAdmin: params.isAdmin,
		isSystem: params.isSystem,
	};
	pushMessage(msg);
	return msg;
}
