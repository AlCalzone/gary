// The watch on the PRs we control: every open PR by the instance's bot, Gary's fix PRs in fixes.json among them,
// and every PR whose item has `takenOver: true`. Their drive file in <state>/drive/ has the stage "review" while a review bot round waits, and
// "watch" while only the maintainer's feedback is awaited. A watched PR without a drive file counts as "watch".
import { randomBytes } from "node:crypto";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { runAction } from "./actions.mjs";
import { ID_PATTERN, boardDir, readJson, writeAtomic } from "./board-store.mjs";
import { ACTION_KINDS, listClaims } from "./claims.mjs";
import { fixReviewOf, instanceName, loadInstance, reviewBotsOf } from "./config.mjs";
import { PAUSED_MESSAGE, isPaused } from "./control.mjs";
import { sensitiveOurs, touchesSensitive } from "./facts.mjs";
import { accountMode, postReviewTrigger, writeLogin } from "./gh.mjs";
import { COPILOT, botName, botNames, driveBot, isBotAuthor, roundBots } from "./review-bots.mjs";
import { focusHold, focusRefusal } from "./focus.mjs";
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

export const latest = (...times) => times.filter((t) => Number.isFinite(Date.parse(t ?? ""))).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;

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

/**
 * The drive file's `held` record while the feedback it names is still unhandled, or null. `gary pr-watch round` writes
 * `held: { feedbackAt, by: "me", session, since }` when it refused the maintainer's feedback because the origin session was active,
 * and adds `focus: true` when a focus held the PR.
 */
export function pendingHold(sources) {
	const held = sources.drive?.held;
	if (held?.by !== "me" || !Number.isFinite(Date.parse(held.feedbackAt ?? ""))) return null;
	return unhandledFeedback("me", { ...sources, feedback: { lastMeAt: held.feedbackAt } }) ? held : null;
}

/**
 * The rounds per bot a drive file recorded: `{ <key>: { rounds, sha, at } }`. `rounds` is the number of review bot rounds
 * the PR had when the bot was last asked, `sha` the head it was asked on. A drive file from before several bots has
 * `copilotRounds` and `reviewBot` in place of it, and no head.
 */
export function botRoundsOf(drive) {
	if (drive?.botRounds && typeof drive.botRounds === "object" && !Array.isArray(drive.botRounds)) return drive.botRounds;
	if (!Number.isInteger(drive?.copilotRounds)) return {};
	const bots = roundBots(drive);
	return Object.fromEntries((bots.length ? bots : [{ key: COPILOT }]).map((b) => [b.key, { rounds: drive.copilotRounds }]));
}

/** How many review bot rounds the PR had: the requests a drive recorded, or the bots' reviews on GitHub when more. */
export function reviewRoundsUsed(drive, feedback) {
	let recorded = 0;
	const counts = Object.values(botRoundsOf(drive)).map((r) => r?.rounds).filter(Number.isInteger);
	if (counts.length) recorded = Math.max(...counts);
	else if (drive && stageOf(drive) === "review") recorded = (Array.isArray(drive.rounds) ? drive.rounds.length : 0) + 1;
	return Math.max(recorded, Number.isInteger(feedback?.reviewBotReviews) ? feedback.reviewBotReviews : 0);
}

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const sameSha = (a, b) => typeof a === "string" && typeof b === "string" && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

/**
 * The state of each bot on a PR, from its fresh snapshot entry: `[{ key, trigger, login, name, reviewedAt, commit, onHead, openThreads }]`.
 * `onHead` says that the bot's newest review is on the PR's head. `openThreads` counts its unresolved threads.
 */
export function botStates(bots, entry) {
	return bots.map((bot) => {
		const last = (entry?.lastReviews ?? []).filter((r) => isBotAuthor(bot, r.author)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
		const openThreads = (entry?.reviewSummary ?? []).filter((r) => isBotAuthor(bot, r.author)).reduce((n, r) => n + (Number.isInteger(r.openThreadCount) ? r.openThreadCount : 0), 0);
		return { ...driveBot(bot), name: botName(bot), reviewedAt: last?.at ?? null, commit: last?.commit ?? null, onHead: sameSha(last?.commit, entry?.headSha), openThreads };
	});
}

/** A round is clean when every bot's newest review is on the PR's head and none of its threads is unresolved. */
export const roundClean = (states) => states.length > 0 && states.every((s) => s.onHead && s.openThreads === 0);

/**
 * Whether every bot of the drive's round reviewed the head it was asked on, after the request. A bot without a recorded
 * head counts on `lastPushedSha`. `entry` is the PR's fresh snapshot entry.
 */
export function roundArrived(drive, entry) {
	const since = Date.parse(drive.reviewRequestedAt ?? "");
	const bots = roundBots(drive);
	if (!bots.length || !Number.isFinite(since)) return false;
	const asked = botRoundsOf(drive);
	return bots.every((bot) => {
		const head = asked[bot.key]?.sha ?? drive.lastPushedSha;
		return (entry?.lastReviews ?? []).some((r) => isBotAuthor(bot, r.author) && Date.parse(r.at) > since && sameSha(r.commit, head));
	});
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
	const { reviewRequestedAt, actionId, held, ...rest } = drive;
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

/**
 * The drive file of a watched PR after a review bot round was requested. `bots` are the bots it asked on `sha`.
 * The fields of a drive file from before several bots, `copilotRounds` and `reviewBot`, give way to `botRounds` and `reviewBots`.
 */
export function enterReview(drive, { sha, actionId, seen = {}, now = new Date().toISOString(), used, bots }) {
	const pushed = typeof sha === "string" && sha !== drive.lastPushedSha;
	const { held, copilotRounds, reviewBot, ...rest } = drive;
	const botRounds = { ...botRoundsOf(drive) };
	for (const bot of bots) botRounds[bot.key] = { rounds: used + 1, ...(typeof sha === "string" && { sha }), at: now };
	return {
		...rest,
		watch: true,
		stage: "review",
		actionId,
		reviewBots: bots.map(driveBot),
		botRounds,
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

/** A rule refused the step. The commands exit 3 on it. */
export class Refused extends Error {}

/**
 * The watched PR `number` with its fix review settings and its cap on review bot rounds. Throws for any other PR.
 * With `takingOver` a contributor PR counts as taken over, because the take-over that pushed to it is not recorded yet.
 */
export async function watchContext(number, { takingOver = false } = {}) {
	const instance = loadInstance(instanceName());
	const repo = instance.repos[0];
	let pr = await watchedPr(number, instanceName(), repo, instance.config.bot?.login ?? null);
	if (!pr && takingOver) {
		const itemId = prItemId(number);
		const item = await readJson(join(boardDir(), "items", itemId + ".json"));
		if (item?.kind === "pr") pr = { itemId, number, repo: item.repo ?? repo, why: "taken_over", fixFor: null, drive: await readJson(driveFile(itemId)), item, entry: (await readSnapshotItems())[itemId] ?? null };
	}
	if (!pr) throw new Error(`PR #${number} is no PR by the bot, no fix PR Gary recorded in fixes.json and no PR it took over. Only those are watched.`);
	const settings = fixReviewOf(instance.config, instance.profile);
	return { ...pr, settings, bots: reviewBotsOf(instance.config, instance.profile), cap: pr.why === "fix" && settings.maxRounds ? Math.min(settings.maxRounds, REVIEW_ROUND_CAP) : REVIEW_ROUND_CAP };
}

/** The drive file a watched PR starts from when it has none yet. */
export function baseDrive(c) {
	return {
		repo: c.repo,
		number: c.number,
		by: c.why === "fix" ? "fix" : "watch",
		...(c.fixFor && { fixFor: c.fixFor }),
		watch: true,
		stage: "watch",
		maxRounds: c.cap,
		reviewBots: c.bots.map(driveBot),
		...(c.why === "fix" && { markReady: c.settings.markReady }),
		rounds: [],
		lastPushedSha: c.entry?.headSha ?? c.item?.reviewedSha ?? null,
		seenAt: {},
	};
}

export const feedbackOf = (c) => c.entry?.feedback ?? c.entry?.facts ?? {};

// In the own mode our replies post under the maintainer's login, so a round marks all the maintainer's feedback up to now as seen
export function marksFor(seen) {
	return accountMode() === "own" ? { ...seen, me: new Date().toISOString() } : seen;
}

// The agent jobs that push to a PR and are followed by a review bot round. `format` pushes only formatter output
export const PUSH_JOBS = ["revise", "take_over", "address_review"];

/** The clicked job doc `id` that just pushed to PR item `itemId`. It must still be queued and claimed. */
async function pushJob(id, itemId) {
	if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("--after must name the action doc of the job that pushed");
	const doc = await readJson(join(boardDir(), "actions", id + ".json"));
	if (!doc || doc.itemId !== itemId) throw new Error(`Action ${id} is no request for ${itemId}`);
	if (!PUSH_JOBS.includes(doc.action)) throw new Refused(`A ${doc.action} job requests no review bot round. Only ${PUSH_JOBS.join(", ")} do.`);
	if (doc.action === "take_over" && (doc.params?.mode ?? "push") !== "push") throw new Refused("A take-over in the replace mode opens a new PR and requests no review bot round on this one.");
	if (doc.status !== "queued" || typeof doc.result !== "string" || !doc.result.startsWith("claimed by")) throw new Error(`Action ${id} is not a running job`);
	return doc;
}

/**
 * Asks each bot in `bots` for its review of head `sha` on a PR, under your login or with `as: "bot"` the bot's token:
 * Copilot and a bot with `trigger: "request"` through `request_review`, a bot with a trigger comment through
 * `postReviewTrigger`. Throws `Refused` before it sends anything when `drive` records that a bot was asked on `sha` already.
 * Stops at the first failure. Returns `{ ok: true, asked, invocations, warning }` when at least one bot was asked,
 * with `warning` naming the failure, `{ ok: false, result }` when none was, and `{ ok: false, paused: true }` while paused.
 */
export async function askReviewBots({ repo, number, bots, sha, drive = null, as = "me", dryRun = false }) {
	const asked = botRoundsOf(drive);
	const twice = bots.filter((b) => sameSha(asked[b.key]?.sha, sha));
	if (twice.length) throw new Refused(`${botNames(twice)} ${twice.length === 1 ? "was" : "were"} already asked to review ${sha.slice(0, 7)} on PR #${number}. A bot is asked once per head.`);
	const out = { asked: [], invocations: [] };
	let failure = null;
	// The pause is checked once. A pause that starts between two bots must not hide the bots already asked
	if (isPaused()) return { ok: false, paused: true, result: PAUSED_MESSAGE };
	for (const bot of bots) {
		if (bot.trigger === "comment") {
			try {
				const posted = await postReviewTrigger({ repo, number, key: bot.key, as, dryRun });
				if (dryRun) out.invocations.push(posted.invocation);
			} catch (e) {
				failure = bots.length === 1 ? e.message : `${botName(bot)}: ${e.message}`;
				break;
			}
		} else {
			const r = await runAction({ action: "request_review", kind: "pr", number, repo, params: { reviewer: bot.trigger === COPILOT ? COPILOT : bot.login, as }, dryRun });
			if (r.paused && !out.asked.length) return { ok: false, paused: true, result: PAUSED_MESSAGE };
			if (!r.ok) {
				failure = bots.length === 1 ? r.result : `${botName(bot)}: ${r.result}`;
				break;
			}
			if (dryRun) out.invocations.push(...r.result.invocations);
		}
		out.asked.push(bot);
	}
	if (!out.asked.length) return { ok: false, result: `The review was not requested: ${failure}` };
	return { ok: true, ...out, ...(failure && { warning: `Not every review bot was asked. ${failure}` }) };
}

/**
 * Requests the next review bot round on a watched PR and puts its drive file into the stage "review".
 * A drive round names its action doc with `actionId`, or the drive file has one. A job that pushed outside a drive
 * passes `after`, the id of its own action doc, or `apiEdit` for an API edit of the server. Then a new `drive` action
 * doc is written, claimed by `run`, and `sha` must be a new head. Throws `Refused` when a rule says no.
 * Returns `{ ok: false, paused: true }` while the instance is paused, and `{ ok: true, requested: false, skipped }`
 * when the instance asks no review bot or `fixReview.maxRounds` is 0 on a fix PR.
 */
export async function requestReviewRound({ number, sha, actionId, after, apiEdit = false, run, seen = {}, dryRun = false }) {
	if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/.test(sha)) throw new Error("--sha must be the PR's head commit");
	const fromJob = after !== undefined || apiEdit;
	if (fromJob && actionId !== undefined) throw new Error("--action and --after exclude each other");
	if (fromJob && (typeof run !== "string" || !run.trim() || run.length > 200)) throw new Error("--run must name the run that pushed");
	const itemId = prItemId(number);
	const job = after !== undefined ? await pushJob(after, itemId) : null;
	const c = await watchContext(number, { takingOver: job?.action === "take_over" });
	if (!c.bots.length) return { ok: true, requested: false, skipped: `${c.settings.noReviewBot ? capital(c.settings.reason) : "The instance asks no review bot"}, so no review bot round is requested. Go on as if the rounds were done.`, itemId: c.itemId };
	if (isPaused()) return { ok: false, paused: true, result: PAUSED_MESSAGE };
	if (!writeLogin()) throw new Refused("No account may push: the instance has no bot and allowOwnTokenPushes is off.");
	if (c.entry && touchesSensitive(c.entry) && !sensitiveOurs(c.entry)) throw new Refused(`PR #${c.number} changes sensitive files and is not ours alone, so it gets no review bot rounds.`);
	const focus = focusHold(c.itemId);
	if (focus) throw new Refused(focusRefusal(c.itemId, focus));
	const drive = c.drive ?? baseDrive(c);
	if (fromJob) {
		if (stageOf(drive) === "review") throw new Refused(`A review bot round already waits on PR #${c.number}.`);
		const before = [c.entry?.headSha, c.item?.reviewedSha, drive.lastPushedSha].filter((x) => typeof x === "string");
		if (before.some((x) => x.startsWith(sha) || sha.startsWith(x))) throw new Refused(`${sha.slice(0, 7)} is the head from before the job, so nothing was pushed and no review bot round is requested.`);
	}
	const id = fromJob ? `${itemId}-${Date.now()}-${randomBytes(2).toString("hex")}` : actionId ?? drive.actionId;
	if (typeof id !== "string") throw new Error("--action must name the drive's action doc, because the PR has no running drive");
	const used = reviewRoundsUsed(drive, feedbackOf(c));
	const cap = c.why === "fix" ? Math.min(reviewRoundCap(drive), c.cap) : REVIEW_ROUND_CAP;
	if (used >= cap) throw new Refused(`PR #${c.number} had ${used} of ${cap} review bot rounds. No more are requested.`);
	const request = await askReviewBots({ repo: c.repo, number: c.number, bots: c.bots, sha, drive, as: c.why === "fix" ? c.settings.requestAs : "me", dryRun });
	if (request.paused) return { ok: false, paused: true, result: PAUSED_MESSAGE };
	if (!request.ok) return { ok: false, result: request.result };
	const now = new Date().toISOString();
	const doc = fromJob && {
		itemId: c.itemId,
		action: "drive",
		params: { by: drive.by ?? (c.why === "fix" ? "fix" : "watch"), ...(c.fixFor && { fixFor: c.fixFor }), maxRounds: cap, after: job?.action ?? "api_edit" },
		text: "",
		status: "queued",
		via: "queue",
		createdAt: now,
		finishedAt: null,
		result: `claimed by run ${run}`,
	};
	const next = enterReview(drive, { sha, actionId: id, seen: marksFor(seen), used, now, bots: request.asked });
	if (dryRun) return { ok: true, dryRun: true, invocations: request.invocations, wouldWrite: { ...(doc && { action: doc }), drive: next } };
	if (doc) {
		await mkdir(join(boardDir(), "actions"), { recursive: true });
		await writeAtomic(join(boardDir(), "actions", id + ".json"), doc);
	}
	await mkdir(driveDir(), { recursive: true });
	await writeDrive(c.itemId, next);
	return { ok: true, requested: true, round: used + 1, cap, bots: request.asked.map((b) => b.key), ...(request.warning && { warning: request.warning }), actionId: id, itemId: c.itemId };
}
