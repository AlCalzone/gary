#!/usr/bin/env node
// Local board server: serves board/board.html on 127.0.0.1 for every instance under the root and runs approved actions.
// The gary MCP server starts it through startBoardServer(). `node server/server.mjs` runs it on its own.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, watch, writeSync } from "node:fs";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ACTIONS, REVIEW_EVENTS, runAction } from "../scripts/lib/actions.mjs";
import { COLLECTIONS, PROPOSAL_ID, applyWrite, docPath, idPattern, readJson, tokenFile, writeAtomic } from "../scripts/lib/board-store.mjs";
import { applyProposal, cut, logDecision } from "../scripts/lib/learning.mjs";
import { ACTION_KINDS, claimsDir, listClaims } from "../scripts/lib/claims.mjs";
import { autoReviewState, readAutoReviews } from "../scripts/lib/auto-review.mjs";
import { runApiEdit } from "../scripts/lib/api-edit.mjs";
import { sensitiveFacts, touchesSensitive } from "../scripts/lib/facts.mjs";
import { BLOCKING_FIX_STATES, driveDir, fixBlock, fixStateOf, loadFixSources, pendingAutoFixes, readSnapshotItems } from "../scripts/lib/fixes.mjs";
import { INSTANCE_NAME, ROOT, allowedRepo, instanceDir, instanceNames, instanceSettingsFiles, instancesDir, itemRef, loadInstance, rootConfig, rootStateDir, withInstance } from "../scripts/lib/config.mjs";
import { accountMode, postEscalateCommand } from "../scripts/lib/gh.mjs";
import { PAUSED_MESSAGE, isPaused } from "../scripts/lib/control.mjs";
import { checkFresh } from "../scripts/lib/guard.mjs";
import { fetchItem } from "../scripts/snapshot.mjs";
import { CHORE_ACTIONS, MOVE_MODES, actorOf, commentBody, driveRefusal, effectiveActor, formatRefusal, isApiEdit, isObject, pushRefusal, reviseRefusal, sensitiveRefusal, servedRoute, takeOverRefusal } from "../scripts/lib/routes.mjs";

const PAGE_FILE = join(ROOT, "board", "board.html");
const MAX_BODY = 256 * 1024;
const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 25000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
export const HEALTH = { ok: true, name: "gary" };
const OUTDATED = "The board is out of date, reload it.";
const UNKNOWN_INSTANCE = "Unknown instance.";
const ITEM_ID = idPattern("items");
const MAX_TEXT = 65536;
const MAX_NOTE = 1000;
const MAX_TITLE = 256;
const MAX_REASON = 500;
const MAX_RULE = 20000;
// A refresh reads GitHub, so it is limited per item and in total
const REFRESH_ITEM_MS = 20000;
const REFRESH_PER_MINUTE = 30;
export const HANDLED_VERIFIED = ["closed", "merged", "commented", "labeled", "unchanged"];
// What a bot action that ran says about the thread, for `handled.verified`
const VERIFIED_BY_ACTION = { comment: "commented", review: "commented", create_issue: "commented", close: "closed", label: "labeled" };
// The routes a pushing agent job blocks on its PR
export const PUSH_BLOCKED_TYPES = ["review", "merge", "close", "address_review", "take_over", "revise", "drive", "format"];
const PUSH_BLOCKED = (route) => PUSH_BLOCKED_TYPES.includes(route.type) || (route.type === "chore" && route.params?.action === "ready");
// The one input of the button that posts the profile's escalate command under the maintainer's login
export const ESCALATE_MODE = "escalate";
const MERGEABLE_STATES = { MERGEABLE: "mergeable", CONFLICTING: "conflicting", UNKNOWN: "unknown" };

/** Fingerprint of a drafted route. It changes when the routine rewrites the route or reviews the item again. */
export function draftHash(route, item) {
	const text = typeof route?.text === "string" ? route.text : "";
	const params = JSON.stringify(route?.params ?? {});
	const reviewedAt = typeof item?.reviewedAt === "string" ? item.reviewedAt : "";
	return createHash("sha256").update(text + "\u0000" + params + "\u0000" + reviewedAt).digest("hex").slice(0, 16);
}

function routesOf(item) {
	const stored = Array.isArray(item?.routes) ? item.routes.filter((r) => r && typeof r === "object" && typeof r.id === "string" && r.id) : [];
	return stored.map((r) => servedRoute(r, item));
}

/** The item's hint as served. It follows the title of a recommended route that is served under another type. */
function servedHint(item) {
	const stored = Array.isArray(item?.routes) ? item.routes.find((r) => r?.recommended === true) : undefined;
	if (!stored || stored.title !== item.hint) return item.hint;
	return servedRoute(stored, item).title;
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
		checkKeys(input, ["commentIds", "event"], "input");
		if (input.event !== undefined && !Object.hasOwn(REVIEW_EVENTS, input.event)) throw new Refusal(`input.event must be one of ${Object.keys(REVIEW_EVENTS).join(", ")}.`);
		const event = input.event === undefined ? {} : { event: input.event };
		const comments = Array.isArray(params.comments) ? params.comments : [];
		const known = new Set(comments.map((c) => c?.id).filter((id) => typeof id === "string"));
		if (input.commentIds === undefined) return { commentIds: [...known], ...event };
		if (!Array.isArray(input.commentIds)) throw new Refusal("input.commentIds must be an array.");
		const ids = new Set();
		for (const id of input.commentIds) {
			if (typeof id !== "string" || !known.has(id)) throw new Refusal(`input.commentIds names an unknown comment.`);
			if (ids.has(id)) throw new Refusal("input.commentIds lists a comment twice.");
			ids.add(id);
		}
		return { commentIds: [...ids], ...event };
	}

	// The card of an API edit has no switches: the route's edits are all it commits
	if (isApiEdit(route)) {
		checkKeys(input, [], "input");
		return {};
	}

	if (route.type === "address_review" || route.type === "take_over") {
		checkKeys(input, ["decisions"], "input");
		const threads = new Set((Array.isArray(item.threads) ? item.threads : []).map((t) => t?.id).filter((id) => typeof id === "string" && id));
		// A take-over without open threads sends no decisions
		if (route.type === "take_over" && input.decisions === undefined) return {};
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

	if (route.type === "move" && params.to === "issue") {
		checkKeys(input, ["mode"], "input");
		if (input.mode !== ESCALATE_MODE) throw new Refusal(`input.mode must be "${ESCALATE_MODE}".`);
		return { mode: input.mode };
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
		// Only the card that hands the fix to the agent has the switch
		checkKeys(input, route.as === "agent" ? ["title", "askReporter"] : ["title"], "input");
		if (input.askReporter !== undefined && typeof input.askReporter !== "boolean") throw new Refusal("input.askReporter must be true or false.");
		const ask = input.askReporter === undefined ? {} : { askReporter: input.askReporter };
		if (input.title === undefined) return ask;
		if (typeof input.title !== "string" || !input.title.trim() || input.title.length > MAX_TITLE) {
			throw new Refusal(`input.title must be a non-empty string of at most ${MAX_TITLE} characters.`);
		}
		return { title: input.title.trim(), ...ask };
	}

	if (route.type === "close" && answerParams(route)) {
		checkKeys(input, ["part"], "input");
		if (input.part !== undefined && input.part !== "answer") throw new Refusal('input.part must be "answer".');
		return input.part ? { part: input.part } : {};
	}

	if (route.type === "reply" || route.type === "request_logs") {
		const also = labelParams(route);
		checkKeys(input, also ? ["alsoLabel", "part"] : [], "input");
		if (input.part !== undefined && input.part !== "label") throw new Refusal('input.part must be "label".');
		if (input.alsoLabel !== undefined && typeof input.alsoLabel !== "boolean") throw new Refusal("input.alsoLabel must be true or false.");
		return { ...(input.part && { part: input.part }), ...(also && { alsoLabel: input.alsoLabel ?? true }) };
	}

	checkKeys(input, [], "input");
	return {};
}

/** The `label` params of a route's `alsoLabel`, with the empty lists left out, or null when it has none. */
export function labelParams(route) {
	if (route?.type !== "reply" && route?.type !== "request_logs") return null;
	const also = route.params?.alsoLabel;
	if (!isObject(also)) return null;
	const list = (v) => (Array.isArray(v) ? v.filter((l) => typeof l === "string" && l) : []);
	const out = { ...(list(also.add).length && { add: list(also.add) }), ...(list(also.remove).length && { remove: list(also.remove) }) };
	return Object.keys(out).length ? out : null;
}

/** The `answer_discussion` params of a discussion close route's `alsoAnswer`, or null when it has none. */
export function answerParams(route) {
	if (route?.type !== "close") return null;
	const commentId = route.params?.alsoAnswer?.commentId;
	return typeof commentId === "string" && commentId ? { commentId } : null;
}

// The second buttons a route can carry next to its prefill. Each runs one bot action with params from the route only
export const PARTS = {
	label: {
		params: labelParams,
		action: "label",
		hashField: "labelHash",
		doneField: "labelDone",
		// Labels on a closed thread make no sense. Marking an answer comes after the close
		openOnly: true,
		none: "This route sets no labels.",
		needs: "Setting the labels needs",
		duplicate: "These labels are already set. The board shows the result.",
	},
	answer: {
		params: answerParams,
		action: "answer_discussion",
		hashField: "answerHash",
		doneField: "answerDone",
		openOnly: false,
		none: "This route marks no answer.",
		needs: "Marking the answer needs",
		duplicate: "The answer is already marked. The board shows the result.",
	},
};

/** Fingerprint of a route's second button. It changes when its params change or the item is reviewed again. */
export function partHash(part, route, item) {
	const reviewedAt = typeof item?.reviewedAt === "string" ? item.reviewedAt : "";
	return createHash("sha256").update(JSON.stringify(PARTS[part].params(route)) + "\u0000" + reviewedAt).digest("hex").slice(0, 16);
}
export const labelHash = (route, item) => partHash("label", route, item);

export { commentBody };

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
			case "address_review": {
				const refusal = pushRefusal(item, "address_review");
				if (refusal) throw new Refusal(refusal);
				return { agent: true, action: "address_review", params: { decisions: chosen.decisions }, text };
			}
			case "follow_up":
				// The switch on the card decides. Without it nobody asks the reporter
				return { agent: true, action: "start_fix", params: { ...(params.finding !== undefined && { finding: params.finding }), askReporter: chosen.askReporter === true }, text };
			case "take_over": {
				const refusal = takeOverRefusal(route, item);
				if (refusal) throw new Refusal(refusal);
				return { agent: true, action: "take_over", params: { mode: params.mode ?? "push", ...(chosen.decisions && { decisions: chosen.decisions }) }, text };
			}
			case "revise": {
				const refusal = reviseRefusal(item, text);
				if (refusal) throw new Refusal(refusal);
				return { agent: true, action: "revise", params: {}, text };
			}
			case "drive": {
				const maxRounds = chosen.maxRounds ?? params.maxRounds ?? 3;
				const refusal = driveRefusal(item, maxRounds);
				if (refusal) throw new Refusal(refusal);
				return { agent: true, action: "drive", params: { maxRounds }, text };
			}
			case "format": {
				const refusal = formatRefusal(item);
				if (refusal) throw new Refusal(refusal);
				return { agent: true, action: "format", params: { reviewedSha: item.reviewedSha }, text };
			}
		}
	}

	switch (route.type) {
		case "reply":
		case "request_logs": {
			const labels = chosen.alsoLabel ? labelParams(route) : null;
			return { steps: [{ action: "comment", params: {}, text }], guard: { action: "comment", params: {} }, ...(labels && { labelAfter: labels }) };
		}
		case "review": {
			const comments = (Array.isArray(params.comments) ? params.comments : [])
				.filter((c) => chosen.commentIds.includes(c.id))
				.map((c) => ({ path: c.path, line: c.line, ...(c.startLine !== undefined && { startLine: c.startLine }), text: commentBody(c) }));
			const event = chosen.event ?? params.event;
			const reviewParams = { event, ...(comments.length && { comments }) };
			if (!Object.hasOwn(REVIEW_EVENTS, event ?? "")) throw new Refusal("The review route has no valid event.");
			const suggests = (Array.isArray(params.comments) ? params.comments : []).some((c) => chosen.commentIds.includes(c.id) && typeof c.suggestion === "string");
			if (event === "approve" && suggests) throw new Refusal("An approval cannot carry suggestions. Uncheck them, or submit the review as a change request or a comment.");
			if (typeof item.reviewedSha === "string") reviewParams.sha = item.reviewedSha;
			return { steps: [{ action: "review", params: reviewParams, text }], guard: { action: "review", params: reviewParams } };
		}
		case "reopen":
			return { steps: [{ action: "reopen", params: {}, text }], guard: { action: "reopen", params: {} } };
		case "take_over":
		case "revise": {
			// Only the API edit of these types runs on the server. `text` is the note for the contributor
			const refusal = route.type === "take_over" ? takeOverRefusal(route, item) : reviseRefusal(item, text, route);
			if (refusal) throw new Refusal(refusal);
			return { apiEdit: true, action: route.type, params, text };
		}
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

/** The instances the board server on `url` serves, or null when no board server answers there. */
export async function boardInstances(url) {
	try {
		const res = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(2000) });
		const body = await res.json();
		return res.status === 200 && body?.name === HEALTH.name && Array.isArray(body.instances) ? body.instances : null;
	} catch {
		return null;
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

const account = (login) => (login ? { login, avatarUrl: `https://github.com/${encodeURIComponent(login)}.png?size=80` } : null);

/**
 * The instance with its account mode, and `error` and `warnings` about its settings files.
 * While `error` is set, the library serves the last valid settings. `instance` is null when they were never valid.
 */
export function settingsOf(name) {
	try {
		const instance = loadInstance(name);
		return { instance, mode: withInstance(name, accountMode), error: instance.settingsError, warnings: instance.settingsWarnings };
	} catch (e) {
		return { instance: null, mode: null, error: e.message };
	}
}

/** What the page needs to name one instance's project and accounts without hard-coding them. */
export function instanceInfo(name) {
	const { instance: i, mode, error, warnings } = settingsOf(name);
	const paused = isPaused(join(instanceDir(name), "state"));
	if (!i) {
		return { name, title: name, kind: null, repos: [], repoUrl: null, me: null, bot: null, accountMode: "none", paused, relatedRepos: [], botCommands: {}, escalateAs: "prefill", reviewBots: [], settingsError: error };
	}
	return {
		name,
		title: i.title,
		kind: i.kind,
		repos: i.repos,
		repoUrl: `https://github.com/${i.repos[0]}`,
		me: account(i.config.me),
		bot: account(i.config.bot?.login),
		accountMode: mode ?? "none",
		paused,
		relatedRepos: i.profile.relatedRepos,
		botCommands: i.profile.botCommands,
		escalateAs: i.config.escalateAs,
		reviewBots: i.profile.reviewBots,
		...(error && { settingsError: error }),
		...(warnings?.length && { settingsWarnings: warnings }),
	};
}

/** The board object of /api/state: the maintainer, dry-run mode and one entry per instance. */
export function boardInfo(names, { dryRun = false, log = () => {} } = {}) {
	const instances = names.flatMap((name) => {
		try {
			return [instanceInfo(name)];
		} catch (e) {
			log(`Reading instance ${name} failed:`, e.message);
			return [];
		}
	});
	return { me: instances.find((i) => i.me)?.me ?? null, dryRun, instances };
}

function shim(token, info, version) {
	return `<script>
"use strict";
(() => {
  const TOKEN = ${JSON.stringify(token).replace(/</g, "\\u003c")};
  const VERSION = ${JSON.stringify(version)};
  const MIN_RETRY_MS = 2000;
  const MAX_RETRY_MS = 30000;
  const INFO = ${JSON.stringify(info).replace(/</g, "\\u003c")};
  const SERVER = "host:gary";
  const NAMES = ["items", "actions", "proposals"];
  // Per collection: instance name -> that instance's docs, as the server sent them last
  const cache = { items: new Map(), actions: new Map(), proposals: new Map(), meta: new Map() };
  const subs = { items: new Set(), actions: new Set(), proposals: new Set(), meta: new Set() };
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
  const names = () => board.instances.map((i) => i.name);
  // A collection is ready once every served instance sent it, so the first snapshot holds all of them
  const ready = (name) => names().every((n) => cache[name].has(n));
  const docsOf = (name) => names().flatMap((n) => (cache[name].get(n) || []).map((d) => ({ id: n + "/" + d.id, data: d })));
  const collectionSnap = (docs) => ({
    docs: docs.map((d) => ({ id: d.id, data: () => clone(d.data) })),
    metadata: { fromCache: false },
  });
  const docSnap = (v) => ({ exists: v != null, data: () => clone(v), metadata: { fromCache: false } });

  function emit(name) {
    for (const s of subs[name]) s();
  }

  // Splits a key like "widgets/pr-12" into its instance and id, for pages that pass the collection key
  function scoped(input) {
    const out = { ...(input || {}) };
    if (out.instance === undefined && typeof out.itemId === "string" && out.itemId.includes("/")) {
      const at = out.itemId.indexOf("/");
      out.instance = out.itemId.slice(0, at);
      out.itemId = out.itemId.slice(at + 1);
    }
    return out;
  }

  const askReload = () => window.dispatchEvent(new Event("board:reload"));

  function applyBoard(next) {
    Object.assign(board, next);
    const served = new Set(names());
    for (const name of [...NAMES, "meta"]) {
      for (const n of [...cache[name].keys()]) if (!served.has(n)) cache[name].delete(n);
    }
    window.dispatchEvent(new Event("board:info"));
    for (const name of [...NAMES, "meta"]) emit(name);
  }

  // Puts a fresh /api/state into the collections it covers, so nothing that changed while disconnected is missed
  function replay(state) {
    applyBoard(state.board);
    for (const name of ["items", "proposals"]) {
      const by = new Map(names().map((n) => [n, []]));
      for (const d of state[name] || []) if (by.has(d.instance)) by.get(d.instance).push(d);
      for (const [n, docs] of by) cache[name].set(n, docs);
      emit(name);
    }
  }

  let es = null;
  let delay = MIN_RETRY_MS;

  // A browser's EventSource gives up for good after an HTTP error, so the shim reconnects on its own
  function retry() {
    if (es) es.close();
    es = null;
    setConnected(false);
    const wait = delay;
    delay = Math.min(delay * 2, MAX_RETRY_MS);
    setTimeout(reconnect, wait);
  }

  async function reconnect() {
    let r;
    try {
      r = await api("/api/state");
    } catch {
      return retry();
    }
    // The server restarted with a new token, and only a reload of the page gets it
    if (r.status === 401) askReload();
    if (r.status !== 200 || !r.data) return retry();
    replay(r.data);
    connect();
  }

  function connect() {
    const source = new EventSource("/api/events?token=" + encodeURIComponent(TOKEN));
    es = source;
    source.addEventListener("hello", (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg && msg.version !== VERSION) askReload();
    });
    for (const name of NAMES) {
      source.addEventListener(name, (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (!msg || typeof msg.instance !== "string" || !Array.isArray(msg.docs)) return;
        cache[name].set(msg.instance, msg.docs);
        emit(name);
      });
    }
    source.addEventListener("meta", (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg.instance !== "string") return;
      cache.meta.set(msg.instance, msg.data);
      emit("meta");
    });
    source.addEventListener("board", (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg && msg.board) applyBoard(msg.board);
    });
    source.addEventListener("open", () => {
      delay = MIN_RETRY_MS;
      setConnected(true);
    });
    source.addEventListener("error", () => {
      if (source === es) retry();
    });
    // board.html decides whether it can reload right away
    source.addEventListener("reload", askReload);
  }

  function query(name) {
    let order = null;
    let max = Infinity;
    const q = {
      orderBy(field, dir) { order = [field, dir === "desc" ? -1 : 1]; return q; },
      limit(n) { max = n; return q; },
      onSnapshot(cb) {
        const fire = () => {
          if (!ready(name)) return;
          let docs = docsOf(name);
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
    collection(name) {
      if (!NAMES.includes(name)) throw Object.assign(new Error("Unknown collection " + name), { code: "not_found" });
      return query(name);
    },
    // Paths are "items/<instance>/<id>", "actions/<instance>/<id>" and "meta/<instance>"
    doc(path) {
      return {
        onSnapshot(cb) {
          const m = /^meta\\/([^/]+)$/.exec(path);
          if (!m) return () => {};
          const fire = () => { if (cache.meta.has(m[1])) cb(docSnap(cache.meta.get(m[1]))); };
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
      const { instance, ...rest } = scoped(input);
      let r;
      try {
        r = await api("/api/action", { instance, action: tool, ...rest });
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

  // Board-only helper of the local server: the maintainer, dry-run mode and the instances
  const board = {
    ...INFO,
    // Reports the use of a route he does on GitHub himself, for the decision log. Failures stay quiet
    async decision(body) {
      try { await api("/api/decision", scoped(body)); } catch { /* the log entry is lost, nothing else */ }
    },
    // Reads one item's live state from GitHub. Answers { ok, result } or, when asked too often, { ok: false, retryAfter }
    async refresh(body) {
      const r = await api("/api/refresh", scoped(body));
      return r.data ?? { ok: false, result: "The board server failed." };
    },
  };

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

/** Fingerprint of the served page: the page file and the shim code. A page that loaded another version reloads. */
export function pageVersion(pageText) {
	return createHash("sha256").update(pageText + "\u0000" + shim.toString()).digest("hex").slice(0, 16);
}

const RESET = `<style>
*, *::before, *::after { box-sizing: border-box; }
:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>`;

// A page write names the instance in its path, like "items/widgets/pr-12". `gary put` names it in the body
const SCOPED_PATH = /^(items|actions|proposals)\/([^/]+)\/([^/]+)$/;
const SCOPED_META = /^meta\/([^/]+)$/;

/**
 * Starts the board server on 127.0.0.1 for every instance under the root and resolves once it listens.
 * Rejects with the listen error, like EADDRINUSE when another process holds the port.
 * With `keepAlive: false` the server never keeps the process running on its own.
 */
export async function startBoardServer({
	port = rootConfig().port,
	dryRun = process.env.GARY_DRY_RUN === "1",
	keepAlive = true,
	pageFile = PAGE_FILE,
	log: print = (...a) => console.error("[board]", ...a),
} = {}) {
	if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid port ${port}`);
	mkdirSync(instancesDir(), { recursive: true });
	mkdirSync(rootStateDir(), { recursive: true });
	const TOKEN = loadToken(tokenFile());
	const logFile = join(rootStateDir(), "server.log");
	const log = (...a) => {
		print(...a);
		appendFile(logFile, `${new Date().toISOString()} ${a.map((x) => (typeof x === "string" ? x : String(x?.stack ?? x))).join(" ")}\n`).catch(() => {});
	};
	const ORIGINS = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
	const HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	const url = `http://127.0.0.1:${port}/`;

	const clients = new Set();
	const pending = new Map();
	const docLocks = new Map();
	// Run GitHub actions one at a time per item of an instance, so a double click cannot merge twice
	const actionLocks = new Map();
	// The served instances: name -> { board, state, watchers }
	const served = new Map();
	// Watchers on <root>/instances and on each directory in it, which see a config.json appear
	const rootWatchers = new Map();
	// Instances whose config.json or profile.json changed since the last rescan
	const settingsChanged = new Set();
	let closed = false;
	// Routes that ran in this process, so a repeat is refused even before the action file lands
	const doneKeys = new Set();
	// Guard refusals per route, so the page can offer "Post anyway" where force is allowed
	const refusals = new Map();
	// Thread state from the latest guard read per item, so the page can show a thread that closed since the review
	const liveStates = new Map();

	const names = () => [...served.keys()].sort();
	const boardNow = () => boardInfo(names(), { dryRun, log });

	async function readCollection(name, collection) {
		const d = join(served.get(name).board, collection);
		let files = [];
		try {
			files = await readdir(d);
		} catch (e) {
			if (e.code !== "ENOENT") throw e;
		}
		const docs = await Promise.all(files.filter((n) => n.endsWith(".json") && !n.startsWith(".")).map(async (n) => {
			const id = n.slice(0, -5);
			const data = idPattern(collection).test(id) ? await readJson(join(d, n)) : null;
			return data ? { id, data } : null;
		}));
		return docs.filter(Boolean);
	}

	// Clicks that ran or were queued, keyed by item, route and draft
	function clickedByKey(name, actions) {
		const out = new Map();
		for (const { data: a } of actions) {
			if ((a.status !== "done" && a.status !== "queued") || typeof a.routeId !== "string" || typeof a.draftHash !== "string") continue;
			out.set(`${name}|${a.itemId}|${a.routeId}|${a.draftHash}`, {
				status: a.status,
				result: typeof a.result === "string" ? a.result : "",
				finishedAt: a.finishedAt ?? a.createdAt ?? null,
				via: a.via ?? null,
			});
		}
		return out;
	}

	// The label buttons that ran, keyed by item, route and label hash. Failed ones are served too
	function partsByKey(name, actions, part) {
		const out = new Map();
		const field = PARTS[part].hashField;
		const sorted = actions.map((a) => a.data).filter((a) => a.part === part && typeof a.routeId === "string" && typeof a[field] === "string").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
		for (const a of sorted) {
			out.set(`${name}|${a.itemId}|${a.routeId}|${a[field]}`, { status: a.status, result: typeof a.result === "string" ? a.result : "" });
		}
		return out;
	}

	const modeOf = (name) => settingsOf(name).mode ?? "none";

	/**
	 * The agent work in progress per item: unexpired claims, queued or claimed agent requests, and drives that wait
	 * for a review bot between rounds. Each entry is `{ itemId, kind, action, since }`.
	 */
	async function workList(name, actions) {
		const out = [];
		for (const c of await listClaims({ instance: name })) if (!c.expired) out.push({ itemId: c.itemId, kind: c.kind, action: null, since: c.at });
		for (const { data: a } of actions) {
			const kind = ACTION_KINDS[a.action];
			if (kind && a.status === "queued" && typeof a.itemId === "string") out.push({ itemId: a.itemId, kind, action: a.action, since: a.createdAt ?? null });
		}
		const driveDir = join(served.get(name).state, "drive");
		let names = [];
		try {
			names = readdirSync(driveDir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
		} catch {
			// No drive waits
		}
		for (const n of names) {
			const itemId = n.slice(0, -".json".length);
			if (!ITEM_ID.test(itemId)) continue;
			const d = await readJson(join(driveDir, n));
			if (d) out.push({ itemId, kind: "push", action: "drive", since: d.reviewRequestedAt ?? d.startedAt ?? null });
		}
		return out;
	}

	/** The work of `kind` in progress on the item, or undefined. */
	async function busyWith(name, itemId, kind) {
		return (await workList(name, await readCollection(name, "actions"))).find((w) => w.itemId === itemId && w.kind === kind);
	}

	/** Per item, the work in progress to serve as `item.working`: push work first, then the oldest. */
	async function workingByItem(name, actions) {
		const out = new Map();
		for (const w of await workList(name, actions)) {
			const cur = out.get(w.itemId);
			const better = !cur || (w.kind === "push" && cur.kind !== "push") || (w.kind === cur.kind && String(w.since) < String(cur.since));
			if (better) out.set(w.itemId, { kind: w.kind, ...(w.action && { action: w.action }), since: w.since });
		}
		return out;
	}

	// Serve each route with its draft hash and whether it already ran, so the page can bind clicks to drafts
	async function readItems(name) {
		const { instance, mode: current } = settingsOf(name);
		// An instance that was never valid has no repo to check its items against
		if (!instance) return [];
		const mode = current ?? "none";
		const [items, actions] = await Promise.all([readCollection(name, "items"), readCollection(name, "actions")]);
		const clicked = clickedByKey(name, actions);
		const partDone = Object.fromEntries(Object.keys(PARTS).map((p) => [p, partsByKey(name, actions, p)]));
		const working = await workingByItem(name, actions);
		const opened = await readOpened(name);
		const fixSources = await withInstance(name, () => loadFixSources(name));
		const autoFixes = { pending: pendingAutoFixes(fixSources), max: instance.config.maxPendingAutoFixes };
		const fixOf = (id, data) => {
			const fix = data.kind === "issue" || data.kind === "discussion" ? fixStateOf(id, fixSources) : null;
			// A pending fix of the routine counts toward its limit, so the page can show "N of 10"
			return fix && fix.startedBy === "routine" && BLOCKING_FIX_STATES.includes(fix.state) ? { ...fix, limit: autoFixes } : fix;
		};
		const autoReviews = await readAutoReviews(name);
		const autoReviewOf = (id, data) => (data.kind === "pr" ? autoReviewState(data, autoReviews[id], fixSources.snapshot[id]) : null);
		const categoryOf = (id, data) => (data.kind === "discussion" && typeof data.category !== "string" ? fixSources.snapshot[id]?.category : undefined);
		// The changed files of a PR that match the profile's sensitivePaths, so the dialog can say why nothing pushes to it
		const sensitiveOf = (id, data) => {
			const { sensitiveFiles: files, sensitiveFileCount: total } = data.kind === "pr" ? sensitiveFacts(fixSources.snapshot[id]) : {};
			return files ? { files, total } : null;
		};
		return items.map(({ id, data }) => ({
			...data,
			...(sensitiveOf(id, data) && { sensitive: sensitiveOf(id, data) }),
			// An item written before the routine copied the category gets it from the snapshot
			...(typeof categoryOf(id, data) === "string" && { category: categoryOf(id, data) }),
			liveState: liveStates.get(`${name}/${id}`),
			...(autoReviewOf(id, data) && { autoReview: autoReviewOf(id, data) }),
			...(working.has(id) && { working: working.get(id) }),
			...(fixOf(id, data) && { fix: fixOf(id, data) }),
			...(typeof data.hint === "string" && { hint: servedHint(data) }),
			routes: routesOf(data).map((route) => {
				const hash = draftHash(route, data);
				const key = `${name}|${id}|${route.id}|${hash}`;
				const ran = clicked.get(key) ?? (doneKeys.has(key) ? { status: "done", result: "", finishedAt: null } : undefined);
				const parts = {};
				for (const [p, def] of Object.entries(PARTS)) {
					const done = def.params(route) ? partDone[p].get(`${name}|${id}|${route.id}|${partHash(p, route, data)}`) : undefined;
					if (done) parts[def.doneField] = done;
				}
				// Serve the mark only for the draft he used
				const mark = opened[id]?.[route.id];
				const used = mark?.draftHash === hash && typeof mark.at === "string" ? { opened: { at: mark.at } } : {};
				return { ...route, ...servedActor(route, mode), draftHash: hash, done: ran, refused: ran ? undefined : refusals.get(key), ...used, ...parts };
			}),
			instance: name,
			id,
			ref: typeof data.repo === "string" ? itemRef(data) : null,
			repo: data.repo ?? null,
		}));
	}

	const flat = (name, docs) => docs.map(({ id, data }) => ({ ...data, instance: name, id }));
	const readActions = async (name) => flat(name, await readCollection(name, "actions"));
	const readOpenProposals = async (name) => (!settingsOf(name).instance ? [] : flat(name, (await readCollection(name, "proposals")).filter((p) => p.data.status === "open")));
	const readMeta = (name) => readJson(join(served.get(name).board, "meta.json"));
	const readers = { items: readItems, actions: readActions, proposals: readOpenProposals };

	async function eventOf(name, event) {
		if (event === "meta") return { instance: name, data: await readMeta(name) };
		return { instance: name, docs: await readers[event](name) };
	}

	const decide = (name, type, itemId, item, fields) =>
		logDecision(name, type, itemId, item, fields).catch((e) => log(`Writing the decision log of ${name} failed:`, e.message));

	function send(res, event, data) {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}

	/** Pushes one event to every open page. `name` is the instance, or null for the board and a page reload. */
	function schedulePush(name, event) {
		const key = `${name ?? ""}\u0000${event}`;
		clearTimeout(pending.get(key));
		const t = setTimeout(async () => {
			pending.delete(key);
			if (!clients.size) return;
			try {
				let data;
				if (event === "reload") data = { instance: null };
				else if (event === "board") data = { instance: name, board: boardNow() };
				else if (!served.has(name)) return;
				else data = await eventOf(name, event);
				for (const res of clients) send(res, event, data);
			} catch (e) {
				log(`Reading ${event} of ${name} failed:`, e.message);
			}
		}, DEBOUNCE_MS);
		t.unref();
		pending.set(key, t);
	}

	function addWatch(list, path, fn) {
		try {
			const w = watch(path, fn);
			w.on("error", (e) => log(`Watching ${path} failed:`, e.message));
			if (!keepAlive) w.unref();
			list.push(w);
		} catch (e) {
			log(`Watching ${path} failed:`, e.message);
		}
	}

	// Watch the directories of the instance's config.json and profile.json, because editors replace files by rename
	function watchSettings(name) {
		const entry = served.get(name);
		const files = instanceSettingsFiles(name);
		const key = files.join("\u0000");
		if (entry.settings?.key === key) return;
		for (const w of entry.settings?.watchers ?? []) w.close();
		const watchers = [];
		for (const file of files) {
			addWatch(watchers, dirname(file), (_type, changed) => {
				if (changed !== basename(file)) return;
				settingsChanged.add(name);
				scheduleRescan();
			});
		}
		entry.settings = { key, watchers };
	}

	function serve(name) {
		const state = join(instanceDir(name), "state");
		const i = { board: join(state, "board"), state };
		for (const c of COLLECTIONS) mkdirSync(join(i.board, c), { recursive: true });
		const entry = { board: i.board, state: i.state, watchers: [], settings: null };
		served.set(name, entry);
		const w = entry.watchers;
		addWatch(w, join(i.board, "items"), () => schedulePush(name, "items"));
		addWatch(w, join(i.board, "proposals"), () => schedulePush(name, "proposals"));
		// Action docs mark routes as done, so they change the served items too
		addWatch(w, join(i.board, "actions"), () => {
			schedulePush(name, "actions");
			schedulePush(name, "items");
		});
		addWatch(w, i.board, (_type, file) => {
			if (file === "meta.json") schedulePush(name, "meta");
		});
		// gary pause and resume change control.json, and open pages show the switch at once
		addWatch(w, i.state, (_type, file) => {
			if (file === "control.json") schedulePush(name, "board");
			// A recorded fix PR, its ready mark and a new snapshot change item.fix
			// An automatic review and the answer to its format offer change item.autoReview
			if (file === "fixes.json" || file === "auto-reviews.json" || file === "snapshot.json" || file === "snapshot.pending.json") schedulePush(name, "items");
		});
		// A round of a drive changes item.working and the stage of item.fix
		mkdirSync(driveDir(name), { recursive: true });
		addWatch(w, driveDir(name), () => schedulePush(name, "items"));
		// A claim taken or released changes item.working
		mkdirSync(claimsDir(name), { recursive: true });
		addWatch(w, claimsDir(name), () => schedulePush(name, "items"));
		watchSettings(name);
		const { instance, error } = settingsOf(name);
		entry.settingsError = error;
		log(`Serving instance ${name}${instance ? ` (${instance.repos.join(", ")})` : ""}.${error ? ` Its settings are invalid: ${error}` : ""}`);
	}

	function unserve(name) {
		for (const w of [...served.get(name).watchers, ...(served.get(name).settings?.watchers ?? [])]) w.close();
		served.delete(name);
		log(`Stopped serving instance ${name}.`);
	}

	/** Matches the served instances to the instances under the root. Returns whether the list changed. */
	function rescan() {
		if (closed) return false;
		let dirs = [];
		try {
			dirs = readdirSync(instancesDir(), { withFileTypes: true }).filter((d) => d.isDirectory() && INSTANCE_NAME.test(d.name)).map((d) => d.name);
		} catch (e) {
			log(`Reading ${instancesDir()} failed:`, e.message);
		}
		for (const [dir, w] of rootWatchers) {
			if (dir !== "" && !dirs.includes(dir)) {
				w.close();
				rootWatchers.delete(dir);
			}
		}
		for (const dir of dirs) {
			if (rootWatchers.has(dir)) continue;
			const list = [];
			addWatch(list, join(instancesDir(), dir), (_type, file) => {
				if (file === "config.json") scheduleRescan();
			});
			if (list[0]) rootWatchers.set(dir, list[0]);
		}
		const wanted = new Set(instanceNames());
		const changed = [];
		for (const name of [...served.keys()]) {
			if (!wanted.has(name)) {
				unserve(name);
				changed.push(name);
			}
		}
		for (const name of wanted) {
			if (served.has(name)) continue;
			try {
				serve(name);
				changed.push(name);
			} catch (e) {
				log(`Serving instance ${name} failed:`, e.message);
			}
		}
		// A rescan runs before the board event, so the event never lists an instance that is gone
		for (const name of settingsChanged) {
			if (!served.has(name) || changed.includes(name)) continue;
			const { error } = settingsOf(name);
			if (error !== served.get(name).settingsError) log(error ? `The settings of ${name} are invalid, it keeps its last valid ones: ${error}` : `The settings of ${name} are valid again.`);
			served.get(name).settingsError = error;
			// A config edit can point the instance to another profile
			watchSettings(name);
			schedulePush(name, "board");
		}
		settingsChanged.clear();
		for (const name of changed) {
			schedulePush(name, "board");
			for (const event of ["items", "actions", "proposals", "meta"]) {
				// A removed instance gets empty collections, so open pages drop its docs
				if (served.has(name)) schedulePush(name, event);
				else for (const res of clients) send(res, event, event === "meta" ? { instance: name, data: null } : { instance: name, docs: [] });
			}
		}
		return changed.length > 0;
	}

	let rescanTimer = null;
	function scheduleRescan() {
		clearTimeout(rescanTimer);
		rescanTimer = setTimeout(rescan, DEBOUNCE_MS);
		rescanTimer.unref();
	}

	/** The served instance a request names, or null. A name the watcher has not seen yet triggers one rescan. */
	function instanceOf(name) {
		if (typeof name !== "string" || !INSTANCE_NAME.test(name)) return null;
		if (!served.has(name)) rescan();
		return served.has(name) ? name : null;
	}

	const pageWatchers = [];
	function startWatching() {
		const list = [];
		addWatch(list, instancesDir(), () => scheduleRescan());
		if (list[0]) rootWatchers.set("", list[0]);
		rescan();
		// Open pages reload themselves when the board page changes
		addWatch(pageWatchers, dirname(pageFile), (_type, name) => {
			if (name === basename(pageFile)) schedulePush(null, "reload");
		});
	}

	function stopWatching() {
		clearTimeout(rescanTimer);
		for (const w of pageWatchers) w.close();
		pageWatchers.length = 0;
		for (const w of rootWatchers.values()) w.close();
		rootWatchers.clear();
		for (const name of [...served.keys()]) {
			for (const w of [...served.get(name).watchers, ...(served.get(name).settings?.watchers ?? [])]) w.close();
			served.delete(name);
		}
	}

	const heartbeat = setInterval(() => {
		for (const res of clients) res.write(": keepalive\n\n");
	}, HEARTBEAT_MS);
	heartbeat.unref();

	async function logClick(name, itemId, doc) {
		const dir = join(served.get(name).board, "actions");
		let id = `${itemId}-${Date.now()}`;
		while (await readJson(join(dir, id + ".json"))) id = `${itemId}-${Date.now() + 1}`;
		const file = join(dir, id + ".json");
		await withLock(docLocks, file, () => writeAtomic(file, { itemId, ...doc }));
		schedulePush(name, "actions");
		schedulePush(name, "items");
		return id;
	}

	const itemFile = (name, itemId) => join(served.get(name).board, "items", itemId + ".json");

	// The `as: "me"` buttons he used: `{ <itemId>: { <routeId>: { at, draftHash, text } } }`
	const openedFile = (name) => join(served.get(name).state, "opened.json");
	const readOpened = async (name) => {
		const data = await readJson(openedFile(name));
		return isObject(data) ? data : {};
	};

	/** Records that he used the prefill button of `route` with `text`. Drops the item's marks for drafts that are gone. */
	async function markOpened(name, itemId, item, route, text) {
		const file = openedFile(name);
		await withLock(docLocks, file, async () => {
			const all = await readOpened(name);
			const hashes = new Map(routesOf(item).map((r) => [r.id, draftHash(r, item)]));
			const kept = Object.entries(isObject(all[itemId]) ? all[itemId] : {}).filter(([id, o]) => hashes.get(id) === o?.draftHash);
			await writeAtomic(file, { ...all, [itemId]: { ...Object.fromEntries(kept), [route.id]: { at: new Date().toISOString(), draftHash: hashes.get(route.id), text } } });
		});
		schedulePush(name, "items");
	}

	// Run only what the agent drafted: type, actor, params and the target come from the item file
	async function handleAction(body) {
		const name = instanceOf(body.instance);
		if (!name) return [400, { ok: false, result: UNKNOWN_INSTANCE }];
		if (body.action === "dismiss_route") return handleDismissRoute(name, body);
		if (body.action === "accept_proposal" || body.action === "dismiss_proposal") return handleProposal(name, body);
		const { error: settingsError } = settingsOf(name);
		if (settingsError) return [200, { ok: false, result: `The settings of ${name} are invalid, so nothing was sent. ${settingsError}`, settingsError }];
		const { itemId, routeId, text, force, input } = body;
		if (isObject(input) && input.part !== undefined) return handlePart(name, body);
		const outdated = [200, { ok: false, result: OUTDATED, outdated: true }];
		if (typeof itemId !== "string" || !ITEM_ID.test(itemId) || typeof routeId !== "string") return outdated;
		if (text !== undefined && (typeof text !== "string" || text.length > MAX_TEXT)) {
			return [400, { ok: false, result: `text must be a string of at most ${MAX_TEXT} characters.` }];
		}
		return withLock(actionLocks, `${name}/${itemId}`, async () => {
			const item = await readJson(itemFile(name, itemId));
			const route = item && routesOf(item).find((r) => r.id === routeId);
			if (!route) return outdated;
			if (!allowedRepo(name, item.repo)) {
				return [200, { ok: false, result: typeof item.repo === "string" ? `${item.repo} is not a repository of instance ${name}. Nothing was sent.` : "The item names no repository. Nothing was sent." }];
			}
			const hash = draftHash(route, item);
			if (body.draftHash !== hash) return outdated;

			const key = `${name}|${itemId}|${routeId}|${hash}`;
			if (doneKeys.has(key) || clickedByKey(name, await readCollection(name, "actions")).has(key)) {
				return [409, { ok: false, result: "This route already ran. The board shows its result.", duplicate: true }];
			}

			// No second fix while one runs or its PR is a draft or open, also when the item file still offers one
			if (route.type === "follow_up" && route.as === "agent" && (item.kind === "issue" || item.kind === "discussion")) {
				const block = fixBlock(fixStateOf(itemId, await withInstance(name, () => loadFixSources(name))));
				if (block) return [409, { ok: false, result: block, fixRunning: true }];
			}
			// While the agent pushes to the PR, nothing may decide it on its current state
			if (PUSH_BLOCKED(route) && (await busyWith(name, itemId, "push"))) {
				return [409, { ok: false, result: "The agent is changing this PR. Decide after it is done.", working: true }];
			}

			if (route.type === "move" && route.params?.to === "issue") return handleEscalate(name, itemId, item, route, body, key, hash);

			// A PR with sensitive files gets no agent in its checkout, also when the item file still offers one
			if (item.kind === "pr") {
				const snapshot = await withInstance(name, () => readSnapshotItems());
				const refusal = sensitiveRefusal(route, touchesSensitive(snapshot[itemId]));
				if (refusal) return [200, { ok: false, result: refusal, sensitive: true }];
			}

			const draft = typeof text === "string" ? text : typeof route.text === "string" ? route.text : "";
			let plan;
			try {
				plan = planRoute(route, item, input, draft, modeOf(name));
			} catch (e) {
				if (e instanceof Refusal) return [200, { ok: false, result: e.message }];
				throw e;
			}
			const { kind, number, repo } = item;
			const entry = {
				routeId,
				route: route.type,
				draftHash: hash,
				edited: draft !== (route.text ?? ""),
				createdAt: new Date().toISOString(),
			};

			if (plan.agent) {
				const kind = ACTION_KINDS[plan.action];
				if (kind && (await busyWith(name, itemId, kind))) {
					return [409, { ok: false, result: "The agent is already working on this.", working: true }];
				}
				logRouteDecisions(name, itemId, item, route, draft, input, true);
				await logClick(name, itemId, {
					...entry,
					action: plan.action,
					params: plan.params,
					text: plan.text,
					status: "queued",
					via: "queue",
					finishedAt: null,
					result: "",
				});
				doneKeys.add(key);
				await setHandled(name, itemId, route, null);
				return [200, { ok: true, result: "Queued for the master session.", queued: true }];
			}

			if (isPaused(served.get(name).state)) return [200, { ok: false, result: PAUSED_MESSAGE, paused: true }];
			if (plan.apiEdit) return handleApiEdit(name, itemId, item, route, plan, entry, key, body);

			// The server never merges
			if (plan.steps.some((s) => s.action === "merge" || !Object.hasOwn(ACTIONS, s.action))) {
				return [200, { ok: false, result: "Merges happen on GitHub. The board only opens the PR for you." }];
			}

			const fresh = await checkFresh({ instance: name, ...plan.guard, kind, number, item, force: force === true });
			if (fresh.state) {
				liveStates.set(`${name}/${itemId}`, { state: fresh.state, reason: fresh.stateReason ?? null });
				schedulePush(name, "items");
			}
			if (!fresh.ok) {
				refusals.set(key, { reason: fresh.reason, forceable: fresh.forceable });
				schedulePush(name, "items");
				return [200, { ok: false, result: fresh.reason, stale: true, forceable: fresh.forceable }];
			}

			logRouteDecisions(name, itemId, item, route, draft, input, false);
			const [first] = plan.steps;
			let outcome = await runAction({ instance: name, repo, ...first, kind, number, dryRun });
			let labelRun = null;
			if (outcome.ok && plan.labelAfter) {
				const label = await runAction({ instance: name, repo, action: "label", params: plan.labelAfter, kind, number, dryRun });
				labelRun = { params: plan.labelAfter, status: label.ok ? "done" : "failed", result: typeof label.result === "string" ? label.result : JSON.stringify(label.result) };
				if (!label.ok) {
					// The post went out, so the click counts as done and a repeat cannot post twice
					outcome = { ...outcome, warning: `Posted. The label could not be set: ${label.result}` };
				} else if (dryRun) {
					outcome = { ok: true, result: { dryRun: true, invocations: [...outcome.result.invocations, ...(label.result?.invocations ?? [])] } };
				}
			}
			if (outcome.ok && plan.followUp) {
				const issueUrl = dryRun ? null : outcome.result;
				const issueNumber = /\/issues\/(\d+)$/.exec(issueUrl ?? "")?.[1];
				const link = await runAction({
					instance: name,
					repo,
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

			await logClick(name, itemId, {
				...entry,
				action: first.action,
				params: first.params,
				text: first.text,
				status: outcome.ok ? "done" : "failed",
				via: "server",
				finishedAt: new Date().toISOString(),
				result: typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result),
				...(labelRun && { label: labelRun }),
			});
			if (outcome.ok) {
				doneKeys.add(key);
				refusals.delete(key);
				await setHandled(name, itemId, route, VERIFIED_BY_ACTION[first.action] ?? null);
			}
			schedulePush(name, "items");
			return [200, outcome];
		});
	}

	/**
	 * Runs the escalate button of a `move` to `issue` route: posts the profile's escalate command on the discussion
	 * under the maintainer's own login. Call it inside the item's action lock, after the draft and repeat checks.
	 * The text never comes from the request or the item.
	 */
	async function handleEscalate(name, itemId, item, route, body, key, hash) {
		const refuse = (result, extra = {}) => [200, { ok: false, result, ...extra }];
		const { instance } = settingsOf(name);
		if (item.kind !== "discussion") return refuse("Only a discussion can become an issue.");
		const command = instance.profile.botCommands?.escalate;
		if (typeof command !== "string" || !command.trim()) return refuse("The profile has no escalate command, so there is nothing to post.");
		if (instance.config.escalateAs !== "me") {
			return refuse('This route is yours to do on GitHub. The board only copies the command and opens the discussion. With "escalateAs": "me" in config.json the board posts the command under your login.');
		}
		try {
			validateInput(route, item, body.input);
		} catch (e) {
			if (e instanceof Refusal) return refuse(e.message);
			throw e;
		}
		if (typeof body.text === "string" && body.text.trim()) return refuse("The escalate button sends no text. It posts only the command from the profile.");
		if (isPaused(served.get(name).state)) return refuse(PAUSED_MESSAGE, { paused: true });

		const { number, repo } = item;
		const fresh = await checkFresh({ instance: name, action: "comment", params: {}, kind: "discussion", number, item, force: body.force === true });
		if (fresh.state) {
			liveStates.set(`${name}/${itemId}`, { state: fresh.state, reason: fresh.stateReason ?? null });
			schedulePush(name, "items");
		}
		// "Post anyway" never applies to a closed discussion
		if (fresh.state && fresh.state !== "OPEN") return refuse(`Discussion #${number} is closed. Nothing was posted.`, { stale: true, forceable: false });
		if (!fresh.ok) {
			refusals.set(key, { reason: fresh.reason, forceable: fresh.forceable });
			schedulePush(name, "items");
			return refuse(fresh.reason, { stale: true, forceable: fresh.forceable });
		}

		const createdAt = new Date().toISOString();
		let outcome;
		let login = instance.config.me;
		try {
			const posted = await withInstance(name, () => postEscalateCommand({ repo, number, dryRun }));
			login = posted.login;
			outcome = dryRun ? { ok: true, result: { dryRun: true, invocations: [posted.invocation] } } : { ok: true, result: posted.url };
		} catch (e) {
			outcome = { ok: false, result: `${e.message} Nothing was posted. "Copy command, open GitHub" still works.` };
		}
		const issueKind = route.params?.issueKind;
		await logClick(name, itemId, {
			routeId: route.id,
			route: route.type,
			draftHash: hash,
			edited: false,
			createdAt,
			action: "escalate",
			params: { to: "issue", ...(typeof issueKind === "string" && { issueKind }) },
			text: command,
			as: login,
			status: outcome.ok ? "done" : "failed",
			via: "server",
			finishedAt: new Date().toISOString(),
			result: typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result),
		});
		if (outcome.ok) {
			logRouteDecisions(name, itemId, item, route, "", body.input, false);
			decide(name, "escalated", itemId, item, { route: { type: route.type, title: route.title ?? "" }, issueKind: typeof issueKind === "string" ? issueKind : null, category: typeof item.category === "string" ? item.category : null });
			doneKeys.add(key);
			refusals.delete(key);
			await setHandled(name, itemId, route, "commented");
		}
		schedulePush(name, "items");
		return [200, outcome];
	}

	/**
	 * Runs the API edit of a `take_over` or `revise` route: commits the route's text edits to the PR's head branch
	 * through the GitHub API, comments on the PR and queues a full review of the new head.
	 * Call it inside the item's action lock, after the draft, repeat and pause checks.
	 */
	async function handleApiEdit(name, itemId, item, route, plan, entry, key, body) {
		const { number, repo } = item;
		// "Post anyway" never passes a moved head because the edits were written for the reviewed one
		const fresh = await checkFresh({ instance: name, action: "comment", params: {}, kind: "pr", number, item, force: body.force === true, headBound: true });
		if (fresh.state) {
			liveStates.set(`${name}/${itemId}`, { state: fresh.state, reason: fresh.stateReason ?? null });
			schedulePush(name, "items");
		}
		if (!fresh.ok) {
			refusals.set(key, { reason: fresh.reason, forceable: fresh.forceable });
			schedulePush(name, "items");
			return [200, { ok: false, result: fresh.reason, stale: true, forceable: fresh.forceable }];
		}

		logRouteDecisions(name, itemId, item, route, plan.text, body.input, false);
		const outcome = await runApiEdit({ instance: name, repo, number, reviewedSha: item.reviewedSha, params: plan.params, text: plan.text, dryRun });
		const committed = outcome.ok && !dryRun;
		const at = new Date().toISOString();
		const result = !outcome.ok ? outcome.result : dryRun ? JSON.stringify({ dryRun: true, invocations: outcome.invocations }) : outcome.url;
		await logClick(name, itemId, {
			...entry,
			action: plan.action,
			params: plan.params,
			text: plan.text,
			status: outcome.ok ? "done" : "failed",
			via: "server",
			finishedAt: at,
			result,
			...(committed && { resultParts: { commits: [outcome.url], threads: [] }, ...(outcome.commentUrl && { commentUrl: outcome.commentUrl }) }),
		});
		if (!outcome.ok) {
			schedulePush(name, "items");
			return [200, { ok: false, result, ...(outcome.paused && { paused: true }) }];
		}
		doneKeys.add(key);
		refusals.delete(key);
		if (committed) {
			const file = itemFile(name, itemId);
			await withLock(docLocks, file, async () => {
				const cur = await readJson(file);
				if (!cur) return;
				const links = [...(Array.isArray(cur.links) ? cur.links : []), { label: "Our commit", url: outcome.url }];
				await writeAtomic(file, { ...cur, pushed: { action: plan.action, sha: outcome.sha, at }, ...(plan.action === "take_over" && { takenOver: true }), links });
			});
			// Queue the review of the new head now because the card that decides the PR comes from it
			await logClick(name, itemId, {
				action: "full_review",
				params: { repo, number, by: "api_edit", pushed: { action: plan.action, sha: outcome.sha } },
				text: `Gary committed a text edit to this PR through the API. Review the new head ${outcome.sha.slice(0, 7)}.`,
				status: "queued",
				via: "queue",
				createdAt: at,
				finishedAt: null,
				result: "",
			});
		}
		await setHandled(name, itemId, route, outcome.commentUrl ? "commented" : null);
		schedulePush(name, "items");
		return [200, { ok: true, result: dryRun ? { dryRun: true, invocations: outcome.invocations } : outcome.url, ...(outcome.warning && { warning: outcome.warning }) }];
	}

	/** Marks the item as handled by the maintainer through `route`. The routine and the refresh read it. */
	async function setHandled(name, itemId, route, verified) {
		const file = itemFile(name, itemId);
		await withLock(docLocks, file, async () => {
			const item = await readJson(file);
			if (!item) return;
			await writeAtomic(file, { ...item, handled: { at: new Date().toISOString(), routeId: route.id, routeType: route.type, verified } });
		});
		schedulePush(name, "items");
	}

	const refreshedAt = new Map();
	const refreshWindow = [];

	/**
	 * Reads one item from GitHub, read-only, and stores what changed: `handled.verified`, `live` for a closed or
	 * merged thread, and the GitHub fields the page shows. Nothing the agent wrote changes.
	 */
	async function handleRefresh(body) {
		const name = instanceOf(body.instance);
		if (!name) return [400, { ok: false, result: UNKNOWN_INSTANCE }];
		const { itemId } = body;
		if (typeof itemId !== "string" || !ITEM_ID.test(itemId)) return [400, { ok: false, result: "itemId is required." }];
		const { error: settingsError } = settingsOf(name);
		if (settingsError) return [200, { ok: false, result: `The settings of ${name} are invalid. ${settingsError}`, settingsError }];
		const file = itemFile(name, itemId);
		const item = await readJson(file);
		if (!item) return [200, { ok: false, result: OUTDATED, outdated: true }];
		if (!allowedRepo(name, item.repo) || !["pr", "issue", "discussion"].includes(item.kind) || !Number.isSafeInteger(item.number)) {
			return [200, { ok: false, result: "The item names no thread of this instance." }];
		}
		const now = Date.now();
		const key = `${name}/${itemId}`;
		while (refreshWindow.length && refreshWindow[0] <= now - 60000) refreshWindow.shift();
		const itemWait = (refreshedAt.get(key) ?? -Infinity) + REFRESH_ITEM_MS - now;
		const totalWait = refreshWindow.length >= REFRESH_PER_MINUTE ? refreshWindow[0] + 60000 - now : 0;
		const wait = Math.max(itemWait, totalWait);
		if (wait > 0) {
			const retryAfter = Math.ceil(wait / 1000);
			return [429, { ok: false, result: `Checked a moment ago. Try again in ${retryAfter} s.`, retryAfter }];
		}
		refreshedAt.set(key, now);
		refreshWindow.push(now);
		let entry;
		try {
			entry = await withInstance(name, () => fetchItem(item.kind, item.number, item.repo));
		} catch (e) {
			return [200, { ok: false, result: `Reading the thread from GitHub failed: ${e.message}` }];
		}
		const checkedAt = new Date().toISOString();
		const state = entry.githubState ?? "open";
		let next;
		await withLock(docLocks, file, async () => {
			const cur = await readJson(file);
			if (!cur) return;
			next = { ...cur };
			if (state === "closed" || state === "merged") next.live = { state, checkedAt };
			else delete next.live;
			if (entry.mergeable !== undefined) next.mergeable = MERGEABLE_STATES[entry.mergeable] ?? "unknown";
			if (entry.ci !== undefined) next.ci = entry.ci;
			if (entry.facts?.lastEventUrl) next.lastEventUrl = entry.facts.lastEventUrl;
			if (cur.kind === "discussion" && typeof entry.category === "string") next.category = entry.category;
			if (isObject(cur.handled)) next.handled = { ...cur.handled, verified: verify(cur, cur.handled, entry, state) };
			await writeAtomic(file, next);
		});
		if (!next) return [200, { ok: false, result: OUTDATED, outdated: true }];
		schedulePush(name, "items");
		return [200, { ok: true, result: { state, checkedAt, ...(next.handled && { verified: next.handled.verified }) } }];
	}

	/** What GitHub shows since the maintainer handled the item. */
	function verify(item, handled, entry, state) {
		if (state === "closed" || state === "merged") return state;
		const since = Date.parse(handled.at);
		const ours = (entry.facts?.timeline ?? []).some((e) => e.side === "us" && e.kind !== "opened" && Date.parse(e.at) > since);
		if (ours) return "commented";
		const route = routesOf(item).find((r) => r.id === handled.routeId);
		const wanted = route?.type === "chore" && route.params?.action === "label" ? route.params : route?.params?.alsoLabel;
		if (isObject(wanted)) {
			const has = new Set((entry.labels ?? []).map((l) => l.toLowerCase()));
			const add = Array.isArray(wanted.add) ? wanted.add : [];
			const remove = Array.isArray(wanted.remove) ? wanted.remove : [];
			if (add.length + remove.length && add.every((l) => has.has(String(l).toLowerCase())) && remove.every((l) => !has.has(String(l).toLowerCase()))) return "labeled";
		}
		return "unchanged";
	}

	/**
	 * Runs the second button of a route: the labels of `alsoLabel` or the answer of `alsoAnswer`, with params from
	 * the route only, as the bot or under the own login. It is no route choice, so it logs no decision.
	 */
	async function handlePart(name, body) {
		const { itemId, routeId, input, force } = body;
		const outdated = [200, { ok: false, result: OUTDATED, outdated: true }];
		if (typeof itemId !== "string" || !ITEM_ID.test(itemId) || typeof routeId !== "string") return outdated;
		const part = input.part;
		const def = Object.hasOwn(PARTS, part) ? PARTS[part] : null;
		if (!def) return [200, { ok: false, result: `input.part must be one of ${Object.keys(PARTS).join(", ")}.` }];
		if (body.text !== undefined) return [400, { ok: false, result: `The ${part} button sends no text.` }];
		return withLock(actionLocks, `${name}/${itemId}`, async () => {
			const item = await readJson(itemFile(name, itemId));
			const route = item && routesOf(item).find((r) => r.id === routeId);
			if (!route) return outdated;
			const params = def.params(route);
			if (!params) return [200, { ok: false, result: def.none }];
			if (!allowedRepo(name, item.repo)) {
				return [200, { ok: false, result: typeof item.repo === "string" ? `${item.repo} is not a repository of instance ${name}. Nothing was sent.` : "The item names no repository. Nothing was sent." }];
			}
			try {
				const chosen = validateInput(route, item, input);
				if (chosen.part !== part || Object.keys(input).length !== 1) throw new Refusal(`The ${part} button sends only input.part "${part}".`);
			} catch (e) {
				if (e instanceof Refusal) return [200, { ok: false, result: e.message }];
				throw e;
			}
			const mode = modeOf(name);
			if (mode === "none") return [200, { ok: false, result: `${def.needs} a bot account, or allowOwnTokenPushes in config.json to run it under your own gh login.` }];
			const hash = partHash(part, route, item);
			const key = `${name}|${itemId}|${routeId}|${hash}`;
			if (doneKeys.has(`${part}|${key}`) || partsByKey(name, await readCollection(name, "actions"), part).get(key)?.status === "done") {
				return [409, { ok: false, result: def.duplicate, duplicate: true }];
			}
			if (isPaused(served.get(name).state)) return [200, { ok: false, result: PAUSED_MESSAGE, paused: true }];
			const { kind, number, repo } = item;
			if (def.openOnly) {
				const fresh = await checkFresh({ instance: name, action: def.action, params, kind, number, item, force: force === true, openOnly: true });
				if (fresh.state) {
					liveStates.set(`${name}/${itemId}`, { state: fresh.state, reason: fresh.stateReason ?? null });
					schedulePush(name, "items");
				}
				if (!fresh.ok) return [200, { ok: false, result: fresh.reason, stale: true, forceable: false }];
			}
			const outcome = await runAction({ instance: name, repo, action: def.action, params, kind, number, dryRun });
			await logClick(name, itemId, {
				routeId,
				route: route.type,
				part,
				[def.hashField]: hash,
				createdAt: new Date().toISOString(),
				action: def.action,
				params,
				text: "",
				status: outcome.ok ? "done" : "failed",
				via: "server",
				finishedAt: new Date().toISOString(),
				result: typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result),
			});
			if (outcome.ok) {
				doneKeys.add(`${part}|${key}`);
				await setHandled(name, itemId, route, VERIFIED_BY_ACTION[def.action] ?? null);
			}
			schedulePush(name, "items");
			return [200, outcome];
		});
	}

	/** Logs where a clicked route deviates from the agent's proposal. Call only after the click passed every check. */
	function logRouteDecisions(name, itemId, item, route, draft, input, agent) {
		const routes = routesOf(item);
		const recommended = routes.find((r) => r.recommended === true);
		const brief = (r) => ({ type: r.type, title: r.title ?? "" });
		if (recommended && recommended !== route) decide(name, "chose_alternative", itemId, item, { recommended: brief(recommended), chosen: brief(route) });
		const drafted = typeof route.text === "string" ? route.text : "";
		if (draft !== drafted) {
			if (agent) {
				if (draft.trim()) decide(name, "agent_note", itemId, item, { text: cut(draft) });
			} else decide(name, "edited_text", itemId, item, { route: brief(route), draft: cut(drafted), final: cut(draft) });
		}
		let chosen = {};
		try {
			chosen = validateInput(route, item, input);
		} catch {
			// planRoute validated the same input already
		}
		if (route.type === "review" && chosen.event !== undefined && chosen.event !== route.params?.event) {
			decide(name, "changed_event", itemId, item, { route: brief(route), from: route.params?.event ?? null, to: chosen.event });
		}
		if (!agent && chosen.alsoLabel === false) decide(name, "skipped_label", itemId, item, { route: brief(route), labels: labelParams(route) });
		const threads = new Map((Array.isArray(item.threads) ? item.threads : []).map((t) => [t?.id, t]));
		for (const d of chosen.decisions ?? []) {
			const thread = threads.get(d.threadId) ?? {};
			// Only a thread the agent judged valid starts on fix
			const byVerdict = thread.verdict === "valid" ? "fix" : "dismiss";
			if (d.decision !== byVerdict || d.note) {
				decide(name, "thread_override", itemId, item, {
					route: { type: route.type },
					thread: { summary: thread.summary ?? "", verdict: thread.verdict ?? null },
					decision: d.decision,
					note: d.note ?? "",
				});
			}
		}
		if (route.type === "review" && Array.isArray(chosen.commentIds)) {
			for (const c of Array.isArray(route.params?.comments) ? route.params.comments : []) {
				if (!chosen.commentIds.includes(c?.id)) decide(name, "unchecked_comment", itemId, item, { comment: { path: c?.path ?? "", text: cut(c?.text ?? "") } });
			}
		}
	}

	// The page reports the use of a route he does on GitHub himself. Nothing goes to GitHub and no action doc is written
	async function handleDecision(body) {
		const name = instanceOf(body.instance);
		if (!name) return [400, { ok: false, result: UNKNOWN_INSTANCE }];
		const { itemId, routeId, text } = body;
		if (typeof itemId !== "string" || !ITEM_ID.test(itemId) || typeof routeId !== "string") return [400, { ok: false, result: "itemId and routeId are required." }];
		if (text !== undefined && (typeof text !== "string" || text.length > MAX_TEXT)) {
			return [400, { ok: false, result: `text must be a string of at most ${MAX_TEXT} characters.` }];
		}
		const item = await readJson(itemFile(name, itemId));
		const route = item && routesOf(item).find((r) => r.id === routeId);
		if (!route) return [200, { ok: false, result: OUTDATED, outdated: true }];
		const recommended = routesOf(item).find((r) => r.recommended === true);
		const brief = (r) => ({ type: r.type, title: r.title ?? "" });
		if (recommended && recommended !== route) await decide(name, "chose_alternative", itemId, item, { recommended: brief(recommended), chosen: brief(route) });
		const drafted = typeof route.text === "string" ? route.text : "";
		if (typeof text === "string" && text !== drafted) await decide(name, "edited_text", itemId, item, { route: brief(route), draft: cut(drafted), final: cut(text) });
		await markOpened(name, itemId, item, route, typeof text === "string" ? text : "");
		await setHandled(name, itemId, route, null);
		return [200, { ok: true, result: "Logged." }];
	}

	// Removes one suggested route the maintainer does not want and remembers it on the item
	async function handleDismissRoute(name, body) {
		const { itemId, routeId } = body;
		const reason = body.text ?? "";
		const outdated = [200, { ok: false, result: OUTDATED, outdated: true }];
		if (typeof itemId !== "string" || !ITEM_ID.test(itemId) || typeof routeId !== "string") return outdated;
		if (typeof reason !== "string" || reason.length > MAX_REASON) {
			return [400, { ok: false, result: `The reason must be a string of at most ${MAX_REASON} characters.` }];
		}
		return withLock(actionLocks, `${name}/${itemId}`, async () => {
			const file = itemFile(name, itemId);
			const done = await withLock(docLocks, file, async () => {
				const item = await readJson(file);
				const route = item && routesOf(item).find((r) => r.id === routeId);
				if (!route) return null;
				const at = new Date().toISOString();
				const remaining = item.routes.filter((r) => r?.id !== route.id);
				const next = {
					...item,
					routes: remaining,
					dismissedRoutes: [...(Array.isArray(item.dismissedRoutes) ? item.dismissedRoutes : []), { type: route.type, title: route.title ?? "", reason: reason.trim(), at }],
				};
				if (route.recommended === true && remaining.length) {
					remaining[0] = { ...remaining[0], recommended: true };
					next.hint = remaining[0].title;
				}
				if (!remaining.length) delete next.hint;
				if (Array.isArray(item.findings)) {
					next.findings = item.findings.map((f) => (f?.routeId === route.id ? (({ routeId: _, ...rest }) => rest)(f) : f));
				}
				await writeAtomic(file, next);
				return { item, route, remaining, at };
			});
			if (!done) return outdated;
			const { item, route, remaining, at } = done;
			await logClick(name, itemId, { routeId, route: route.type, action: "dismiss_route", params: {}, text: reason.trim(), status: "done", via: "board", createdAt: at, finishedAt: at, result: "" });
			if (!remaining.length) {
				await logClick(name, itemId, {
					action: "reanalyze",
					params: {},
					text: `The maintainer dismissed the ${route.type} route "${route.title ?? ""}". Reason: ${reason.trim() || "none given"}. Propose a different route.`,
					status: "queued",
					via: "queue",
					createdAt: at,
					finishedAt: null,
					result: "",
				});
			}
			await decide(name, "dismissed_route", itemId, item, { route: { type: route.type, title: route.title ?? "" }, wasRecommended: route.recommended === true, reason: reason.trim() });
			schedulePush(name, "items");
			return [200, { ok: true, result: "Route dismissed.", reanalyze: !remaining.length }];
		});
	}

	// Accepting appends the rule to its file. Both run in dry-run mode too, because they change only local files
	async function handleProposal(name, body) {
		const { proposalId, text } = body;
		if (typeof proposalId !== "string" || !PROPOSAL_ID.test(proposalId)) return [400, { ok: false, result: "proposalId is invalid." }];
		const accept = body.action === "accept_proposal";
		const max = accept ? MAX_RULE : MAX_REASON;
		if (text !== undefined && (typeof text !== "string" || text.length > max)) {
			return [400, { ok: false, result: `text must be a string of at most ${max} characters.` }];
		}
		const file = join(served.get(name).board, "proposals", proposalId + ".json");
		const reply = await withLock(docLocks, file, async () => {
			const p = await readJson(file);
			if (!p) return [200, { ok: false, result: "This proposal no longer exists. Reload the board." }];
			if (p.status !== "open") return [409, { ok: false, result: `This proposal is already ${p.status}.` }];
			const decidedAt = new Date().toISOString();
			if (!accept) {
				await writeAtomic(file, { ...p, status: "dismissed", decidedAt, reason: (text ?? "").trim() });
				await decide(name, "dismissed_proposal", null, null, { proposal: { id: p.id, title: p.title, target: p.target, file: p.file }, reason: (text ?? "").trim() });
				return [200, { ok: true, result: "Proposal dismissed." }];
			}
			const rule = typeof text === "string" && text.trim() ? text : p.text;
			let applied;
			try {
				applied = await applyProposal(p, rule, name);
			} catch (e) {
				return [200, { ok: false, result: e.message }];
			}
			await writeAtomic(file, { ...p, text: rule, status: "accepted", decidedAt });
			return [200, { ok: true, result: applied.file, committed: applied.committed, ...(applied.warning && { warning: applied.warning }) }];
		});
		schedulePush(name, "proposals");
		return reply;
	}

	// The page snoozes, hides and asks to analyze again through plain document writes
	async function logPageWrite(name, { op, path, data }) {
		if (!["update", "set"].includes(op) || !data || typeof data !== "object") return;
		const m = /^(items|actions)\/(.+)$/.exec(path ?? "");
		if (!m) return;
		if (m[1] === "items") {
			const item = await readJson(itemFile(name, m[2]));
			if (typeof data.snoozedUntil === "string" && Number.isFinite(Date.parse(data.snoozedUntil))) {
				decide(name, "snoozed", m[2], item, { days: Math.max(0, Math.round((Date.parse(data.snoozedUntil) - Date.now()) / 86400000)) });
			} else if (data.hidden === true) decide(name, "snoozed", m[2], item, { untilActivity: true });
		} else if (data.action === "reanalyze" && typeof data.text === "string" && data.text.trim() && typeof data.itemId === "string" && ITEM_ID.test(data.itemId)) {
			decide(name, "agent_note", data.itemId, await readJson(itemFile(name, data.itemId)), { text: cut(data.text) });
		}
	}

	/** Splits a write into its instance and the path inside that instance's board store, or returns null. */
	function scopeWrite(body) {
		if (typeof body.path !== "string") return null;
		let name = body.instance;
		let path = body.path;
		const doc = SCOPED_PATH.exec(path);
		const meta = SCOPED_META.exec(path);
		if (doc || meta) {
			const given = doc ? doc[2] : meta[1];
			if (name !== undefined && name !== given) return null;
			name = given;
			path = doc ? `${doc[1]}/${doc[3]}` : "meta";
		}
		name = instanceOf(name);
		return name ? { name, path } : null;
	}

	// Serialize writes per file, so a merge never reads a file that another write is replacing
	async function handleDb(body) {
		const scope = scopeWrite(body);
		if (!scope) return [400, { error: "The write names no known instance." }];
		const { name, path } = scope;
		const file = docPath(name, path);
		if (!file) return [400, { error: "Only items/<id>, actions/<id>, proposals/<id> and meta can be written." }];
		let data = body.data;
		if (isObject(data)) {
			// Served items carry instance and ref, which are not part of the stored doc
			const { instance: _i, ref: _r, ...rest } = data;
			data = rest;
			if (path.startsWith("actions/") && typeof data.itemId === "string" && data.itemId.startsWith(`${name}/`)) data.itemId = data.itemId.slice(name.length + 1);
		}
		const write = { op: body.op, path, data };
		return withLock(docLocks, file, async () => {
			const reply = await applyWrite(name, write);
			if (reply[0] === 200) {
				await logPageWrite(name, write);
				schedulePush(name, path === "meta" ? "meta" : path.split("/")[0]);
			}
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
	${shim(TOKEN, boardNow(), pageVersion(board))}
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
		if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ...HEALTH, instances: names() });

		const given = url.pathname === "/api/events" ? url.searchParams.get("token") : req.headers["x-board-token"];
		if (!tokenOk(given)) return json(res, 401, { error: "Missing or wrong token." });

		if (req.method === "GET" && url.pathname === "/api/events") {
			const version = pageVersion(await readFile(pageFile, "utf8"));
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
				"X-Content-Type-Options": "nosniff",
			});
			res.write("retry: 3000\n\n");
			clients.add(res);
			req.on("close", () => clients.delete(res));
			send(res, "hello", { version });
			send(res, "board", { instance: null, board: boardNow() });
			for (const name of names()) {
				const events = await Promise.all(["items", "actions", "proposals", "meta"].map(async (event) => [event, await eventOf(name, event)]));
				for (const [event, data] of events) send(res, event, data);
			}
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/state") {
			const list = names();
			const [items, proposals] = await Promise.all([
				Promise.all(list.map(readItems)).then((a) => a.flat()),
				Promise.all(list.map(readOpenProposals)).then((a) => a.flat()),
			]);
			return json(res, 200, { board: boardNow(), items, proposals });
		}
		if (req.method === "GET" && url.pathname === "/api/tools") {
			return json(res, 200, { tools: Object.keys(ACTIONS), dryRun });
		}
		if (req.method === "POST" && ["/api/db", "/api/action", "/api/decision", "/api/refresh"].includes(url.pathname)) {
			if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
				return json(res, 415, { error: "Send JSON." });
			}
			const body = await readBody(req);
			const handler = { "/api/db": handleDb, "/api/action": handleAction, "/api/decision": handleDecision, "/api/refresh": handleRefresh }[url.pathname];
			const [status, data] = await handler(body);
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
	log(`Board on ${url} for ${names().join(", ") || "no instance yet"}${dryRun ? " (dry run, no GitHub writes)" : ""}, root ${dirname(instancesDir())}`);

	return {
		url,
		port,
		instances: names,
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
