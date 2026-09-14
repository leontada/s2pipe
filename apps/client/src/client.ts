import type { AppRouter } from "@s2pipe/node";
import { HttpClient } from "@webtools/expressapi";
import { Cookies } from "@webtools/slick-client";

type NodeClient = HttpClient<AppRouter>;

function env(name: string): string | undefined {
	try {
		return Deno.env.get(name) || undefined;
	} catch {
		return undefined;
	}
}

export function nodeUrlLocked(): boolean {
	return Boolean(env("NODE_BASE_URL"));
}

export function nodeUrl(cookie?: string | null): string | undefined {
	let raw = env("NODE_BASE_URL") || cookie || undefined;

	if (!raw && typeof document !== "undefined") {
		raw = document.querySelector("[data-node-url]")?.getAttribute("data-node-url") ||
			Cookies.get("nodeUrl") ||
			undefined;
	}

	if (!raw && typeof window !== "undefined") {
		if (window.location.protocol === "https:") {
			raw = window.location.origin;
		} else {
			const port = env("NODE_PORT") || "5055";
			raw = `${window.location.protocol}//${window.location.hostname}:${port}`;
		}
	}

	return raw?.replace(/\/+$/, "") || undefined;
}

export function createClient(baseUrl?: string): NodeClient {
	const url = (baseUrl || nodeUrl())?.replace(/\/+$/, "");
	if (!url) throw new Error("No node URL found.");
	return new HttpClient<AppRouter>({ baseUrl: url });
}

export function turnstileSiteKey(): string {
	let key = env("TURNSTILE_SITE_KEY");
	if (!key && typeof document !== "undefined") {
		key = document.querySelector("#root")?.getAttribute("data-turnstile-site-key") || undefined;
	}
	return key || "";
}
