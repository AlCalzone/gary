// Focus: the maintainer handles one item 1 on 1 in a dedicated agent session, and Gary holds everything on it.
// A focus record is <state>/focus/<itemId>.json. The master writes it with what it found in its own harness, so this
// code knows no harness. While a record is `active` or `paused`, no worker, review round or push touches the item.
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ID_PATTERN, boardDir, readJson, writeAtomic } from "./board-store.mjs";
import { instanceDir, instanceName } from "./config.mjs";

// `FOCUS_QUIET_MS` sets how long a focus session may be quiet before its focus counts as paused
export const FOCUS_QUIET_MS = 30 * 60000;
export const FOCUS_STATUSES = ["active", "paused", "ended"];
export const FOCUS_HELD = ["active", "paused"];
// A focus ends by the session's done message, the board's "End focus", or an archived or deleted session
export const FOCUS_END_REASONS = ["done", "end", "archived"];
export const FOCUS_MATCHES = ["pr", "branch", "focus", "origin", "worktree"];
export const MAX_SUMMARY = 8000;
const MAX_FIELD = 500;
// The board opens only session links of these schemes
const LINK = /^(https:\/\/|t3-thread:\/\/|claude:\/\/)[^\s"'<>]{1,1000}$/;

export const focusDir = (instance = instanceName()) => join(instanceDir(instance), "state", "focus");
export const focusFile = (itemId, instance = instanceName()) => join(focusDir(instance), itemId + ".json");

const validTime = (t) => typeof t === "string" && Number.isFinite(Date.parse(t));
const iso = (t) => new Date(t).toISOString();

function checkId(itemId) {
	if (!ID_PATTERN.test(itemId ?? "")) throw new Error(`The item id must match ${ID_PATTERN}`);
}

/** The focus record of the item, or null. */
export async function readFocus(itemId, instance = instanceName()) {
	checkId(itemId);
	return readJson(focusFile(itemId, instance));
}

/** The focus record of the item, read at once, or null. */
export function readFocusSync(itemId, instance = instanceName()) {
	if (!ID_PATTERN.test(itemId ?? "")) return null;
	try {
		const v = JSON.parse(readFileSync(focusFile(itemId, instance), "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

/** Every focus record of the instance by item id. */
export async function readFocuses(instance = instanceName()) {
	let names = [];
	try {
		names = (await readdir(focusDir(instance))).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const out = {};
	for (const n of names) {
		const id = n.slice(0, -5);
		if (!ID_PATTERN.test(id)) continue;
		const r = await readJson(join(focusDir(instance), n));
		if (r) out[id] = r;
	}
	return out;
}

export const isHeld = (record) => FOCUS_HELD.includes(record?.status);

/** The record while focus holds the item, or null. */
export function focusHold(itemId, instance = instanceName()) {
	const r = readFocusSync(itemId, instance);
	return isHeld(r) ? r : null;
}

/** The ids of every item focus holds, read at once. */
export function heldItemIds(instance = instanceName()) {
	let names = [];
	try {
		names = readdirSync(focusDir(instance)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch {
		return new Set();
	}
	return new Set(names.map((n) => n.slice(0, -5)).filter((id) => isHeld(readFocusSync(id, instance))));
}

const sessionName = (r) => r?.session?.title || r?.session?.id || "a focus session";

/** The sentence a refused step prints while focus holds the item. */
export function focusRefusal(itemId, record) {
	const paused = record.status === "paused" ? " The focus is paused. End it on the board to let Gary act again." : "";
	return `${itemId} is in focus in ${sessionName(record)} since ${record.startedAt}. Gary does not touch it until the focus ends.${paused}`;
}

/** Throws `error` with the refusal while focus holds the item. */
export function assertNotHeld(itemId, instance = instanceName(), error = Error) {
	const r = focusHold(itemId, instance);
	if (r) throw new error(focusRefusal(itemId, r));
}

function cleanText(value, name, max = MAX_FIELD) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	const v = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
	if (v.length > max) throw new Error(`${name} must be at most ${max} characters`);
	return v || null;
}

/** A session link the board may open, or null. */
export function safeLink(link) {
	return typeof link === "string" && LINK.test(link) ? link : null;
}

/** The newest of the recorded activity, `activityAt`, and the Claude Code transcript's time when the record names one. */
export function latestActivity(record, activityAt) {
	const times = [record?.lastActivity, activityAt];
	if (typeof record?.transcript === "string") {
		try {
			times.push(statSync(record.transcript).mtime.toISOString());
		} catch {}
	}
	return times.filter(validTime).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/**
 * The record after a check of its session: `ended` when the session is archived or gone, `paused` after 30 quiet
 * minutes, `active` again on activity after the pause. Returns `{ record, changed, ended }`. Pure apart from the
 * transcript's time.
 */
export function checkedRecord(record, { activityAt, archived = false, now = Date.now() } = {}) {
	if (!isHeld(record)) return { record, changed: false, ended: false };
	const at = iso(now);
	const last = latestActivity(record, activityAt) ?? record.startedAt;
	if (archived) return { record: endRecord(record, { by: "archived", now }), changed: true, ended: true };
	const quiet = now - Date.parse(last) >= FOCUS_QUIET_MS;
	let next = { ...record, lastActivity: last, checkedAt: at };
	if (record.status === "active" && quiet) next = { ...next, status: "paused", pausedAt: at };
	else if (record.status === "paused" && validTime(record.pausedAt) && Date.parse(last) > Date.parse(record.pausedAt)) {
		const { pausedAt: _, ...rest } = next;
		next = { ...rest, status: "active" };
	}
	return { record: next, changed: next.status !== record.status || next.lastActivity !== record.lastActivity, ended: false };
}

function endRecord(record, { by, summary = null, now = Date.now() }) {
	const { pausedAt: _, ...rest } = record;
	return { ...rest, status: "ended", endedAt: iso(now), endedBy: by, summary };
}

async function writeRecord(itemId, record, instance) {
	await mkdir(focusDir(instance), { recursive: true });
	await writeAtomic(focusFile(itemId, instance), record);
}

async function settleRequest(instance, requestId, itemId, status, result) {
	if (requestId === undefined || requestId === null) return null;
	if (typeof requestId !== "string" || !ID_PATTERN.test(requestId)) throw new Error("--request must name the focus request's action doc");
	const file = join(boardDir(instance), "actions", requestId + ".json");
	const doc = await readJson(file);
	if (!doc || doc.itemId !== itemId || doc.action !== "focus") throw new Error(`Action ${requestId} is no focus request for ${itemId}`);
	await writeAtomic(file, { ...doc, status, finishedAt: new Date().toISOString(), result });
	return requestId;
}

/**
 * Starts a focus or attaches it to a session that already handles the item, and settles the focus request `requestId`.
 * `how` is "started" for a new session or "attached" with `match`, the verified way the session handles the item.
 * The same session again keeps the record and marks it active. Throws while another session holds the item.
 */
export async function startFocus({ instance = instanceName(), itemId, harness, session, how = "started", match = null, requestId, transcript = null, now = Date.now() }) {
	checkId(itemId);
	const h = cleanText(harness, "--harness", 40);
	if (!h || !/^[a-z0-9-]+$/.test(h)) throw new Error("--harness must name the harness, like t3code");
	const id = cleanText(session?.id, "--session", 300);
	if (!id) throw new Error("--session must name the session");
	if (!["started", "attached"].includes(how)) throw new Error("how must be started or attached");
	if (how === "attached" && !FOCUS_MATCHES.includes(match)) throw new Error(`--match must be one of ${FOCUS_MATCHES.join(", ")}`);
	const link = cleanText(session?.link, "--link", 1000);
	if (link && !safeLink(link)) throw new Error("--link must be an https://, t3-thread:// or claude:// link");
	const cur = await readFocus(itemId, instance);
	if (isHeld(cur) && cur.session?.id !== id) throw new Error(`${itemId} is already in focus in ${sessionName(cur)}. End that focus first.`);
	const at = iso(now);
	const same = isHeld(cur) && cur.session?.id === id;
	const record = {
		itemId,
		harness: h,
		session: { id, link: link ?? (same ? cur.session.link ?? null : null), title: cleanText(session?.title, "--title") ?? (same ? cur.session.title ?? null : null) },
		how: same ? cur.how : how,
		...(how === "attached" || (same && cur.match) ? { match: same && cur.match ? cur.match : match } : {}),
		...(typeof transcript === "string" && transcript && { transcript }),
		startedAt: same ? cur.startedAt : at,
		lastActivity: at,
		status: "active",
		...(requestId && { requestId }),
	};
	await writeRecord(itemId, record, instance);
	await settleRequest(instance, requestId, itemId, "done", `In focus in ${record.session.title ?? record.session.id}.`);
	return record;
}

/** Marks the focus request failed, so the board says why no session started. */
export async function failFocus({ instance = instanceName(), itemId, requestId, reason }) {
	checkId(itemId);
	const text = cleanText(reason, "--reason", 1000);
	if (!text) throw new Error("--reason must say why no focus session started");
	if (!requestId) throw new Error("--request must name the focus request's action doc");
	await settleRequest(instance, requestId, itemId, "failed", text);
	return { itemId, requestId, reason: text };
}

/** The note the fresh analysis after a focus gets, as the maintainer's instruction for this item. */
export function focusNote(record) {
	const how = { done: "The focus session reported that the maintainer is done", end: "The maintainer ended the focus on the board", archived: "The focus session was archived" }[record.endedBy];
	const lead = `The maintainer handled this item 1 on 1 in a focus session from ${record.startedAt} to ${record.endedAt}. ${how}.`;
	if (!record.summary) return `${lead} It left no closing summary. Analyze the item from its current state on GitHub.`;
	return `${lead} The session's closing summary follows. It says what was decided and done, and what is left. Analyze the item from its current state on GitHub with this in mind.\n\n${record.summary}`;
}

/**
 * Ends the focus, lifts the hold and queues a fresh analysis with the closing summary as its note.
 * `by` is "done", "end" or "archived". `session` must match the record when given. Returns `{ record, actionId }`, or
 * `{ record, actionId: null }` when no focus held the item.
 */
export async function endFocus({ instance = instanceName(), itemId, by, summary = null, session, now = Date.now() }) {
	checkId(itemId);
	if (!FOCUS_END_REASONS.includes(by)) throw new Error(`by must be one of ${FOCUS_END_REASONS.join(", ")}`);
	const text = cleanText(summary, "The summary", MAX_SUMMARY);
	const cur = await readFocus(itemId, instance);
	if (!isHeld(cur)) return { record: cur, actionId: null };
	if (session !== undefined && session !== cur.session?.id) throw new Error(`${itemId} is in focus in ${sessionName(cur)}, not in ${session}.`);
	const record = endRecord(cur, { by, summary: text, now });
	await writeRecord(itemId, record, instance);
	return { record, actionId: await queueAnalysis(instance, itemId, record, now) };
}

async function queueAnalysis(instance, itemId, record, now) {
	const dir = join(boardDir(instance), "actions");
	await mkdir(dir, { recursive: true });
	const id = `${itemId}-${now}-${randomBytes(2).toString("hex")}`;
	await writeAtomic(join(dir, id + ".json"), {
		itemId,
		action: "reanalyze",
		params: { by: "focus", focus: { endedBy: record.endedBy, session: record.session?.id ?? null } },
		text: focusNote(record),
		status: "queued",
		via: "queue",
		createdAt: iso(now),
		finishedAt: null,
		result: "",
	});
	return id;
}

/** Checks the session of a held focus and writes the result. An archived session ends the focus like `endFocus`. */
export async function checkFocus({ instance = instanceName(), itemId, activityAt, archived = false, now = Date.now() }) {
	checkId(itemId);
	if (activityAt !== undefined && !validTime(activityAt)) throw new Error("--activity must be an ISO time");
	const cur = await readFocus(itemId, instance);
	if (!isHeld(cur)) return { record: cur, changed: false, actionId: null };
	const { record, changed, ended } = checkedRecord(cur, { activityAt, archived, now });
	await writeRecord(itemId, record, instance);
	return { record, changed, actionId: ended ? await queueAnalysis(instance, itemId, record, now) : null };
}

/**
 * Whether the watcher should ask the master to look at the session now: an active focus whose last activity is 30
 * minutes old, and a paused one every 30 minutes. Returns the key that names this check, or null.
 */
export function checkDue(record, now = Date.now()) {
	if (!isHeld(record)) return null;
	const last = latestActivity(record) ?? record.startedAt;
	if (record.status === "active") return now - Date.parse(last) >= FOCUS_QUIET_MS ? `active/${last}` : null;
	return `paused/${Math.floor(now / FOCUS_QUIET_MS)}`;
}
