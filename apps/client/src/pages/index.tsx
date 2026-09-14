import type { Page } from "@webtools/slick-server";

import Play from "../islands/play.tsx";
import { nodeUrl, nodeUrlLocked } from "../client.ts";

function resolveFallback(req: Request): string | undefined {
	const proto = req.headers.get("x-forwarded-proto") || "http";
	const forwardedPort = req.headers.get("x-forwarded-port");
	const hostHeader = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
	const host = hostHeader.split(":")[0];
	if (!host) return undefined;

	if (proto === "https") {
		const portSuffix = forwardedPort && forwardedPort !== "443" ? `:${forwardedPort}` : "";
		return `https://${host}${portSuffix}`;
	}

	const port = Deno.env.get("NODE_PORT") || "5055";
	return `http://${host}:${port}`;
}

export default {
	url: "/",
	template: "app",

	title: "s2pipe",

	styles: ["/styles/play.css"],
	scripts: [],

	head: null,
	body: (req) => {
		const fallback = resolveFallback(req);
		const url = nodeUrl(req.cookies.nodeUrl) || fallback;
		const turnstileSiteKey = Deno.env.get("TURNSTILE_SITE_KEY") || "";
		return (
			<Play
				nodeUrl={url!}
				nodeLocked={nodeUrlLocked()}
				turnstileSiteKey={turnstileSiteKey}
			/>
		);
	},

	onpost: null,
	onrequest: (req, res) => {
		const fallback = resolveFallback(req);
		if (!nodeUrl(req.cookies.nodeUrl) && !fallback) return res.redirect("/set-node");
	},
} satisfies Page;
