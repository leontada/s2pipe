import type { Template } from "@webtools/slick-server";

import { nodeUrl } from "../client.ts";

export default {
	name: "app",
	favicon: "/favicon.svg",

	styles: [
		"/styles/reset.css",
		"/styles/tokens.css",
		"/styles/ui.css",
		"/styles/app.css",
	],
	scripts: [],

	head: null,
	body: (req) => {
		const port = Deno.env.get("NODE_PORT") || "5055";
		const host = req.headers.get("host")?.split(":")[0];
		const fallback = host ? `http://${host}:${port}` : "";
		const url = nodeUrl(req.cookies.nodeUrl) || fallback;
		const siteKey = Deno.env.get("TURNSTILE_SITE_KEY") || "";
		return (
			<div id="root" data-node-url={url} data-turnstile-site-key={siteKey}>
				<div id="app"></div>
			</div>
		);
	},

	onrequest: null,
} satisfies Template;
