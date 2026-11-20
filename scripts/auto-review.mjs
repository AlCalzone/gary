// The one automatic first review on a contributor's PR, the only review that reaches a contributor without a click.
//   gary auto-review check --pr <n> [--sha <head sha>] [--run <run>]
//     Says whether the PR may get one now, and why not. Read-only.
//   gary auto-review post --pr <n> --sha <head sha> --run <run> --file <review.json> [--dry-run]
//     Posts the review doc { summary, findings, comments } after every rule passed, and records it.
//   gary auto-review accept --pr <n> [--run <run>]
//     Queues the format job after the PR's author reacted positively to the format offer.
//   gary auto-review reply --pr <n> --at <ISO time of the reply> --agrees yes|no [--run <run>]
//     Records the judgement of a reply to the offer. `yes` queues the format job.
//   gary auto-review rerequest --pr <n>
//     Queues a full review after the author re-requested one.
//   gary auto-review list [--json]
//     The recorded reviews, and per PR whether it still waits for its contributor.
// Exit codes: 0 done, 3 refused by a rule, 4 paused, 1 everything else.
import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runAction } from "./lib/actions.mjs";
import { autoReviewState, autoReviewsFile, composeBody, actionComments, lastReview, maintainerJoinedAt, offerKind, reRequestedAt, readAutoReviews, refusal, templateText, TEMPLATE_DEFAULTS, updateAutoReview, validateAutoReview } from "./lib/auto-review.mjs";
import { boardDir, readJson, writeAtomic } from "./lib/board-store.mjs";
import { claimRefusal, listClaims, releaseClaim, takeClaim } from "./lib/claims.mjs";
import { autoReviewOf, instanceName, loadInstance, maintainerLogins } from "./lib/config.mjs";
import { PAUSED_MESSAGE, isPaused } from "./lib/control.mjs";
import { prItemId, readSnapshotItems } from "./lib/fixes.mjs";
import { accountMode, writeLogin } from "./lib/gh.mjs";
import { logDecision } from "./lib/learning.mjs";
import { fetchItem } from "./snapshot.mjs";

const USAGE = "Usage: gary auto-review check --pr <n> [--sha <sha>] [--run <run>] | post --pr <n> --sha <sha> --run <run> --file <review.json> [--dry-run] | accept --pr <n> [--run <run>] | reply --pr <n> --at <ISO> --agrees yes|no [--run <run>] | rerequest --pr <n> | list [--json]";
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

class Refused extends Error {
	constructor(code, message, extra = {}) {
		super(message);
		this.code = code;
		this.extra = extra;
	}
}

function options(argv, names) {
	const out = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (names.includes(argv[i])) out[argv[i].slice(2)] = argv[++i];
		else rest.push(argv[i]);
	}
	return { out, rest };
}

async function context(prArg) {
	const number = Number(prArg);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("--pr must be a PR number");
	const instance = loadInstance(instanceName());
	// Last-good settings keep the board up. They are no base for posting on his behalf
	if (instance.settingsError) throw new Refused("settings", `The settings of ${instance.name} are invalid, so nothing is posted: ${instance.settingsError}`);
	const itemId = prItemId(number);
	const records = await readAutoReviews();
	return { number, instance, repo: instance.repos[0], itemId, records, record: records[itemId] ?? null, settings: autoReviewOf(instance.config, instance.profile) };
}

const wouldHaveFile = (instance, run) => join(instance.state, "runs", run, "would-have.json");

async function readWouldHave(instance, run) {
	try {
		const list = JSON.parse(await readFile(wouldHaveFile(instance, run), "utf8"));
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}

async function recordWouldHave(instance, run, entry) {
	const list = await readWouldHave(instance, run);
	await mkdir(join(instance.state, "runs", run), { recursive: true });
	await writeAtomic(wouldHaveFile(instance, run), [...list, entry]);
}

async function writeAction(itemId, doc) {
	const dir = join(boardDir(), "actions");
	await mkdir(dir, { recursive: true });
	const id = `${itemId}-${Date.now()}-${randomBytes(2).toString("hex")}`;
	await writeAtomic(join(dir, id + ".json"), { itemId, ...doc });
	return id;
}

/** Throws the refusal of the shared rules, with the reviews this run already posted or would have posted. */
async function checkRules(c, entry, { sha, run, counted = true }) {
	const posted = Object.values(c.records).flatMap((r) => r.reviews ?? []).filter((r) => run && r.run === run).length;
	const intended = run && counted ? (await readWouldHave(c.instance, run)).filter((e) => e?.action === "auto_review").length : 0;
	const no = refusal({ entry, sha, settings: c.settings, profile: c.instance.profile, maintainers: maintainerLogins(), writeLogin: writeLogin(), record: c.record, runCount: posted + intended });
	if (no) throw new Refused(no.code, no.message);
}

async function check(argv) {
	const { out, rest } = options(argv, ["--pr", "--sha", "--run"]);
	if (rest.length || !out.pr) throw new Error(USAGE);
	const c = await context(out.pr);
	if (!c.settings.enabled) return { ok: true, qualifies: false, refused: "off", result: `The automatic review is off${c.settings.reason ? `: ${c.settings.reason}` : ""}.` };
	const entry = await fetchItem("pr", c.number, c.repo);
	try {
		await checkRules(c, entry, { sha: out.sha, run: out.run });
	} catch (e) {
		if (!(e instanceof Refused)) throw e;
		return { ok: true, qualifies: false, refused: e.code, result: e.message };
	}
	const last = lastReview(c.record);
	return { ok: true, qualifies: true, reason: last ? "re_requested" : "first", headSha: entry.headSha, maintainerCanModify: entry.facts.maintainerCanModify, offerMade: !!c.record?.offer };
}

async function post(argv) {
	const { out, rest } = options(argv, ["--pr", "--sha", "--run", "--file"]);
	const dryRun = rest.includes("--dry-run");
	if (rest.filter((a) => a !== "--dry-run").length || !out.pr || !out.file) throw new Error(USAGE);
	if (typeof out.sha !== "string" || !/^[0-9a-f]{40}$/.test(out.sha)) throw new Error("--sha must be the full head commit the review was made on");
	if (!RUN_NAME.test(out.run ?? "")) throw new Error("--run must name the run");
	const c = await context(out.pr);
	if (!c.settings.enabled) throw new Refused("off", `The automatic review is off${c.settings.reason ? `: ${c.settings.reason}` : ""}.`);
	if (accountMode() === "none") throw new Refused("account", "No account may post a review: there is no bot and allowOwnTokenPushes is false.");

	let doc;
	try {
		doc = JSON.parse(await readFile(out.file, "utf8"));
	} catch (e) {
		throw new Error(`Cannot read the review doc ${out.file}: ${e.message}`);
	}
	const problems = validateAutoReview(doc);
	if (problems.length) throw new Refused("invalid-review", `The review doc may not go out:\n- ${problems.join("\n- ")}`, { problems });
	const findings = doc.findings ?? [];
	const comments = doc.comments ?? [];

	const entry = await fetchItem("pr", c.number, c.repo);
	await checkRules(c, entry, { sha: out.sha, run: out.run });
	const item = await readJson(join(boardDir(), "items", c.itemId + ".json"));
	// The post is a step after the full review, and the item carries the autofix check of that head
	if (!item || item.reviewDepth !== "full" || item.reviewedSha !== out.sha) {
		throw new Refused("item", `The board item ${c.itemId} holds no full review of ${out.sha}. Write the item first.`);
	}
	const offer = offerKind({ autofix: item.autofix, record: c.record, maintainerCanModify: entry.facts.maintainerCanModify, formatCommand: c.instance.profile.formatCommand });
	if (!findings.length && !offer) throw new Refused("clean", `There is nothing certain to say on PR #${c.number}. A clean PR gets no automatic review.`);

	const claims = (await listClaims()).filter((x) => x.itemId === c.itemId && !x.expired);
	if (claims.some((x) => x.kind === "push")) throw new Refused("pushing", `An agent is changing PR #${c.number}.`);
	const held = claims.some((x) => x.kind === "review" && x.run === out.run);
	const claim = await takeClaim({ itemId: c.itemId, kind: "review", run: out.run });
	if (!claim.ok) throw new Refused(claim.focus ? "focus" : "claimed", claim.focus ? claimRefusal(c.itemId, "review", claim) : `Run ${claim.holder?.run} holds the review claim on ${c.itemId}.`);

	try {
		const templates = {};
		for (const name of Object.keys(TEMPLATE_DEFAULTS)) templates[name] = await templateText(c.instance.profileDir, name);
		const event = findings.length ? "request_changes" : "comment";
		const text = composeBody({ summary: doc.summary ?? "", hasFindings: findings.length > 0, offer, autofix: item.autofix, formatCommand: c.instance.profile.formatCommand, templates });
		const request = { action: "review", kind: "pr", number: c.number, repo: c.repo, params: { event, sha: out.sha, ...(comments.length && { comments: actionComments(comments) }) }, text };
		const summary = { pr: c.number, sha: out.sha, event, findings: findings.length, comments: comments.length, offer };

		if (isPaused()) {
			await recordWouldHave(c.instance, out.run, { itemId: c.itemId, action: "auto_review", params: summary, reason: "paused" });
			return { ok: false, posted: false, paused: true, result: PAUSED_MESSAGE, wouldHave: summary };
		}
		const sent = await runAction({ ...request, dryRun });
		if (!sent.ok) return { ok: false, posted: false, result: `The review was not posted: ${sent.result}` };
		if (dryRun) {
			await recordWouldHave(c.instance, out.run, { itemId: c.itemId, action: "auto_review", params: summary, reason: "dry run" });
			return { ok: true, posted: false, dryRun: true, event, text, invocations: sent.result.invocations, wouldHave: summary };
		}

		const now = new Date().toISOString();
		const reason = lastReview(c.record) ? "re_requested" : "first";
		const review = { sha: out.sha, at: now, url: sent.result, run: out.run, event, reason, findings: findings.map(({ severity, text: t, ref, evidence }) => ({ severity, text: t, ...(ref && { ref }), evidence })), comments: comments.length, offered: offer };
		await updateAutoReview(c.itemId, (cur) => ({
			...(cur ?? {}),
			repo: c.repo,
			number: c.number,
			author: entry.author,
			reviews: [...(cur?.reviews ?? []), review],
			...(offer && !cur?.offer && { offer: { kind: offer, at: now, url: sent.result, sha: out.sha, state: offer === "push" ? "open" : "named" } }),
		}));
		await logDecision(c.instance.name, "auto_review", c.itemId, item, { review: { url: sent.result, sha: out.sha, event, reason, comments: comments.length, offer }, findings: review.findings.map(({ severity, text: t, ref }) => ({ severity, text: t, ...(ref && { ref }) })) });
		return { ok: true, posted: true, url: sent.result, event, reason, findings: findings.length, comments: comments.length, offer, record: autoReviewsFile() };
	} finally {
		// A claim the review worker took for the whole review stays its own
		if (!held) await releaseClaim({ itemId: c.itemId, kind: "review", run: out.run });
	}
}

/** Queues the format job for an accepted offer. `by` is "reaction" or "reply", `at` the time of the reply. */
async function acceptOffer(c, { by, at, run }) {
	const offer = c.record?.offer;
	if (!offer || offer.kind !== "push" || offer.state !== "open") throw new Refused("no-offer", `PR #${c.number} has no open format offer.`);
	if (!c.settings.enabled) throw new Refused("off", `The automatic review is off${c.settings.reason ? `: ${c.settings.reason}` : ""}.`);
	if (isPaused()) return { ok: false, paused: true, result: PAUSED_MESSAGE };
	const entry = await fetchItem("pr", c.number, c.repo);
	if (entry.githubState !== "open") throw new Refused("not-open", `PR #${c.number} is ${entry.githubState}.`);
	const answer = entry.facts.formatOffer;
	// Only the PR's author accepts, with a reaction on the review or a comment after it
	if (by === "reaction" && answer?.acceptedByReaction !== true) throw new Refused("not-accepted", `The author of PR #${c.number} did not react positively to the offer.`);
	if (by === "reply" && !(answer?.replies ?? []).some((r) => r.at === at)) throw new Refused("not-accepted", `PR #${c.number} has no unjudged reply of its author at ${at}.`);
	const joined = maintainerJoinedAt(entry, { maintainers: maintainerLogins(), ownReviewUrls: c.record.reviews.map((r) => r.url) });
	if (Date.parse(joined ?? "") > Date.parse(offer.at)) {
		await updateAutoReview(c.itemId, (cur) => ({ ...cur, offer: { ...cur.offer, state: "closed", closedAt: new Date().toISOString() } }));
		throw new Refused("maintainer-active", `A maintainer joined PR #${c.number} at ${joined}. The offer is closed, and the format card is his.`);
	}
	if (entry.facts.maintainerCanModify !== true) throw new Refused("cannot-push", `PR #${c.number} no longer allows edits by maintainers.`);

	const holder = run ?? `auto-review-accept-${Date.now()}`;
	const claim = await takeClaim({ itemId: c.itemId, kind: "push", run: holder, ttlMinutes: 5 });
	if (!claim.ok) throw new Refused(claim.focus ? "focus" : "pushing", claim.focus ? claimRefusal(c.itemId, "push", claim) : `Run ${claim.holder?.run} is changing PR #${c.number}.`);
	try {
		const now = new Date().toISOString();
		const actionId = await writeAction(c.itemId, { action: "format", params: { reviewedSha: entry.headSha, by: "auto_review" }, text: "", status: "queued", via: "queue", createdAt: now, finishedAt: null, result: "" });
		await updateAutoReview(c.itemId, (cur) => ({
			...cur,
			offer: { ...cur.offer, state: "accepted", acceptedAt: now, acceptedBy: by, actionId, ...(by === "reply" && { replyAt: at, judged: [...new Set([...(cur.offer.judged ?? []), at])] }) },
		}));
		return { ok: true, accepted: true, by, actionId, itemId: c.itemId, reviewedSha: entry.headSha };
	} finally {
		await releaseClaim({ itemId: c.itemId, kind: "push", run: holder });
	}
}

async function accept(argv) {
	const { out, rest } = options(argv, ["--pr", "--run"]);
	if (rest.length || !out.pr) throw new Error(USAGE);
	return acceptOffer(await context(out.pr), { by: "reaction", run: out.run });
}

async function reply(argv) {
	const { out, rest } = options(argv, ["--pr", "--at", "--agrees", "--run"]);
	if (rest.length || !out.pr || !["yes", "no"].includes(out.agrees)) throw new Error(USAGE);
	if (!Number.isFinite(Date.parse(out.at ?? ""))) throw new Error("--at must be the time of the reply, as the watcher printed it");
	const c = await context(out.pr);
	if (out.agrees === "yes") return acceptOffer(c, { by: "reply", at: out.at, run: out.run });
	const offer = c.record?.offer;
	if (!offer || offer.state !== "open") throw new Refused("no-offer", `PR #${c.number} has no open format offer.`);
	await updateAutoReview(c.itemId, (cur) => ({ ...cur, offer: { ...cur.offer, judged: [...new Set([...(cur.offer.judged ?? []), out.at])] } }));
	return { ok: true, accepted: false, itemId: c.itemId };
}

async function rerequest(argv) {
	const { out, rest } = options(argv, ["--pr"]);
	if (rest.length || !out.pr) throw new Error(USAGE);
	const c = await context(out.pr);
	const last = lastReview(c.record);
	if (!last) throw new Refused("no-review", `PR #${c.number} has no automatic review.`);
	if (!c.settings.enabled) throw new Refused("off", `The automatic review is off${c.settings.reason ? `: ${c.settings.reason}` : ""}.`);
	if (isPaused()) return { ok: false, paused: true, result: PAUSED_MESSAGE };
	const entry = await fetchItem("pr", c.number, c.repo);
	await checkRules(c, entry, { counted: false });
	const at = reRequestedAt(entry, last.at);
	if (c.record.reRequestQueued === at) return { ok: true, queued: false, reason: `The review for the request of ${at} is already queued.` };
	const now = new Date().toISOString();
	const actionId = await writeAction(c.itemId, { action: "full_review", params: { repo: c.repo, number: c.number, by: "auto_review", reRequestedAt: at }, text: "The author re-requested a review.", status: "queued", via: "queue", createdAt: now, finishedAt: null, result: "" });
	await updateAutoReview(c.itemId, (cur) => ({ ...cur, reRequestQueued: at }));
	return { ok: true, queued: true, actionId, itemId: c.itemId, reRequestedAt: at };
}

async function list(argv) {
	const records = await readAutoReviews();
	// The same state the board serves, so the routine knows which PRs still wait for their contributor
	const snapshot = await readSnapshotItems();
	const states = {};
	for (const [id, record] of Object.entries(records)) {
		const state = autoReviewState(await readJson(join(boardDir(), "items", id + ".json")), record, snapshot[id]);
		if (state) states[id] = state;
	}
	if (argv.includes("--json")) return { ok: true, records, states };
	const lines = Object.entries(states).map(([id, st]) => {
		const r = records[id];
		return `${id}  ${st.count} review${st.count === 1 ? "" : "s"}, last ${st.at} (${st.event}), ${st.waiting ? "waiting for the contributor" : `since then: ${st.changed.join(", ")}`}${r.offer ? `, format offer ${r.offer.state}` : ""}  ${st.url}`;
	});
	return { ok: true, listing: lines.join("\n") || "No automatic review yet." };
}

const COMMANDS = { check, post, accept, reply, rerequest, list };

export async function main(argv) {
	const [command, ...rest] = argv;
	let outcome;
	try {
		if (!Object.hasOwn(COMMANDS, command ?? "")) throw new Error(USAGE);
		outcome = await COMMANDS[command](rest);
	} catch (e) {
		outcome = e instanceof Refused ? { ok: false, posted: false, refused: e.code, result: e.message, ...e.extra } : { ok: false, result: e.message };
	}
	if (outcome.listing !== undefined) console.log(outcome.listing);
	else console.log(JSON.stringify(outcome));
	process.exitCode = outcome.ok ? 0 : outcome.paused ? 4 : outcome.refused ? 3 : 1;
}
