#!/usr/bin/env node
// Local board server: serves board/board.html on 127.0.0.1 and runs approved actions as the configured bot.
// The gary MCP server starts it through startBoardServer(). `node server/server.mjs` runs it on its own.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, watch, writeSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ACTIONS, REVIEW_EVENTS, runAction } from "../scripts/lib/actions.mjs";
import { COLLECTIONS, ID_PATTERN, applyWrite, boardDir, docPath, readJson, tokenFile, writeAtomic } from "../scripts/lib/board-store.mjs";
import { ROOT, loadConfig, loadProfile } from "../scripts/lib/config.mjs";
import { accountMode } from "../scripts/lib/gh.mjs";
import { checkFresh } from "../scripts/lib/guard.mjs";

const PAGE_FILE = join(ROOT, "board", "board.html");
const MAX_BODY = 256 * 1024;
const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 25000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
export const HEALTH = { ok: true, name: "gary" };
const OUTDATED = "The board is out of date, reload it.";
const ITEM_ID = /^(pr|issue|disc)-\d+$/;
const MAX_TEXT = 65536;
const MAX_NOTE = 1000;
const MAX_TITLE = 256;

/** Allowed actors per route type. The first entry is the default when a route has no `as`. */
export const ROUTE_TYPES = {
	reply: ["me", "bot"],
	request_logs: ["bot", "me"],
	close: ["me"],
	reopen: ["bot", "me"],
	merge: ["me"],
	review: ["bot", "me"],
	address_review: ["agent"],
	follow_up: ["agent", "bot", "me"],
	take_over: ["agent"],
	drive: ["agent"],
	move: ["bot", "me"],
	chore: ["bot"],
};
const DRIVE_AUTHORS = new Set(["maintainer", "bot", "copilot"]);
// Without a bot these turn into text the maintainer posts himself
const PREFILL_TYPES = new Set(["reply", "request_logs", "reopen", "follow_up"]);
const PUSHING_AGENT_TYPES = new Set(["address_review", "take_over", "drive", "follow_up"]);
const MOVE_MODES = ["transfer", "close"];
const CHORE_ACTIONS = new Set(["label", "assign", "ready", "answer_discussion", "react", "update_branch", "rerun_ci"]);

/** Fingerprint of a drafted route. It changes when the routine rewrites the route or reviews the item again. */
export function draftHash(route, item) {
	const text = typeof route?.text === "string" ? route.text : "";
	const params = JSON.stringify(route?.params ?? {});
	const reviewedAt = typeof item?.reviewedAt === "string" ? item.reviewedAt : "";
	return createHash("sha256").update(text + "\u0000" + params + "\u0000" + reviewedAt).digest("hex").slice(0, 16);
}

function routesOf(item) {
	return Array.isArray(item?.routes) ? item.routes.filter((r) => r && typeof r === "object" && typeof r.id === "string" && r.id) : [];
}

/** The route's actor, or undefined when the type is unknown or the given `as` is not allowed for it. */
export function actorOf(route) {
	const allowed = ROUTE_TYPES[route?.type];
	if (!allowed) return undefined;
	if (route.type === "move") {
		// The target decides who acts: GitHub has no API to convert between issues and discussions
		const to = route.params?.to;
		const as = to === "discussion" || to === "issue" ? "me" : typeof to === "string" ? "bot" : undefined;
		return route.as === undefined || route.as === as ? as : undefined;
	}
	// follow_up has more than one sensible actor, so it needs an explicit `as`
	if (route.as === undefined) return route.type === "follow_up" ? undefined : allowed[0];
	return allowed.includes(route.as) ? route.as : undefined;
}

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Who acts after a click, given the configured accounts (`mode` from accountMode()):
 * "me" (prefill, he acts on GitHub), "bot", "own" (his stored gh login, only with allowOwnTokenPushes),
 * "agent", "unavailable" (needs a bot or allowOwnTokenPushes), or undefined for an invalid route.
 * A move to a repository has one actor per button, so pass its `moveMode` ("transfer" or "close").
 */
export function effectiveActor(route, mode, moveMode) {
	const as = actorOf(route);
	if (as === "me" && route.type === "review" && Array.isArray(route.params?.comments) && route.params.comments.length) return undefined;
	if (as === undefined || as === "me") return as;
	if (as === "agent") return mode === "none" && PUSHING_AGENT_TYPES.has(route.type) ? "unavailable" : "agent";
	if (mode === "bot") return "bot";
	if (route.type === "move") {
		if (moveMode === "close") return "me";
		return mode === "own" ? "own" : "unavailable";
	}
	const comments = Array.isArray(route.params?.comments) ? route.params.comments : [];
	if (PREFILL_TYPES.has(route.type) || (route.type === "review" && !comments.length)) return "me";
	return mode === "own" ? "own" : "unavailable";
}

/** The actor per route as the page shows it. A move to a repository gets one actor per button. */
function servedActor(route, mode) {
	if (route.type === "move" && actorOf(route) === "bot") {
		return { actor: effectiveActor(route, mode, "transfer"), actors: { transfer: effectiveActor(route, mode, "transfer"), close: effectiveActor(route, mode, "close") } };
	}
	return { actor: effectiveActor(route, mode) ?? "invalid" };
}

class Refusal extends Error {}

function checkKeys(obj, allowed, where) {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) throw new Refusal(`${where} has unknown field "${key}".`);
	}
}

/**
 * Validates what the maintainer chose on the card against the route and the item.
 * Returns the normalized input. Throws a Refusal for anything the card could not have sent.
 */
export function validateInput(route, item, input) {
	if (input === undefined || input === null) input = {};
	if (!isObject(input)) throw new Refusal("input must be an object.");
	const params = isObject(route.params) ? route.params : {};

	if (route.type === "review") {
		checkKeys(input, ["commentIds"], "input");
		const comments = Array.isArray(params.comments) ? params.comments : [];
		const known = new Set(comments.map((c) => c?.id).filter((id) => typeof id === "string"));
		if (input.commentIds === undefined) return { commentIds: [...known] };
		if (!Array.isArray(input.commentIds)) throw new Refusal("input.commentIds must be an array.");
		const ids = new Set();
		for (const id of input.commentIds) {
			if (typeof id !== "string" || !known.has(id)) throw new Refusal(`input.commentIds names an unknown comment.`);
			if (ids.has(id)) throw new Refusal("input.commentIds lists a comment twice.");
			ids.add(id);
		}
		return { commentIds: [...ids] };
	}

	if (route.type === "address_review") {
		checkKeys(input, ["decisions"], "input");
		const threads = new Set((Array.isArray(item.threads) ? item.threads : []).map((t) => t?.id).filter((id) => typeof id === "string" && id));
		if (!Array.isArray(input.decisions) || !input.decisions.length) {
			throw new Refusal("input.decisions must list at least one thread.");
		}
		const seen = new Set();
		const decisions = input.decisions.map((d) => {
			if (!isObject(d)) throw new Refusal("Each decision must be an object.");
			checkKeys(d, ["threadId", "decision", "note"], "A decision");
			if (typeof d.threadId !== "string" || !threads.has(d.threadId)) throw new Refusal("A decision names an unknown thread.");
			if (seen.has(d.threadId)) throw new Refusal("A thread has two decisions.");
			seen.add(d.threadId);
			if (d.decision !== "fix" && d.decision !== "dismiss") throw new Refusal('A decision must be "fix" or "dismiss".');
			if (d.note !== undefined && (typeof d.note !== "string" || d.note.length > MAX_NOTE)) {
				throw new Refusal(`A note must be a string of at most ${MAX_NOTE} characters.`);
			}
			const note = typeof d.note === "string" ? d.note.trim() : "";
			return { threadId: d.threadId, decision: d.decision, ...(note && { note }) };
		});
		return { decisions };
	}

	if (route.type === "move") {
		checkKeys(input, ["mode"], "input");
		if (!MOVE_MODES.includes(input.mode)) throw new Refusal('input.mode must be "transfer" or "close".');
		return { mode: input.mode };
	}

	if (route.type === "drive") {
		checkKeys(input, ["maxRounds"], "input");
		if (input.maxRounds === undefined) return {};
		if (!Number.isInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 3) {
			throw new Refusal("input.maxRounds must be 1, 2 or 3.");
		}
		return { maxRounds: input.maxRounds };
	}

	if (route.type === "follow_up") {
		checkKeys(input, ["title"], "input");
		if (input.title === undefined) return {};
		if (typeof input.title !== "string" || !input.title.trim() || input.title.length > MAX_TITLE) {
			throw new Refusal(`input.title must be a non-empty string of at most ${MAX_TITLE} characters.`);
		}
		return { title: input.title.trim() };
	}

	checkKeys(input, [], "input");
	return {};
}

/**
 * Maps a clicked route to what the server does: queue one agent request, or run one or more bot actions.
 * Throws a Refusal when the route cannot run through the server.
 */
export function planRoute(route, item, input, text, mode = "bot") {
	const base = actorOf(route);
	if (!base) throw new Refusal(`The route is invalid: type "${route.type}" cannot run as "${route.as}".`);
	if (base === "me") throw new Refusal("This route is yours to do on GitHub. The board only opens it for you.");
	const params = isObject(route.params) ? route.params : {};
	const chosen = validateInput(route, item, input);
	const as = effectiveActor(route, mode, chosen.mode);
	if (as === "me") throw new Refusal("Without a bot account this route is yours to do on GitHub. The board only opens it for you.");
	if (as === "unavailable") {
		throw new Refusal("This route needs a bot account, or allowOwnTokenPushes in config.json to run it under your own gh login.");
	}

	if (as === "agent") {
		switch (route.type) {
			case "address_review":
				return { agent: true, action: "address_review", params: { decisions: chosen.decisions }, text };
			case "follow_up":
				return { agent: true, action: "start_fix", params: params.finding === undefined ? {} : { finding: params.finding }, text };
			case "take_over": {
				const mode = params.mode ?? "push";
				if (mode !== "push" && mode !== "replace") throw new Refusal('take_over needs params.mode "push" or "replace".');
				if (mode === "replace" && !(typeof route.callout === "string" && route.callout.trim())) {
					throw new Refusal("A replacement PR needs a callout that says why pushing is not possible.");
				}
				return { agent: true, action: "take_over", params: { mode }, text };
			}
			case "drive": {
				if (item.kind !== "pr") throw new Refusal("Only PRs can be driven.");
				if (!DRIVE_AUTHORS.has(item.authorType) && item.takenOver !== true) {
					throw new Refusal("Only PRs by the maintainer, a bot or Copilot, or taken-over PRs can be driven.");
				}
				const maxRounds = chosen.maxRounds ?? params.maxRounds ?? 3;
				if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 3) {
					throw new Refusal("drive needs params.maxRounds from 1 to 3.");
				}
				return { agent: true, action: "drive", params: { maxRounds }, text };
			}
		}
	}

	switch (route.type) {
		case "reply":
		case "request_logs":
			return { steps: [{ action: "comment", params: {}, text }], guard: { action: "comment", params: {} } };
		case "review": {
			const comments = (Array.isArray(params.comments) ? params.comments : [])
				.filter((c) => chosen.commentIds.includes(c.id))
				.map(({ path, line, startLine, text: body }) => ({ path, line, ...(startLine !== undefined && { startLine }), text: body }));
			const reviewParams = { event: params.event, ...(comments.length && { comments }) };
			if (!Object.hasOwn(REVIEW_EVENTS, params.event ?? "")) throw new Refusal("The review route has no valid event.");
			if (typeof item.reviewedSha === "string") reviewParams.sha = item.reviewedSha;
			return { steps: [{ action: "review", params: reviewParams, text }], guard: { action: "review", params: reviewParams } };
		}
		case "reopen":
			return { steps: [{ action: "reopen", params: {}, text }], guard: { action: "reopen", params: {} } };
		case "follow_up": {
			const title = chosen.title ?? params.title;
			return { followUp: true, steps: [{ action: "create_issue", params: { title }, text }], guard: { action: "comment", params: {} } };
		}
		case "move":
			if (item.kind !== "issue") throw new Refusal("Only issues can move to another repository.");
			if (chosen.mode === "transfer") {
				return { steps: [{ action: "transfer", params: { repo: params.to }, text: "" }], guard: { action: "transfer", params: {} } };
			}
			// The only close the server runs: the text asks the reporter to open the issue in the other repository
			if (!text.trim()) throw new Refusal("Closing with a pointer to the other repository needs a text.");
			return { steps: [{ action: "close", params: { reason: "not_planned" }, text }], guard: { action: "close", params: {} } };
		case "chore": {
			const { action, ...rest } = params;
			if (!CHORE_ACTIONS.has(action)) throw new Refusal(`A chore cannot run "${action}".`);
			return { steps: [{ action, params: rest, text: "" }], guard: { action, params: rest } };
		}
	}
	throw new Refusal(`The route type "${route.type}" cannot run as "${base}".`);
}

/** Resolves true when `url` answers like the board server. */
export async function boardAnswers(url) {
	try {
		const res = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(2000) });
		const body = await res.json();
		return res.status === 200 && body?.name === HEALTH.name;
	} catch {
		return false;
	}
}

const CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline' https://fonts.googleapis.com",
	"font-src https://fonts.gstatic.com",
	"connect-src 'self'",
	"img-src data: https://github.com https://avatars.githubusercontent.com",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

/**
 * Reads the shared token or creates it. The exclusive create makes two processes that start together agree on one token.
 */
export function loadToken(file) {
	mkdirSync(dirname(file), { recursive: true });
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			const fd = openSync(file, "wx", 0o600);
			const token = randomBytes(32).toString("hex");
			writeSync(fd, token + "\n");
			closeSync(fd);
			return token;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
		}
		const token = readFileSync(file, "utf8").trim();
		if (TOKEN_PATTERN.test(token)) return token;
		// Another process created the file and has not written the token yet
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
	}
	throw new Error(`${file} does not hold a valid token. Delete it and start again.`);
}

function withLock(map, key, fn) {
	const prev = map.get(key) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	const tail = next.catch(() => {});
	map.set(key, tail);
	tail.then(() => {
		if (map.get(key) === tail) map.delete(key);
	});
	return next;
}

function json(res, status, data) {
	const body = JSON.stringify(data);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(body);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				// Drain the rest so the 413 reply reaches the client
				req.removeAllListeners("data");
				req.removeAllListeners("end");
				req.resume();
				reject(Object.assign(new Error("Body too large."), { status: 413 }));
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			try {
				const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Body must be a JSON object.");
				resolve(v);
			} catch (e) {
				reject(Object.assign(e, { status: 400 }));
			}
		});
		req.on("error", reject);
	});
}

/** What the page needs to name the project and the accounts without hard-coding them. */
export function boardInfo({ dryRun = false } = {}) {
	const config = loadConfig();
	const profile = loadProfile();
	const account = (login) => (login ? { login, avatarUrl: `https://github.com/${encodeURIComponent(login)}.png?size=80` } : null);
	return {
		name: profile.name,
		repo: profile.repo,
		repoUrl: `https://github.com/${profile.repo}`,
		me: account(config.me),
		bot: account(config.bot?.login),
		accountMode: accountMode(),
		relatedRepos: profile.relatedRepos,
		botCommands: profile.botCommands,
		reviewBots: profile.reviewBots,
		dryRun,
	};
}

function shim(token, info) {
	return `<script>
"use strict";
(() => {
  const TOKEN = ${JSON.stringify(token).replace(/</g, "\\u003c")};
  const INFO = ${JSON.stringify(info).replace(/</g, "\\u003c")};
  const SERVER = "host:gary";
  const cache = { items: null, actions: null, meta: undefined };
  const subs = { items: new Set(), actions: new Set(), meta: new Set() };
  let connected = false;

  function setConnected(on) {
    connected = on;
    // board.html declares setServer as a global function and uses it for the connection icon
    if (typeof window.setServer === "function") window.setServer(on ? "connected" : "queued");
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "X-Board-Token": TOKEN, "Content-Type": "application/json" } : { "X-Board-Token": TOKEN },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON reply */ }
    return { status: res.status, data };
  }

  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const collectionSnap = (docs) => ({
    docs: docs.map((d) => ({ id: d.id, data: () => clone(d.data) })),
    metadata: { fromCache: false },
  });
  const docSnap = (v) => ({ exists: v != null, data: () => clone(v), metadata: { fromCache: false } });

  function emit(name) {
    for (const s of subs[name]) s();
  }

  function connect() {
    const es = new EventSource("/api/events?token=" + encodeURIComponent(TOKEN));
    for (const name of ["items", "actions", "meta"]) {
      es.addEventListener(name, (e) => {
        try { cache[name] = JSON.parse(e.data); } catch { return; }
        emit(name);
      });
    }
    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("error", () => setConnected(false));
    // board.html decides whether it can reload right away
    es.addEventListener("reload", () => window.dispatchEvent(new Event("board:reload")));

  }

  function query(name) {
    let order = null;
    let max = Infinity;
    const q = {
      orderBy(field, dir) { order = [field, dir === "desc" ? -1 : 1]; return q; },
      limit(n) { max = n; return q; },
      onSnapshot(cb) {
        const fire = () => {
          if (cache[name] == null) return;
          let docs = cache[name].slice();
          if (order) {
            const [f, d] = order;
            docs.sort((a, b) => (String(a.data[f] ?? "") < String(b.data[f] ?? "") ? -d : String(a.data[f] ?? "") > String(b.data[f] ?? "") ? d : 0));
          }
          cb(collectionSnap(docs.slice(0, max)));
        };
        subs[name].add(fire);
        queueMicrotask(fire);
        return () => subs[name].delete(fire);
      },
    };
    return q;
  }

  async function write(op, path, data) {
    let r;
    try {
      r = await api("/api/db", { op, path, data });
    } catch {
      throw Object.assign(new Error("The board server is not reachable."), { code: "unavailable" });
    }
    if (r.status !== 200) throw new Error((r.data && r.data.error) || "The board server rejected the write (" + r.status + ").");
  }

  const db = {
    collection: (name) => query(name),
    doc(path) {
      return {
        onSnapshot(cb) {
          if (path !== "meta/status") return () => {};
          const fire = () => { if (cache.meta !== undefined) cb(docSnap(cache.meta)); };
          subs.meta.add(fire);
          queueMicrotask(fire);
          return () => subs.meta.delete(fire);
        },
        set: (data) => write("set", path, data),
        update: (data) => write("update", path, data),
      };
    },
  };

  const mcp = {
    async listTools(server) {
      if (server !== SERVER) return { servers: [] };
      const r = await api("/api/tools");
      if (r.status !== 200) throw Object.assign(new Error("Tool list failed."), { code: "server_not_connected" });
      return { servers: [{ server: SERVER, tools: r.data.tools }] };
    },
    async callTool(server, tool, input) {
      if (server !== SERVER) throw Object.assign(new Error("Unknown server."), { code: "server_not_found" });
      if (!connected) throw Object.assign(new Error("The board server is not reachable."), { code: "server_not_connected" });
      let r;
      try {
        r = await api("/api/action", { action: tool, ...input });
      } catch {
        // The request may have reached the server, so the outcome stays open
        throw Object.assign(new Error("The board server did not answer."), { code: "server_unavailable" });
      }
      // Refusals carry a readable reason and nothing ran
      if (r.data && r.data.ok === false) {
        throw Object.assign(new Error("The action failed."), {
          code: "tool_error",
          result: { content: [{ type: "text", text: JSON.stringify(r.data) }] },
        });
      }
      if (r.status >= 400 && r.status < 500) throw Object.assign(new Error("Rejected by the board server."), { code: "bad_request" });
      if (r.status !== 200 || !r.data) throw Object.assign(new Error("The board server failed."), { code: "upstream_error" });
      if (r.data.ok) return { payload: r.data };
      throw Object.assign(new Error("The action failed."), {
        code: "tool_error",
        result: { content: [{ type: "text", text: JSON.stringify(r.data) }] },
      });
    },
  };

  // Board-only helper of the local server: project name, repo and accounts
  const board = { ...INFO, maintainer: INFO.me.login };

  window.claude = {
    use(name) {
      if (name === "board") return Promise.resolve(board);
      if (name === "db") return Promise.resolve(db);
      if (name === "mcp") return Promise.resolve(mcp);
      return Promise.reject(Object.assign(new Error("Unknown capability " + name), { code: "not_granted" }));
    },
  };
  connect();
})();
</script>`;
}

const RESET = `<style>
*, *::before, *::after { box-sizing: border-box; }
:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>`;


/**
 * Starts the board server on 127.0.0.1 and resolves once it listens.
 * Rejects with the listen error, like EADDRINUSE when another process holds the port.
 * With `keepAlive: false` the server never keeps the process running on its own.
 */
export async function startBoardServer({
	port = loadConfig().port,
	dir = boardDir(),
	dryRun = process.env.GARY_DRY_RUN === "1",
	keepAlive = true,
	pageFile = PAGE_FILE,
	log = (...a) => console.error("[board]", ...a),
} = {}) {
	if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid port ${port}`);
	for (const c of COLLECTIONS) mkdirSync(join(dir, c), { recursive: true });
	const TOKEN = loadToken(tokenFile(dir));
	const ORIGINS = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
	const HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	const url = `http://127.0.0.1:${port}/`;

	const clients = new Set();
	const pending = new Map();
	const docLocks = new Map();
	// Run GitHub actions one at a time per item, so a double click cannot merge twice
	const actionLocks = new Map();
	let watchers = [];
	let closed = false;
	// Routes that ran in this process, so a repeat is refused even before the action file lands
	const doneKeys = new Set();
	// Guard refusals per route, so the page can offer "Post anyway" where force is allowed
	const refusals = new Map();
	// Thread state from the latest guard read per item, so the page can show a thread that closed since the review
	const liveStates = new Map();

	async function readCollection(collection) {
		const d = join(dir, collection);
		const names = (await readdir(d)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
		const docs = await Promise.all(names.map(async (n) => {
			const id = n.slice(0, -5);
			const data = ID_PATTERN.test(id) ? await readJson(join(d, n)) : null;
			return data ? { id, data } : null;
		}));
		return docs.filter(Boolean);
	}

	const readMeta = () => readJson(join(dir, "meta.json"));

	// Clicks that ran or were queued, keyed by item, route and draft
	function clickedByKey(actions) {
		const out = new Map();
		for (const { data: a } of actions) {
			if ((a.status !== "done" && a.status !== "queued") || typeof a.routeId !== "string" || typeof a.draftHash !== "string") continue;
			out.set(`${a.itemId}|${a.routeId}|${a.draftHash}`, {
				status: a.status,
				result: typeof a.result === "string" ? a.result : "",
				finishedAt: a.finishedAt ?? a.createdAt ?? null,
				via: a.via ?? null,
			});
		}
		return out;
	}

	// Serve each route with its draft hash and whether it already ran, so the page can bind clicks to drafts
	async function readItems() {
		const mode = accountMode();
		const [items, actions] = await Promise.all([readCollection("items"), readCollection("actions")]);
		const clicked = clickedByKey(actions);
		return items.map(({ id, data }) => ({
			id,
			data: {
				...data,
				liveState: liveStates.get(id),
				routes: routesOf(data).map((route) => {
					const hash = draftHash(route, data);
					const key = `${id}|${route.id}|${hash}`;
					const ran = clicked.get(key) ?? (doneKeys.has(key) ? { status: "done", result: "", finishedAt: null } : undefined);
					return { ...route, ...servedActor(route, mode), draftHash: hash, done: ran, refused: ran ? undefined : refusals.get(key) };
				}),
			},
		}));
	}

	const snapshotOf = (name) => (name === "meta" ? readMeta() : name === "items" ? readItems() : readCollection(name));

	function send(res, event, data) {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}

	function schedulePush(name) {
		clearTimeout(pending.get(name));
		const t = setTimeout(async () => {
			pending.delete(name);
			if (!clients.size) return;
			if (name === "reload") {
				for (const res of clients) send(res, "reload", {});
				return;
			}
			try {
				const data = await snapshotOf(name);
				for (const res of clients) send(res, name, data);
			} catch (e) {
				log(`Reading ${name} failed:`, e.message);
			}
		}, DEBOUNCE_MS);
		t.unref();
		pending.set(name, t);
	}

	function startWatching() {
		const add = (path, fn) => {
			try {
				const w = watch(path, fn);
				w.on("error", (e) => log(`Watching ${path} failed:`, e.message));
				if (!keepAlive) w.unref();
				watchers.push(w);
			} catch (e) {
				log(`Watching ${path} failed:`, e.message);
			}
		};
		add(join(dir, "items"), () => schedulePush("items"));
		// Action docs mark routes as done, so they change the served items too
		add(join(dir, "actions"), () => {
			schedulePush("actions");
			schedulePush("items");
		});
		add(dir, (_type, name) => {
			if (name === "meta.json") schedulePush("meta");
		});
		// Open pages reload themselves when the board page changes
		add(dirname(pageFile), (_type, name) => {
			if (name === basename(pageFile)) schedulePush("reload");
		});
	}

	function stopWatching() {
		for (const w of watchers) w.close();
		watchers = [];
	}

	const heartbeat = setInterval(() => {
		for (const res of clients) res.write(": keepalive\n\n");
	}, HEARTBEAT_MS);
	heartbeat.unref();

	async function logClick(itemId, doc) {
		let id = `${itemId}-${Date.now()}`;
		while (await readJson(join(dir, "actions", id + ".json"))) id = `${itemId}-${Date.now() + 1}`;
		const file = join(dir, "actions", id + ".json");
		await withLock(docLocks, file, () => writeAtomic(file, { itemId, ...doc }));
		schedulePush("actions");
		schedulePush("items");
		return id;
	}

	// Run only what the agent drafted: type, actor, params and the target come from the item file
	async function handleAction(body) {
		const { itemId, routeId, text, force, input } = body;
		const outdated = [200, { ok: false, result: OUTDATED, outdated: true }];
		if (typeof itemId !== "string" || !ITEM_ID.test(itemId) || typeof routeId !== "string") return outdated;
		if (text !== undefined && (typeof text !== "string" || text.length > MAX_TEXT)) {
			return [400, { ok: false, result: `text must be a string of at most ${MAX_TEXT} characters.` }];
		}
		return withLock(actionLocks, itemId, async () => {
			const item = await readJson(join(dir, "items", itemId + ".json"));
			const route = item && routesOf(item).find((r) => r.id === routeId);
			if (!route) return outdated;
			const prefix = { pr: "pr", issue: "issue", discussion: "disc" }[item.kind];
			if (`${prefix}-${item.number}` !== itemId) return outdated;
			const hash = draftHash(route, item);
			if (body.draftHash !== hash) return outdated;

			const key = `${itemId}|${routeId}|${hash}`;
			if (doneKeys.has(key) || clickedByKey(await readCollection("actions")).has(key)) {
				return [409, { ok: false, result: "This route already ran. The board shows its result.", duplicate: true }];
			}

			const draft = typeof text === "string" ? text : typeof route.text === "string" ? route.text : "";
			let plan;
			try {
				plan = planRoute(route, item, input, draft, accountMode());
			} catch (e) {
				if (e instanceof Refusal) return [200, { ok: false, result: e.message }];
				throw e;
			}
			const kind = item.kind;
			const number = item.number;
			const log = {
				routeId,
				route: route.type,
				draftHash: hash,
				edited: draft !== (route.text ?? ""),
				createdAt: new Date().toISOString(),
			};

			if (plan.agent) {
				await logClick(itemId, {
					...log,
					action: plan.action,
					params: plan.params,
					text: plan.text,
					status: "queued",
					via: "queue",
					finishedAt: null,
					result: "",
				});
				doneKeys.add(key);
				return [200, { ok: true, result: "Queued for the master session.", queued: true }];
			}

			// The server never merges
			if (plan.steps.some((s) => s.action === "merge" || !Object.hasOwn(ACTIONS, s.action))) {
				return [200, { ok: false, result: "Merges happen on GitHub. The board only opens the PR for you." }];
			}

			const fresh = await checkFresh({ ...plan.guard, kind, number, item, force: force === true });
			if (fresh.state) {
				liveStates.set(itemId, { state: fresh.state, reason: fresh.stateReason ?? null });
				schedulePush("items");
			}
			if (!fresh.ok) {
				refusals.set(key, { reason: fresh.reason, forceable: fresh.forceable });
				schedulePush("items");
				return [200, { ok: false, result: fresh.reason, stale: true, forceable: fresh.forceable }];
			}

			const [first] = plan.steps;
			let outcome = await runAction({ ...first, kind, number, dryRun });
			if (outcome.ok && plan.followUp) {
				const issueUrl = dryRun ? null : outcome.result;
				const issueNumber = /\/issues\/(\d+)$/.exec(issueUrl ?? "")?.[1];
				const link = await runAction({
					action: "comment",
					kind,
					number,
					params: {},
					text: `Follow-up: #${issueNumber ?? "<new issue>"}`,
					dryRun,
				});
				if (dryRun) {
					outcome = { ok: true, result: { dryRun: true, invocations: [...outcome.result.invocations, ...(link.result?.invocations ?? [])] } };
				} else if (!link.ok) {
					// The issue exists either way, so the click counts as done and a repeat cannot file it twice
					outcome = { ok: true, result: issueUrl, warning: `Linking the issue failed: ${link.result}` };
				}
			}

			await logClick(itemId, {
				...log,
				action: first.action,
				params: first.params,
				text: first.text,
				status: outcome.ok ? "done" : "failed",
				via: "server",
				finishedAt: new Date().toISOString(),
				result: typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result),
			});
			if (outcome.ok) {
				doneKeys.add(key);
				refusals.delete(key);
			}
			schedulePush("items");
			return [200, outcome];
		});
	}

	// Serialize writes per file, so a merge never reads a file that another write is replacing
	async function handleDb(body) {
		const file = docPath(dir, body.path);
		if (!file) return [400, { error: "Only items/<id>, actions/<id> and meta can be written." }];
		return withLock(docLocks, file, async () => {
			const reply = await applyWrite(dir, body);
			if (reply[0] === 200) schedulePush(body.path === "meta" ? "meta" : body.path.split("/")[0]);
			return reply;
		});
	}


	function tokenOk(given) {
		if (typeof given !== "string" || given.length !== TOKEN.length) return false;
		return timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
	}

	async function page() {
		const board = await readFile(pageFile, "utf8");
		const split = board.indexOf('<div class="wrap">');
		if (split < 0) throw new Error("board.html has no wrap element");
		return `<!doctype html>
	<html lang="en">
	<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
	<meta name="referrer" content="no-referrer">
	${RESET}
	${board.slice(0, split)}
	${shim(TOKEN, boardInfo({ dryRun }))}
	</head>
	<body>
	${board.slice(split)}
	</body>
	</html>
	`;
	}

	async function handle(req, res) {
		const host = req.headers.host ?? "";
		if (!HOSTS.has(host)) return json(res, 421, { error: "Unknown host." });
		const origin = req.headers.origin;
		if (origin !== undefined && !(ORIGINS.has(origin) && origin === `http://${host}`)) {
			return json(res, 403, { error: "Cross-origin requests are not allowed." });
		}
		const url = new URL(req.url, `http://${host}`);

		if (url.pathname === "/" && req.method === "GET") {
			const body = await page();
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": CSP,
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
				"X-Frame-Options": "DENY",
			});
			return res.end(body);
		}

		if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found." });
		if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, HEALTH);

		const given = url.pathname === "/api/events" ? url.searchParams.get("token") : req.headers["x-board-token"];
		if (!tokenOk(given)) return json(res, 401, { error: "Missing or wrong token." });

		if (req.method === "GET" && url.pathname === "/api/events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
				"X-Content-Type-Options": "nosniff",
			});
			res.write("retry: 3000\n\n");
			clients.add(res);
			req.on("close", () => clients.delete(res));
			const [items, actions, meta] = await Promise.all([readItems(), readCollection("actions"), readMeta()]);
			send(res, "items", items);
			send(res, "actions", actions);
			send(res, "meta", meta);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/state") {
			const [items, actions, meta] = await Promise.all([readItems(), readCollection("actions"), readMeta()]);
			return json(res, 200, { board: boardInfo({ dryRun }), items, actions, meta });
		}
		if (req.method === "GET" && url.pathname === "/api/tools") {
			return json(res, 200, { tools: Object.keys(ACTIONS), dryRun });
		}
		if (req.method === "POST" && ["/api/db", "/api/action"].includes(url.pathname)) {
			if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
				return json(res, 415, { error: "Send JSON." });
			}
			const body = await readBody(req);
			if (url.pathname === "/api/db") {
				const [status, data] = await handleDb(body);
				return json(res, status, data);
			}
			const [status, data] = await handleAction(body);
			return json(res, status, data);
		}
		return json(res, 404, { error: "Not found." });
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((e) => {
			if (!res.headersSent) json(res, e.status ?? 500, { error: e.status ? e.message : "Internal error." });
			else res.end();
			if (!e.status) log(e.stack ?? e);
		});
	});
	server.on("clientError", (_e, socket) => socket.destroy());
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (e) {
		clearInterval(heartbeat);
		throw e;
	}
	server.on("error", (e) => log("Server error:", e.message));
	if (!keepAlive) server.unref();
	startWatching();
	log(`Board on ${url}${dryRun ? " (dry run, no GitHub writes)" : ""}, data in ${dir}`);

	return {
		url,
		port,
		close() {
			if (closed) return Promise.resolve();
			closed = true;
			clearInterval(heartbeat);
			for (const t of pending.values()) clearTimeout(t);
			stopWatching();
			for (const res of clients) res.end();
			clients.clear();
			return new Promise((resolve) => {
				if (!server.listening) return resolve();
				server.close(() => resolve());
				server.closeAllConnections();
			});
		},
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { values: args } = parseArgs({
		options: {
			"dry-run": { type: "boolean", default: false },
			port: { type: "string" },
			"board-dir": { type: "string" },
			"page-file": { type: "string" },
			watch: { type: "boolean", default: false },
		},
	});
	if (args.watch && process.env.GARY_WATCH_CHILD !== "1") {
		supervise(process.argv.slice(2).filter((a) => a !== "--watch"));
	} else {
		await runStandalone(args);
	}
}

/**
 * Runs the server as a child process and restarts it when a file in server/ or scripts/lib/ changes.
 * A child that fails, for example on a half-written edit, is logged and started again on the next change.
 */
function supervise(childArgs) {
	const script = fileURLToPath(import.meta.url);
	const log = (...a) => console.error("[board watch]", ...a);
	let child = null;
	let stopping = false;
	let restarting = false;
	let timer = null;

	function start() {
		const me = spawn(process.execPath, [script, ...childArgs], {
			stdio: "inherit",
			env: { ...process.env, GARY_WATCH_CHILD: "1" },
		});
		child = me;
		me.on("exit", (code, signal) => {
			if (child === me) child = null;
			if (stopping) process.exit(0);
			if (restarting) return;
			log(`The server stopped (${signal ?? "exit code " + code}). It starts again on the next file change.`);
		});
	}

	async function restart() {
		restarting = true;
		const old = child;
		if (old) {
			const exited = new Promise((r) => old.once("exit", r));
			old.kill("SIGTERM");
			const force = setTimeout(() => old.kill("SIGKILL"), 5000);
			await exited;
			clearTimeout(force);
		}
		restarting = false;
		if (stopping) return;
		log("Restarting after a file change.");
		start();
	}

	for (const dir of [join(ROOT, "server"), join(ROOT, "scripts", "lib")]) {
		const w = watch(dir, (_type, name) => {
			if (typeof name !== "string" || !name.endsWith(".mjs")) return;
			// Wait for the burst of events a save produces, so a half-written file is not loaded
			clearTimeout(timer);
			timer = setTimeout(() => restart().catch((e) => log("Restart failed:", e.message)), 300);
		});
		w.on("error", (e) => log(`Watching ${dir} failed:`, e.message));
	}
	for (const sig of ["SIGINT", "SIGTERM"]) {
		process.on(sig, () => {
			stopping = true;
			clearTimeout(timer);
			if (child) child.kill("SIGTERM");
			else process.exit(0);
		});
	}
	start();
}

async function runStandalone(args) {
	const options = {
		port: args.port ? Number(args.port) : undefined,
		dir: args["board-dir"],
		pageFile: args["page-file"],
		dryRun: args["dry-run"] || process.env.GARY_DRY_RUN === "1",
	};
	// Under --watch the previous server may still release the port for a moment
	const attempts = process.env.GARY_WATCH_CHILD === "1" ? 20 : 1;
	let board;
	for (let i = 1; !board; i++) {
		try {
			board = await startBoardServer(options);
		} catch (e) {
			if (e.code === "EADDRINUSE" && i < attempts) {
				await new Promise((r) => setTimeout(r, 250));
				continue;
			}
			console.error("[board]", e.code === "EADDRINUSE" ? "The port is already in use. Is the board running in a Claude session?" : e.message);
			process.exit(1);
		}
	}
	const stop = () => board.close().then(() => process.exit(0));
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
