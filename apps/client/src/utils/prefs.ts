const KEY = "s2pipe.play";

export type PlayPrefs = {
	volume: number;
	muted: boolean;
	fill: boolean;
	showStats: boolean;
	touchEnabled?: boolean;
	touchOpacity?: number;
	chatToastsEnabled?: boolean;
	chatSoundVolume?: number;
	chatToastsOnHidden?: boolean;
};

const defaults: PlayPrefs = {
	volume: 1,
	muted: false,
	fill: false,
	showStats: false,
	touchEnabled: undefined,
	touchOpacity: 0.7,
	chatToastsEnabled: true,
	chatSoundVolume: 0.6,
	chatToastsOnHidden: true,
};

function storage(): Storage | null {
	try {
		if (typeof document === "undefined") return null;
		return globalThis.localStorage;
	} catch {
		return null;
	}
}

function clampVolume(value: unknown, fallback = defaults.volume): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(1, Math.max(0, n));
}

export function loadPlayPrefs(): PlayPrefs {
	try {
		const raw = storage()?.getItem(KEY);
		if (!raw) return { ...defaults };
		const parsed = JSON.parse(raw) as Partial<PlayPrefs>;
		return {
			volume: clampVolume(parsed.volume, defaults.volume),
			muted: Boolean(parsed.muted),
			fill: Boolean(parsed.fill),
			showStats: Boolean(parsed.showStats),
			touchEnabled: typeof parsed.touchEnabled === "boolean" ? parsed.touchEnabled : undefined,
			touchOpacity: typeof parsed.touchOpacity === "number" ? Math.min(1, Math.max(0.2, parsed.touchOpacity)) : 0.7,
			chatToastsEnabled: parsed.chatToastsEnabled !== undefined ? Boolean(parsed.chatToastsEnabled) : true,
			chatSoundVolume: clampVolume(parsed.chatSoundVolume, 0.6),
			chatToastsOnHidden: parsed.chatToastsOnHidden !== undefined ? Boolean(parsed.chatToastsOnHidden) : true,
		};
	} catch {
		return { ...defaults };
	}
}

export function savePlayPrefs(prefs: PlayPrefs): void {
	try {
		storage()?.setItem(
			KEY,
			JSON.stringify({
				volume: clampVolume(prefs.volume, defaults.volume),
				muted: Boolean(prefs.muted),
				fill: Boolean(prefs.fill),
				showStats: Boolean(prefs.showStats),
				touchEnabled: prefs.touchEnabled,
				touchOpacity: prefs.touchOpacity,
				chatToastsEnabled: prefs.chatToastsEnabled,
				chatSoundVolume: prefs.chatSoundVolume,
				chatToastsOnHidden: prefs.chatToastsOnHidden,
			}),
		);
	} catch {
		// ignore quota / private mode
	}
}
