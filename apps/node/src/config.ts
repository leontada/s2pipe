function env(name: string, fallback = ""): string {
	return Deno.env.get(name) || fallback;
}

function envInt(name: string, fallback: number): number {
	const raw = Deno.env.get(name);
	if (!raw) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
	const raw = Deno.env.get(name);
	if (!raw) return fallback;
	return raw.trim().toLowerCase() !== "false" && raw.trim() !== "0";
}

function parseMac(raw: string): Uint8Array | null {
	const parts = raw.trim().split(/[:\-]/);
	if (parts.length !== 6) return null;
	const out = new Uint8Array(6);
	for (let i = 0; i < 6; i++) {
		if (!/^[0-9a-fA-F]{2}$/.test(parts[i]!)) return null;
		out[i] = Number.parseInt(parts[i]!, 16);
	}
	if (out.every((b) => b === 0)) return null;
	return out;
}

function parsePid(raw: string, fallback: number): number {
	const text = raw.trim();
	if (!text) return fallback;
	const value = Number.parseInt(text, /^0x/i.test(text) ? 16 : 10);
	if (!Number.isFinite(value) || value <= 0 || value > 0xffff) return fallback;
	return value;
}

export const config = {
	nodePort: envInt("NODE_PORT", 5050),
	mediaHost: env("MEDIA_HOST", "127.0.0.1"),
	mediaPort: 8889,
	captureSource: env("CAPTURE_SOURCE", "test"),
	picoSerial: env("PICO_SERIAL"),
	enableBtWake: envBool("ENABLE_BT_WAKE", true),
	switchBtMac: parseMac(env("SWITCH_BT_MAC")),
	controllerBtMac: parseMac(env("CONTROLLER_BT_MAC")),
	controllerBtPid: parsePid(env("CONTROLLER_BT_PID"), 0x2069),
	playerPin: env("PLAYER_PIN", "").trim(),
	adminPassword: env("ADMIN_PASSWORD", "").trim(),
} as const;
