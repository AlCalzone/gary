// Review drafts of a contributions instance: the first draft of the maintainer's own review on a PR that requests it.
// Code decides which draft starts without a click, records every start in <state>/review-drafts.json, checks the
// draft's pending review route and the lines its comments name. See "Review drafts" in SPEC.md.
import { botCommandHit } from "./review-bots.mjs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJson } from "./board-store.mjs";
import { updateJson } from "./auto-review.mjs";
import { REVIEW_DRAFT_DEFAULTS, allReviewTriggers, instanceDir, instanceName } from "./config.mjs";
import { isObject } from "./routes.mjs";

export const reviewDraftsFile = (instance = instanceName()) => join(instanceDir(instance), "state", "review-drafts.json");

/** The records by item id: `{ <itemId>: { repo, number, starts: [{ at, by, request, sha }], held } }`. */
export async function readReviewDrafts(instance = instanceName()) {
	return (await readJson(reviewDraftsFile(instance))) ?? {};
}

/** Changes all records at once under the file's lock. `change` gets the records and returns the new ones. */
export function updateReviewDrafts(change, instance = instanceName()) {
	return updateJson(reviewDraftsFile(instance), change);
}

/** The settings of the instance config: `{ perRun, maxPending, maxLines }`. */
export function reviewDraftSettings(config = {}) {
	return {
		perRun: config.maxAutoReviewDraftsPerRun ?? REVIEW_DRAFT_DEFAULTS.maxAutoReviewDraftsPerRun,
		maxPending: config.maxPendingAutoReviewDrafts ?? REVIEW_DRAFT_DEFAULTS.maxPendingAutoReviewDrafts,
		maxLines: config.reviewDraftMaxLines ?? REVIEW_DRAFT_DEFAULTS.reviewDraftMaxLines,
	};
}

// The review request a draft belongs to: the time of the newest request, or "unknown" when it is older than the events the snapshot reads
export const requestOf = (entry) => entry?.facts?.reviewRequestedAt ?? entry?.reviewRequestedAt ?? "unknown";
const requested = (entry) => (entry?.facts?.reviewRequested ?? entry?.reviewRequested) === true;

// A draft that has not arrived this long after its start failed, and the board offers the click again
const STALL_MS = 3 * 60 * 60 * 1000;

/** The pending review route of an item, or null. */
export const pendingRoute = (item) => (Array.isArray(item?.routes) ? item.routes : []).find((r) => isObject(r) && r.type === "review" && r.params?.pending === true) ?? null;

/**
 * Whether the PR's last draft started without a click and still waits for the maintainer. It stops waiting when they
 * handled the item (a pending review, a prefill, a snooze, a hide or a dismissed draft), when the PR closed or no longer
 * requests their review for that request, and when the draft never arrived. `entry` is the PR's current snapshot entry.
 */
export function waitsForUser(record, { item, entry, now = Date.now() }) {
	const last = record?.starts?.at(-1);
	if (last?.by !== "auto") return false;
	if (!entry || entry.githubState !== "open" || !requested(entry) || requestOf(entry) !== last.request) return false;
	const startAt = Date.parse(last.at);
	const arrived = Date.parse(item?.reviewedAt ?? "") >= startAt;
	if (!arrived) return now - startAt <= STALL_MS;
	if (!pendingRoute(item)) return false;
	if (Date.parse(item.handled?.at ?? "") >= startAt) return false;
	if (item.hidden === true || Date.parse(item.snoozedUntil ?? "") > now) return false;
	return true;
}

/** How many drafts that started without a click wait for the maintainer, over all records. */
export function countWaiting(records, { items = {}, entries = {}, now = Date.now() }) {
	return Object.entries(records ?? {}).filter(([id, r]) => waitsForUser(r, { item: items[id], entry: entries[id], now })).length;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Whether the PR's review draft starts now without a click. `entry` is the PR's snapshot entry, `record` its stored
 * record, `started` the drafts this run started already, `waiting` the drafts that wait for the maintainer.
 * Returns `{ start: true, request }`, or `{ start: false, code, message, hold }`. `hold: true` means the board shows
 * the "Prepare review" button with the message.
 */
export function draftDecision({ entry, record, started, waiting, settings, me }) {
	const no = (code, message) => ({ start: false, code, message, hold: false });
	const n = entry?.number;
	if (entry?.kind !== "pr" || !requested(entry)) return no("not-requested", `PR #${n} does not request your review.`);
	if (String(entry.author ?? "").toLowerCase() === String(me ?? "").toLowerCase()) return no("own", `PR #${n} is your own.`);
	if (entry.githubState !== "open") return no("not-open", `PR #${n} is ${entry.githubState}.`);
	if (entry.isDraft) return no("draft", `PR #${n} is a draft.`);
	const request = requestOf(entry);
	if ((record?.starts ?? []).some((s) => s.request === request)) return no("already", `A review draft for this review request of PR #${n} started already. A new one needs a new request of your review.`);
	const hold = (code, message, extra = {}) => ({ start: false, code, message, hold: true, request, ...extra });
	if (settings.perRun === 0 || settings.maxPending === 0) {
		const key = settings.perRun === 0 ? "maxAutoReviewDraftsPerRun" : "maxPendingAutoReviewDrafts";
		return hold("off", `Review drafts start only on your click: ${key} is 0.`);
	}
	const lines = entry.facts?.changedLines ?? entry.changedLines;
	if (!Number.isInteger(lines)) return hold("size", `The size of PR #${n} is unknown, so its review draft waits for your click.`, { limit: settings.maxLines });
	if (lines > settings.maxLines) {
		return hold("size", `PR #${n} changes ${lines.toLocaleString("en-US")} lines, more than the limit of ${settings.maxLines.toLocaleString("en-US")} in reviewDraftMaxLines.`, { lines, limit: settings.maxLines });
	}
	if (waiting >= settings.maxPending) {
		return hold("pending", `${waiting} of ${settings.maxPending} automatic review drafts wait for you, the limit in maxPendingAutoReviewDrafts. This one starts by itself once you handled one of them.`, { lines, waiting, limit: settings.maxPending });
	}
	if (started >= settings.perRun) {
		return hold("run-limit", `This run started ${plural(started, "review draft")} already, the limit in maxAutoReviewDraftsPerRun. The next run tries again.`, { lines, limit: settings.perRun });
	}
	return { start: true, request };
}

// A held draft that waited only for a free slot is tried again in every run, also when its PR did not change
const RETRIED = new Set(["pending", "run-limit"]);

/**
 * Decides for every PR that requests the maintainer's review whether its draft starts now, and records the outcome:
 * a start, or the reason it waits for a click. `changed` are the run's changed entries with their facts, `entries` every
 * current snapshot entry by id, `items` the board items by id. A draft held for a free slot is tried again.
 * Returns `{ start: [{ id, repo, number, request }], held: [{ id, code, message }], skipped: [{ id, code }] }`.
 */
export async function planDrafts({ changed, entries = {}, items = {}, settings, me, now = Date.now(), instance = instanceName() }) {
	const out = { start: [], held: [], skipped: [] };
	const at = new Date(now).toISOString();
	await updateReviewDrafts((records) => {
		const next = { ...records };
		const fresh = new Map(changed.filter((e) => e?.kind === "pr" && requested(e)).map((e) => [e.id, e]));
		for (const [id, r] of Object.entries(records)) {
			const e = entries[id];
			if (fresh.has(id) || !RETRIED.has(r?.held?.code) || !e) continue;
			fresh.set(id, { ...e, id, kind: "pr", repo: e.repo ?? r.repo, number: r.number, facts: { reviewRequested: requested(e), reviewRequestedAt: e.reviewRequestedAt ?? null, changedLines: r.held.lines } });
		}
		let started = 0;
		for (const entry of fresh.values()) {
			const record = next[entry.id] ?? null;
			const waiting = countWaiting(next, { items, entries: { ...entries, ...Object.fromEntries(fresh) }, now });
			const d = draftDecision({ entry, record, started, waiting, settings, me });
			const base = { repo: entry.repo, number: entry.number, starts: record?.starts ?? [], held: record?.held ?? null };
			if (d.start) {
				started++;
				next[entry.id] = { ...base, starts: [...base.starts, { at, by: "auto", request: d.request, sha: entry.headSha ?? null }], held: null };
				out.start.push({ id: entry.id, repo: entry.repo, number: entry.number, request: d.request });
			} else if (d.hold) {
				next[entry.id] = { ...base, held: { code: d.code, message: d.message, at, request: d.request, ...(d.lines !== undefined && { lines: d.lines }), ...(d.limit !== undefined && { limit: d.limit }) } };
				out.held.push({ id: entry.id, code: d.code, message: d.message });
			} else {
				if (record?.held) next[entry.id] = { ...base, held: null };
				out.skipped.push({ id: entry.id, code: d.code });
			}
		}
		return next;
	}, instance);
	return out;
}

/** Records a start after the maintainer's click. A click works whatever the limits, and it counts toward neither. */
export async function recordClickStart(itemId, { repo, number, request, sha, now = Date.now() }, instance = instanceName()) {
	await updateReviewDrafts((records) => {
		const record = records[itemId];
		return { ...records, [itemId]: { repo, number, starts: [...(record?.starts ?? []), { at: new Date(now).toISOString(), by: "click", request, sha: sha ?? null }], held: null } };
	}, instance);
}

/**
 * What the board shows about the review draft of a PR item, or null: `{ state, at?, code?, message?, headMoved?, canPrepare }`.
 * `state` is `held` (waits for a click, with the reason), `started`, `stalled` (started and never arrived) or `ready`.
 * `snap` is the PR's committed snapshot entry.
 */
export function reviewDraftState(item, record, snap, now = Date.now()) {
	if (item?.kind !== "pr") return null;
	const draft = pendingRoute(item) && typeof item.reviewedSha === "string" ? item : null;
	const last = record?.starts?.at(-1) ?? null;
	const draftAt = Date.parse(item.reviewedAt ?? "");
	const held = record?.held && snap?.reviewRequested === true && !(Date.parse(last?.at ?? "") > Date.parse(record.held.at)) ? record.held : null;
	if (held) return { state: "held", code: held.code, message: held.message, at: held.at, canPrepare: true };
	if (last && !(draft && draftAt >= Date.parse(last.at))) {
		const stalled = now - Date.parse(last.at) > STALL_MS;
		return { state: stalled ? "stalled" : "started", at: last.at, by: last.by, canPrepare: stalled };
	}
	if (draft) {
		const headMoved = typeof snap?.headSha === "string" && snap.headSha !== item.reviewedSha;
		return { state: "ready", at: item.reviewedAt ?? null, sha: item.reviewedSha, headMoved, canPrepare: headMoved };
	}
	return null;
}

// Lines that a bot in someone else's repo would take as a command: a slash command, a bot mention, bors
const BOT_COMMAND = /^\s*\/[a-z][\w-]*|@[\w-]*bot\b|@[\w-]+\[bot\]|\bbors\s+(?:r[+-=]|try|merge|retry|delegate)/im;

/**
 * The bot command a text holds, or null. Review text written by the agent must hold none. `commands` adds texts that
 * count as commands too, like the trigger comments of review bots, as `botCommandTexts` returns them.
 */
export function botCommandIn(text, commands = []) {
	if (typeof text !== "string") return null;
	const hit = BOT_COMMAND.exec(text)?.[0].trim();
	if (hit) return hit;
	return botCommandHit(text, commands);
}

const MAX_BODY = 65536;
const MAX_COMMENTS = 50;
const REVIEW_EVENTS = ["approve", "request_changes", "comment"];
const SHA = /^[0-9a-f]{40}$/;

/**
 * The problems of a pending review route on a contributions item, as `[code, message]`. The route holds the draft of
 * the maintainer's own review: the body per verdict in `params.bodies`, the inline comments, and the verdict Gary suggests.
 * `commands` are the texts that count as bot commands besides the pattern. They default to the trigger comments of the
 * review bots of every maintainer instance.
 */
export function pendingRouteProblems(item, route, where, commands = allReviewTriggers()) {
	const out = [];
	const add = (code, message) => out.push([code, `${where}: ${message}`]);
	const p = isObject(route.params) ? route.params : {};
	if (item.kind !== "pr") add("pending-kind", "a pending review is only for a PR");
	if (route.as !== "me") add("pending-as", 'a pending review is created under your own login, so it is as "me"');
	if (item.reviewDepth !== "full") add("pending-depth", 'a review draft is a full review: reviewDepth "full"');
	if (typeof item.reviewedSha !== "string" || !SHA.test(item.reviewedSha)) add("pending-sha", "a review draft needs reviewedSha, the full 40-character head it read");
	if (!isObject(item.walkthrough)) add("pending-walkthrough", "a review draft needs a walkthrough");
	for (const key of Object.keys(p)) if (!["pending", "event", "comments", "bodies"].includes(key)) add("pending-params", `params.${key} is not part of a pending review`);
	if (!REVIEW_EVENTS.includes(p.event)) add("pending-event", `params.event is the verdict Gary suggests, one of ${REVIEW_EVENTS.join(", ")}`);
	const comments = Array.isArray(p.comments) ? p.comments : [];
	if (comments.length > MAX_COMMENTS) add("pending-comments", `a review draft has at most ${MAX_COMMENTS} inline comments`);
	comments.forEach((c, i) => {
		if (isObject(c) && typeof c.diffHunk !== "string") add("pending-hunk", `comments[${i}] needs its diffHunk, so you can judge it on the card`);
	});
	if (p.bodies !== undefined) {
		if (!isObject(p.bodies) || !Object.entries(p.bodies).every(([k, v]) => REVIEW_EVENTS.includes(k) && typeof v === "string" && v.trim() && v.length <= MAX_BODY)) {
			add("pending-bodies", `params.bodies maps a verdict (${REVIEW_EVENTS.join(", ")}) to the review body for it`);
		} else if (typeof p.bodies[p.event] === "string" && p.bodies[p.event] !== route.text) add("pending-bodies", "text must be the body in params.bodies for the suggested verdict");
	}
	if (typeof route.text === "string" && route.text.length > MAX_BODY) add("pending-text", `the body has at most ${MAX_BODY} characters`);
	if (!(typeof route.text === "string" && route.text.trim()) && !comments.length && p.event !== "approve") add("pending-text", "a review that does not approve needs a body or an inline comment");
	const texts = [["text", route.text], ...Object.entries(isObject(p.bodies) ? p.bodies : {}).map(([k, v]) => [`bodies.${k}`, v]), ...comments.map((c, i) => [`comments[${i}].text`, c?.text])];
	for (const [name, text] of texts) {
		const hit = botCommandIn(text, commands);
		if (hit) add("pending-bot-command", `${name} holds "${hit}", which a bot in the repo could take as a command`);
	}
	return out;
}

/**
 * The lines on the right side of a file's diff, per hunk: `[{ start, end, lines: Set }]`. A comment must name lines of
 * one hunk, because GitHub refuses inline comments elsewhere.
 */
export function rightSideHunks(patch) {
	const hunks = [];
	let hunk = null;
	let line = 0;
	for (const text of String(patch ?? "").split("\n")) {
		const head = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
		if (head) {
			line = Number(head[1]);
			hunk = { lines: new Set() };
			hunks.push(hunk);
			continue;
		}
		if (!hunk || text.startsWith("-") || text.startsWith("\\")) continue;
		hunk.lines.add(line++);
	}
	return hunks;
}

/** Why GitHub would refuse an inline comment, or null. `files` maps a path to its patch, or to null without one. */
export function commentLineProblem(c, files) {
	const where = `${c.path}:${c.startLine !== undefined ? `${c.startLine}-` : ""}${c.line}`;
	if (!files.has(c.path)) return `The comment on ${where} names a file the PR does not change.`;
	const patch = files.get(c.path);
	if (patch === null) return `GitHub shows no diff for ${c.path}, so the comment on ${where} cannot go there.`;
	const first = c.startLine ?? c.line;
	const hunk = rightSideHunks(patch).find((h) => h.lines.has(c.line));
	if (!hunk) return `Line ${c.line} of ${c.path} is not in the PR's diff.`;
	for (let l = first; l <= c.line; l++) if (!hunk.lines.has(l)) return `The lines ${first}-${c.line} of ${c.path} are not in one hunk of the PR's diff.`;
	return null;
}

const MAX_WALK_TEXT = 400;
const MAX_STEP_TEXT = 300;
const MAX_STEPS = 6;

/**
 * The problems of an item's `walkthrough`: `{ why, what, how: [{ text, path, line? }] }` for a reader who has not seen
 * the PR. `why` says why the current code is not enough, `what` what the PR does, `how` how the changed pieces fit.
 */
export function walkthroughProblems(item) {
	const w = item.walkthrough;
	if (w === undefined || w === null) return [];
	const out = [];
	if (item.kind !== "pr") out.push("walkthrough is only for PRs");
	if (!isObject(w)) return [...out, "walkthrough must be { why, what, how }"];
	for (const key of Object.keys(w)) if (!["why", "what", "how"].includes(key)) out.push(`walkthrough.${key} is unknown`);
	for (const key of ["why", "what"]) {
		if (!(typeof w[key] === "string" && w[key].trim() && w[key].length <= MAX_WALK_TEXT)) out.push(`walkthrough.${key} must be a text of at most ${MAX_WALK_TEXT} characters`);
	}
	if (!Array.isArray(w.how) || !w.how.length || w.how.length > MAX_STEPS) return [...out, `walkthrough.how must be a list of 1 to ${MAX_STEPS} steps`];
	w.how.forEach((s, i) => {
		const at = `walkthrough.how[${i}]`;
		if (!isObject(s)) return out.push(`${at} must be { text, path, line }`);
		for (const key of Object.keys(s)) if (!["text", "path", "line"].includes(key)) out.push(`${at}.${key} is unknown`);
		if (!(typeof s.text === "string" && s.text.trim() && s.text.length <= MAX_STEP_TEXT)) out.push(`${at}.text must be a text of at most ${MAX_STEP_TEXT} characters`);
		if (!(typeof s.path === "string" && s.path.trim() && !s.path.startsWith("/") && !s.path.split("/").includes(".."))) out.push(`${at}.path must be a changed file, relative to the repo root`);
		if (s.line !== undefined && !(Number.isInteger(s.line) && s.line > 0)) out.push(`${at}.line must be a line number on the right side of the diff`);
	});
	return out;
}

/** The link to a file of the PR's diff on GitHub, at a line of the right side when `line` is given. */
export function diffUrl(prUrl, path, line) {
	const base = String(prUrl ?? "").split("#")[0].replace(/\/(files|commits)\/?$/, "");
	const anchor = `diff-${createHash("sha256").update(path).digest("hex")}${Number.isInteger(line) ? `R${line}` : ""}`;
	return `${base}/files#${anchor}`;
}

/** The walkthrough as the server serves it: each step gets `url`, its link into the diff. */
export function servedWalkthrough(item) {
	if (!isObject(item?.walkthrough) || !Array.isArray(item.walkthrough.how) || walkthroughProblems(item).length) return null;
	return { ...item.walkthrough, how: item.walkthrough.how.map((s) => ({ ...s, url: diffUrl(item.url, s.path, s.line) })) };
}
