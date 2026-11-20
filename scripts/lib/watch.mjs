// The watch on the PRs we control: every open PR by the instance's bot, Gary's fix PRs in fixes.json among them,
// and every PR whose item has `takenOver: true`. Their drive file in <state>/drive/ has the stage "review" while a review bot round waits, and
// "watch" while only the maintainer's feedback is awaited. A watched PR without a drive file counts as "watch".
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { runAction } from "./actions.mjs";
import { ID_PATTERN, boardDir, readJson, writeAtomic } from "./board-store.mjs";
import { ACTION_KINDS, listClaims } from "./claims.mjs";
import { instanceName } from "./config.mjs";
import { driveDir, fixRecordOf, prItemId, readDrives, readFixRecords, readSnapshotItems } from "./fixes.mjs";

// No PR gets more review bot rounds than this over its whole life
export const REVIEW_ROUND_CAP = 3;
export const SIDES = ["me", "others"];
export const WATCH_TRIGGERS = { me: "maintainer", others: "others" };

/** "review" while a drive waits for its review bot, "watch" otherwise. */
export function stageOf(drive) {
	if (!drive) return "watch";
	if (drive.stage === "watch" || drive.stage === "review") return drive.stage;
	return typeof drive.reviewRequestedAt === "string" ? "review" : "watch";
}

const latest = (...times) => times.filter((t) => Number.isFinite(Date.parse(t ?? ""))).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;

/**
 * The time up to which the feedback of `side` counts as handled: our last push, or the feedback the last round read,
 * whichever is later. The time a fix PR was recorded is the floor. `feedback` is the PR's `feedback` from the snapshot
 * or the facts of a fresh entry.
 */
export function handledUntil(side, { drive, feedback, item, record }) {
	return latest(drive?.seenAt?.[side], drive?.lastPushedAt, feedback?.ourLastCommitAt, item?.pushed?.at, record?.at);
}

/** The newest feedback of `side` that no round handled, as its ISO time, or null. */
export function unhandledFeedback(side, sources) {
	const at = sources.feedback?.[side === "me" ? "lastMeAt" : "lastOthersAt"];
	if (!Number.isFinite(Date.parse(at ?? ""))) return null;
	const until = handledUntil(side, sources);
	return until && Date.parse(at) <= Date.parse(until) ? null : at;
}

/** How many review bot rounds the PR had: the requests a drive recorded, or the bot's reviews on GitHub when more. */
export function reviewRoundsUsed(drive, feedback) {
	let recorded = 0;
	if (Number.isInteger(drive?.copilotRounds)) recorded = drive.copilotRounds;
	else if (drive && stageOf(drive) === "review") recorded = (Array.isArray(drive.rounds) ? drive.rounds.length : 0) + 1;
	return Math.max(recorded, Number.isInteger(feedback?.reviewBotReviews) ? feedback.reviewBotReviews : 0);
}

/** The cap on review bot rounds of a watched PR: the drive's `maxRounds`, at most REVIEW_ROUND_CAP. */
export function reviewRoundCap(drive) {
	return Math.min(Number.isInteger(drive?.maxRounds) ? drive.maxRounds : REVIEW_ROUND_CAP, REVIEW_ROUND_CAP);
}

async function readCollection(instance, name) {
	const dir = join(boardDir(instance), name);
	let names = [];
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const out = [];
	for (const n of names) {
		const data = await readJson(join(dir, n));
		if (data && ID_PATTERN.test(n.slice(0, -5))) out.push({ id: n.slice(0, -5), data });
	}
	return out;
}

/**
 * The item ids with push work in progress: an unexpired push claim, a queued or claimed pushing request, or a drive
 * that waits for its review bot. A drive file in the stage "watch" is no push work.
 */
export async function pushWork(instance = instanceName()) {
	const out = new Set();
	for (const c of await listClaims({ instance })) if (!c.expired && c.kind === "push") out.add(c.itemId);
	for (const { data: a } of await readCollection(instance, "actions")) {
		if (ACTION_KINDS[a.action] === "push" && a.status === "queued" && typeof a.itemId === "string") out.add(a.itemId);
	}
	for (const [itemId, drive] of Object.entries(await readDrives(instance))) if (stageOf(drive) === "review") out.add(itemId);
	return out;
}

const isBy = (author, login) => !!login && String(author ?? "").toLowerCase() === login.toLowerCase();

/**
 * Every watched PR of the instance: `{ itemId, number, repo, why, fixFor, record, drive, item, entry }`. `why` is "fix"
 * for a fix PR in fixes.json, "bot" for another PR by `botLogin`, and "taken_over" for a PR whose item has
 * `takenOver: true`. A PR counts while its drive file exists or the snapshot lists it as open, so merged and closed
 * PRs drop out. `entry` is its snapshot entry. Call it inside the instance's scope.
 */
export async function watchedPrs(instance = instanceName(), repo, botLogin = null) {
	const [records, drives, items, snapshot] = await Promise.all([readFixRecords(), readDrives(instance), readCollection(instance, "items"), readSnapshotItems()]);
	const byId = new Map(items.map(({ id, data }) => [id, data]));
	const out = new Map();
	for (const [fixFor, list] of Object.entries(records)) {
		for (const r of list ?? []) {
			if (!Number.isSafeInteger(r?.number)) continue;
			const itemId = prItemId(r.number);
			if (!drives[itemId] && !snapshot[itemId]) continue;
			out.set(itemId, { itemId, number: r.number, repo, why: "fix", fixFor, record: r, drive: drives[itemId] ?? null, item: byId.get(itemId) ?? null, entry: snapshot[itemId] ?? null });
		}
	}
	for (const [itemId, entry] of Object.entries(snapshot)) {
		const number = Number(/^pr-(\d+)$/.exec(itemId)?.[1]);
		if (out.has(itemId) || !Number.isSafeInteger(number) || !isBy(entry?.author, botLogin)) continue;
		out.set(itemId, { itemId, number, repo, why: "bot", fixFor: null, drive: drives[itemId] ?? null, item: byId.get(itemId) ?? null, entry });
	}
	for (const [itemId, item] of byId) {
		if (out.has(itemId) || item.kind !== "pr" || !Number.isSafeInteger(item.number)) continue;
		const why = isBy(item.author, botLogin) ? "bot" : item.takenOver === true ? "taken_over" : null;
		if (why) out.set(itemId, { itemId, number: item.number, repo: item.repo ?? repo, why, fixFor: null, drive: drives[itemId] ?? null, item, entry: snapshot[itemId] ?? null });
	}
	return [...out.values()].sort((a, b) => a.number - b.number);
}

/** The watched PR `number`, or null when it is no fix PR in fixes.json, no PR by `botLogin` and not taken over. */
export async function watchedPr(number, instance = instanceName(), repo, botLogin = null) {
	const itemId = prItemId(number);
	const hit = fixRecordOf(await readFixRecords(), number);
	const drive = await readJson(join(driveDir(instance), itemId + ".json"));
	const item = await readJson(join(boardDir(instance), "items", itemId + ".json"));
	const entry = (await readSnapshotItems())[itemId] ?? null;
	if (hit) return { itemId, number, repo, why: "fix", fixFor: hit.itemId, record: hit.record, drive, item, entry };
	if (isBy(entry?.author, botLogin) || (item?.kind === "pr" && isBy(item.author, botLogin))) return { itemId, number, repo: item?.repo ?? repo, why: "bot", fixFor: null, drive, item, entry };
	if (item?.kind === "pr" && item.takenOver === true) return { itemId, number, repo: item.repo ?? repo, why: "taken_over", fixFor: null, drive, item, entry };
	return null;
}

/** Moves the seen marks forward, never back. */
function seenAfter(seenAt, marks) {
	const out = { ...(seenAt ?? {}) };
	for (const side of SIDES) if (marks[side]) out[side] = latest(out[side], marks[side]);
	return out;
}

/**
 * The drive file of a watched PR after a round ended without a next review bot round: stage "watch", no pending
 * review request, no action doc. `sha` is the head after the round. A head other than `lastPushedSha` is our push.
 */
export function enterWatch(drive, { sha, seen = {}, now = new Date().toISOString() }) {
	const { reviewRequestedAt, actionId, ...rest } = drive;
	const pushed = typeof sha === "string" && sha !== drive.lastPushedSha;
	return {
		...rest,
		watch: true,
		stage: "watch",
		...(typeof sha === "string" && { lastPushedSha: sha }),
		...(pushed && { lastPushedAt: now }),
		seenAt: seenAfter(drive.seenAt, seen),
		watchSince: now,
	};
}

/** The drive file of a watched PR after a review bot round was requested. */
export function enterReview(drive, { sha, actionId, seen = {}, now = new Date().toISOString(), used }) {
	const pushed = typeof sha === "string" && sha !== drive.lastPushedSha;
	return {
		...drive,
		watch: true,
		stage: "review",
		actionId,
		copilotRounds: used + 1,
		reviewRequestedAt: now,
		...(typeof sha === "string" && { lastPushedSha: sha }),
		...(pushed && { lastPushedAt: now }),
		seenAt: seenAfter(drive.seenAt, seen),
	};
}

/** The seen marks given on the command line, each checked to be an ISO time. */
export function seenMarks(out) {
	const seen = {};
	for (const [flag, side] of [["seen-me", "me"], ["seen-others", "others"]]) {
		if (out[flag] === undefined) continue;
		if (!Number.isFinite(Date.parse(out[flag]))) throw new Error(`--${flag} must be an ISO time`);
		seen[side] = new Date(out[flag]).toISOString();
	}
	return seen;
}

/**
 * Requests the maintainer's review on a watched PR after a round ended cleanly. Never throws.
 * Returns `{ requested: true, url }`, `{ requested: false, skipped }` when a rule says no, `{ requested: false, error }`
 * when the request failed, and in a dry run `{ requested: false, dryRun: true, invocations }`.
 * `markedReady` tells that the same dry run marked the PR ready.
 */
export async function requestMaintainerReview({ repo, number, dryRun = false, markedReady = false }) {
	const r = await runAction({ action: "request_review", kind: "pr", number, repo, params: { reviewer: "maintainer" }, dryRun, markedReady });
	if (!r.ok) return { requested: false, error: `Your review was not requested: ${r.result}` };
	if (r.skipped) return { requested: false, skipped: r.skipped };
	if (dryRun) return { requested: false, dryRun: true, invocations: r.result.invocations };
	return { requested: true, url: r.result };
}

export const driveFile = (itemId, instance = instanceName()) => join(driveDir(instance), itemId + ".json");

export async function writeDrive(itemId, drive, instance = instanceName()) {
	await writeAtomic(driveFile(itemId, instance), drive);
}

/** Removes the drive file of a PR that was merged or closed, when it only watches. */
export async function dropWatch(itemId, instance = instanceName()) {
	const drive = await readJson(driveFile(itemId, instance));
	if (!drive || stageOf(drive) !== "watch") return false;
	await unlink(driveFile(itemId, instance)).catch((e) => {
		if (e.code !== "ENOENT") throw e;
	});
	return true;
}
