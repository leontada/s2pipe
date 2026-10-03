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

const MAX_HISTORY = 50;
const RATE_LIMIT_MS = 300;
const MAX_MESSAGE_LEN = 250;

let chatEnabled = true;
const socketNicks = new Map<WebSocket, string>();
const lastSendMap = new Map<WebSocket, number>();
const messageHistory: ChatMessage[] = [];

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
	// Allow alphanumeric, accents, spaces, underscores, hyphens
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

export function setSocketNick(ws: WebSocket, newNick: string): string | null {
	const valid = cleanNick(newNick);
	if (!valid) return null;
	socketNicks.set(ws, valid);
	return valid;
}

export function removeSocket(ws: WebSocket): void {
	socketNicks.delete(ws);
	lastSendMap.delete(ws);
}

export function getChatHistory(): ChatMessage[] {
	return [...messageHistory];
}

export function clearChatHistory(): void {
	messageHistory.length = 0;
}

export function canSend(ws: WebSocket, isAdmin = false): { ok: boolean; reason?: string } {
	if (!chatEnabled && !isAdmin) {
		return { ok: false, reason: "chat_disabled" };
	}
	const now = Date.now();
	const last = lastSendMap.get(ws) || 0;
	if (now - last < RATE_LIMIT_MS) {
		return { ok: false, reason: "rate_limited" };
	}
	lastSendMap.set(ws, now);
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
