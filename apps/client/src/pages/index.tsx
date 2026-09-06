import type { Page } from "@webtools/slick-server";

import Play from "../islands/play.tsx";
import { nodeUrl, nodeUrlLocked } from "../client.ts";

export default {
	url: "/",
	template: "app",

	title: "s2pipe",

	styles: ["/styles/play.css"],
	scripts: [],

	head: null,
	body: (req) => {
		const port = Deno.env.get("NODE_PORT") || "5055";
		const host = req.headers.get("host")?.split(":")[0];
		const fallback = host ? `http://${host}:${port}` : undefined;
		const url = nodeUrl(req.cookies.nodeUrl) || fallback;
		return (
			<Play
				nodeUrl={url!}
				nodeLocked={nodeUrlLocked()}
			/>
		);
	},

	onpost: null,
	onrequest: (req, res) => {
		const port = Deno.env.get("NODE_PORT") || "5055";
		const host = req.headers.get("host")?.split(":")[0];
		const fallback = host ? `http://${host}:${port}` : undefined;
		if (!nodeUrl(req.cookies.nodeUrl) && !fallback) return res.redirect("/set-node");
	},
} satisfies Page;
