#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { watch } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ACTIONS, KINDS, runAction } from "../scripts/lib/actions.mjs";
import { resolveInstance, rootConfig } from "../scripts/lib/config.mjs";
import * as boardModule from "../server/server.mjs";

// The action tools act on the instance of the session's working directory, resolved once.
// The board tools work from any directory, because one board server serves every instance
let instance = null;
let instanceError = null;
try {
	instance = resolveInstance().name;
} catch (e) {
	instanceError = e.message;
}

/** The instances the board server on `url` serves, or null when no board server answers there. */
async function servedInstances(url) {
	try {
		const res = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(2000) });
		const body = await res.json();
		return res.status === 200 && body?.name === "gary" ? (Array.isArray(body.instances) ? body.instances : []) : null;
	} catch {
		return null;
	}
}

const ROOT_URL = new URL("../", import.meta.url).href;
const SERVER_URL = new URL("../server/server.mjs", import.meta.url).href;

// A reload imports server.mjs with ?v=<n>. Pass that version on to every repo module it imports,
// so edits in scripts/lib/ load too. Packages in node_modules keep their single copy.
registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		const version = context.parentURL ? new URL(context.parentURL).searchParams.get("v") : null;
		if (!version || !resolved.url.startsWith(ROOT_URL) || resolved.url.includes("/node_modules/")) return resolved;
		const url = new URL(resolved.url);
		url.searchParams.set("v", version);
		return { ...resolved, url: url.href };
	},
});

const PARAMS = {
	merge: "`method`: squash, merge or rebase, by default the profile's mergeMethod. `sha`: expected head SHA, the merge fails when the PR head moved.",
	close: "`reason`: completed (default), not_planned or duplicate. `duplicateOf`: number of the original issue, required for an issue closed as duplicate.",
	review: "`event`: approve, request_changes or comment. `comments`: inline comments as [{ path, line, startLine, text }], `startLine` only for a range. `sha`: commit the review applies to.",
	create_issue: "`title`: title of the new issue. `text` is its body.",
	transfer: "`repo`: name of a repository of the same owner, listed in the profile's relatedRepos.",
	request_review: "`reviewer`: copilot or maintainer. `as`: me (default) or bot, only for copilot.",
	update_branch: "`sha`: expected head SHA, the update fails when the PR head moved.",
	label: "`add`, `remove`: arrays of existing label names.",
	assign: "`assignees`: array of GitHub logins.",
	answer_discussion: "`commentId`: node id of a top-level comment in this discussion.",
	react: "`content`: THUMBS_UP (default), HEART, HOORAY, ROCKET or EYES. `commentId`: node id of a comment, or leave it out to react on the thread.",
};

const DESTRUCTIVE = ["merge", "close", "transfer"];

const server = new McpServer({ name: "gary", version: "1.0.0" });

for (const [name, def] of Object.entries(ACTIONS)) {
	server.registerTool(
		name,
		{
			description: `${def.description} Runs on the profile's repository as the configured bot.`,
			// Keep the schema loose so runAction rejects bad input with {ok, result} JSON
			inputSchema: {
				kind: z.enum(KINDS).describe(`Allowed for this tool: ${def.kinds.join(", ")}`),
				number: z.number().describe("PR, issue or discussion number"),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(PARAMS[name] ?? "Takes no parameters."),
				text: z.string().optional(),
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: DESTRUCTIVE.includes(name),
				openWorldHint: true,
			},
		},
		async ({ kind, number, params, text }) => {
			const outcome = instanceError ? { ok: false, result: instanceError } : await runAction({ instance, action: name, kind, number, params, text });
			return {
				content: [{ type: "text", text: JSON.stringify(outcome) }],
				isError: !outcome.ok,
			};
		},
	);
}

// The master triage session starts the board with board_start. Other sessions leave it alone.
// stdout carries only MCP frames, so the board logs to stderr.
const { port } = rootConfig();
const boardUrl = `http://127.0.0.1:${port}/`;
let board = null;
let starting = null;
let serverModule = boardModule;
let codeWatchers = [];
let reloadTimer = null;
let reloading = Promise.resolve();
const log = (...a) => console.error("[gary]", ...a);
const boardOptions = () => ({ port, keepAlive: false, log });

// Restart the board with fresh code. A module that fails to load leaves the running server untouched.
async function reloadBoard() {
	if (!board) return;
	let next;
	try {
		next = await import(`${SERVER_URL}?v=${Date.now()}`);
	} catch (e) {
		log("Reloading the server code failed, the old server keeps running:", e.message);
		return;
	}
	const old = board;
	board = null;
	await old.close();
	try {
		board = await next.startBoardServer(boardOptions());
		serverModule = next;
		log("Reloaded the server code.");
	} catch (e) {
		log("The new server code did not start, restarting the old one:", e.message);
		try {
			board = await serverModule.startBoardServer(boardOptions());
		} catch (e2) {
			log("Restarting the old server failed:", e2.message);
		}
	}
}

function watchCode() {
	const targets = [
		[fileURLToPath(new URL("../server/", import.meta.url)), (n) => n === "server.mjs"],
		[fileURLToPath(new URL("../scripts/lib/", import.meta.url)), (n) => typeof n === "string" && n.endsWith(".mjs")],
	];
	for (const [dir, match] of targets) {
		try {
			const w = watch(dir, (_type, name) => {
				if (!match(name)) return;
				clearTimeout(reloadTimer);
				reloadTimer = setTimeout(() => {
					reloading = reloading.then(reloadBoard);
				}, 300);
				reloadTimer.unref();
			});
			w.on("error", (e) => log(`Watching ${dir} failed:`, e.message));
			w.unref();
			codeWatchers.push(w);
		} catch (e) {
			log(`Watching ${dir} failed:`, e.message);
		}
	}
}

function unwatchCode() {
	clearTimeout(reloadTimer);
	for (const w of codeWatchers) w.close();
	codeWatchers = [];
}

function reply(data, isError = false) {
	return { content: [{ type: "text", text: JSON.stringify(data) }], isError };
}

async function startBoard() {
	if (board) return { running: true, owner: true, url: board.url, instances: await servedInstances(board.url) };
	try {
		board = await serverModule.startBoardServer(boardOptions());
		watchCode();
		return { running: true, owner: true, url: board.url, instances: await servedInstances(board.url) };
	} catch (e) {
		if (e.code !== "EADDRINUSE") return { running: false, owner: false, url: boardUrl, error: e.message };
		const served = await servedInstances(boardUrl);
		if (served !== null) return { running: true, owner: false, url: boardUrl, instances: served };
		return { running: false, owner: false, url: boardUrl, error: `Another program uses port ${port}.` };
	}
}

server.registerTool(
	"board_start",
	{
		description: "Start the one board server for every instance in this session, or report the one that already runs. Works from any directory. Safe to call repeatedly.",
		annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
	},
	async () => {
		starting ??= startBoard().finally(() => {
			starting = null;
		});
		const status = await starting;
		return reply(status, !status.running);
	},
);

server.registerTool(
	"board_stop",
	{
		description: "Stop the local triage board server if this session started it.",
		annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
	},
	async () => {
		await reloading;
		if (!board) return reply({ stopped: false, owner: false, url: boardUrl });
		unwatchCode();
		const b = board;
		board = null;
		await b.close();
		return reply({ stopped: true, owner: true, url: boardUrl });
	},
);

server.registerTool(
	"board_status",
	{
		description: "Report the board URL, whether this session runs the board server, the instances it serves, and the instance of this session's directory.",
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	async () => {
		const served = await servedInstances(boardUrl);
		return reply({ url: boardUrl, owner: !!board, portAnswers: served !== null, instances: served ?? [], sessionInstance: instance, ...(instanceError && { sessionInstanceError: instanceError }) });
	},
);

let stopping = false;
async function shutdown() {
	if (stopping) return;
	stopping = true;
	unwatchCode();
	await board?.close().catch(() => {});
	process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await server.connect(new StdioServerTransport());
