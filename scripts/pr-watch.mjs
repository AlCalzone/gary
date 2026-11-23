// The watch on the PRs we control: every open PR by the bot, Gary's fix PRs among them, and taken-over PRs.
//   gary pr-watch list [--json]
//     Every watched PR with its stage and the feedback no round handled yet, from the staged snapshot.
//   gary pr-watch round --pr <n> --by me|others --at <ISO> [--run <run>] [--dry-run]
//     Queues an agent round for the feedback of the maintainer (me) or of other people up to `at`.
//   gary pr-watch review --pr <n> --sha <head> [--action <id> | --after <id> --run <run>] [--seen-me <ISO>] [--seen-others <ISO>] [--dry-run]
//     Requests the next review bot round after a push, within the cap of 3 per PR. A drive round names its action
//     doc with --action. A revise, take_over or address_review job names its own doc with --after, and gets a new
//     drive action doc claimed by --run. Without a review bot in the profile it requests nothing and answers `skipped`.
//   gary pr-watch done --pr <n> --sha <head> [--seen-me <ISO>] [--seen-others <ISO>] [--request-maintainer]
//     Ends a round without a next review bot round. The PR goes back to waiting for the maintainer's feedback.
//     With --request-maintainer the writing identity then requests the maintainer's review.
// Exit code 3 means a rule refused, 4 that the instance is paused.
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { boardDir, writeAtomic } from "./lib/board-store.mjs";
import { instanceName, loadInstance } from "./lib/config.mjs";
import { PAUSED_MESSAGE, isPaused } from "./lib/control.mjs";
import { sensitiveOurs, touchesSensitive } from "./lib/facts.mjs";
import { driveDir } from "./lib/fixes.mjs";
import { focusHold, focusRefusal } from "./lib/focus.mjs";
import { busyOrigin, readOrigins, shortDir } from "./lib/origins.mjs";
import { writeLogin } from "./lib/gh.mjs";
import { REVIEW_ROUND_CAP, Refused, WATCH_TRIGGERS, baseDrive, enterWatch, feedbackOf, marksFor, pushWork, requestMaintainerReview, requestReviewRound, reviewRoundCap, reviewRoundsUsed, seenMarks, stageOf, unhandledFeedback, watchContext, watchedPrs, writeDrive } from "./lib/watch.mjs";

const USAGE = "Usage: gary pr-watch list [--json] | round --pr <n> --by me|others --at <ISO> [--run <run>] [--dry-run] | review --pr <n> --sha <head> [--action <id> | --after <id> --run <run>] [--seen-me <ISO>] [--seen-others <ISO>] [--dry-run] | done --pr <n> --sha <head> [--seen-me <ISO>] [--seen-others <ISO>] [--request-maintainer]";

function options(argv, names) {
	const out = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (names.includes(argv[i])) out[argv[i].slice(2)] = argv[++i];
		else rest.push(argv[i]);
	}
	return { out, rest };
}

function prNumber(arg) {
	const number = Number(arg);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("--pr must be a PR number");
	return number;
}

function checkSha(sha) {
	if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/.test(sha)) throw new Error("--sha must be the PR's head commit");
}

async function list(argv) {
	const json = argv.includes("--json");
	if (argv.some((a) => a !== "--json")) throw new Error(USAGE);
	const instance = loadInstance(instanceName());
	const busy = await pushWork();
	const rows = (await watchedPrs(instanceName(), instance.repos[0], instance.config.bot?.login ?? null)).map((p) => {
		const sources = { drive: p.drive, feedback: feedbackOf(p), item: p.item, record: p.record };
		return {
			itemId: p.itemId,
			number: p.number,
			why: p.why,
			...(p.fixFor && { fixFor: p.fixFor }),
			stage: stageOf(p.drive),
			pushWork: busy.has(p.itemId),
			reviewRounds: { used: reviewRoundsUsed(p.drive, sources.feedback), cap: p.why === "fix" ? reviewRoundCap(p.drive) : REVIEW_ROUND_CAP },
			me: unhandledFeedback("me", sources),
			others: unhandledFeedback("others", sources),
			inSnapshot: !!p.entry,
		};
	});
	if (json) return { ok: true, prs: rows };
	return { ok: true, text: rows.map((r) => `#${r.number} ${r.why} ${r.stage}${r.pushWork ? " working" : ""}${r.me ? ` me ${r.me}` : ""}${r.others ? ` others ${r.others}` : ""}`).join("\n") || "No watched PRs." };
}

async function round(argv) {
	const { out, rest } = options(argv, ["--pr", "--by", "--at", "--run"]);
	const dryRun = rest.includes("--dry-run");
	if (rest.filter((a) => a !== "--dry-run").length || !out.pr) throw new Error(USAGE);
	if (!Object.hasOwn(WATCH_TRIGGERS, out.by ?? "")) throw new Error("--by must be me or others");
	if (!Number.isFinite(Date.parse(out.at ?? ""))) throw new Error("--at must be the ISO time of the newest feedback the round handles");
	if (out.run !== undefined && (!out.run.trim() || out.run.length > 200)) throw new Error("--run must name the run");
	const c = await watchContext(prNumber(out.pr));
	if (isPaused()) return { ok: false, paused: true, result: PAUSED_MESSAGE };
	if (!writeLogin()) throw new Refused("No account may push: the instance has no bot and allowOwnTokenPushes is off.");
	if ((await pushWork()).has(c.itemId)) throw new Refused(`The agent already works on PR #${c.number}. Its round reads this feedback too.`);
	if (c.entry && touchesSensitive(c.entry) && !sensitiveOurs(c.entry)) throw new Refused(`PR #${c.number} changes sensitive files and is not ours alone, so no agent works in its checkout.`);
	const at = new Date(out.at).toISOString();
	const unhandled = unhandledFeedback(out.by, { drive: c.drive, feedback: { ...feedbackOf(c), [out.by === "me" ? "lastMeAt" : "lastOthersAt"]: at }, item: c.item, record: c.record });
	if (!unhandled) throw new Refused(`A round already handled the feedback on PR #${c.number} up to ${at}.`);
	// Record refused feedback of the maintainer's, so the watcher prints it again once the hold ends
	const hold = async (held) => {
		if (out.by !== "me" || dryRun) return;
		await mkdir(driveDir(), { recursive: true });
		await writeDrive(c.itemId, { ...(c.drive ?? baseDrive(c)), held: { feedbackAt: at, by: "me", ...held, since: new Date().toISOString() } });
	};
	const focus = focusHold(c.itemId);
	if (focus) {
		await hold({ session: focus.session?.id ?? null, focus: true });
		throw new Refused(focusRefusal(c.itemId, focus));
	}
	const live = c.why === "bot" ? await busyOrigin((await readOrigins())[c.itemId]) : null;
	if (live) {
		await hold({ session: live.sessionId });
		throw new Refused(`PR #${c.number} comes from the Claude Code session ${live.sessionId} in ${shortDir(live.cwd)}. That session was active at ${live.lastActiveAt} and may still push to the PR. No round starts until it has been quiet for 30 minutes.`);
	}

	const now = new Date().toISOString();
	const { held: _, ...drive } = c.drive ?? baseDrive(c);
	const params = { by: drive.by ?? (c.why === "fix" ? "fix" : "watch"), ...(c.fixFor && { fixFor: c.fixFor }), trigger: WATCH_TRIGGERS[out.by], at, maxRounds: c.cap };
	const action = { itemId: c.itemId, action: "drive", params, text: "", status: "queued", via: "queue", createdAt: now, finishedAt: null, result: out.run ? `claimed by run ${out.run}` : "" };
	const id = `${c.itemId}-${Date.now()}-${randomBytes(2).toString("hex")}`;
	const next = { ...drive, watch: true, stage: "watch", actionId: id, seenAt: { ...(drive.seenAt ?? {}), [out.by]: at } };
	if (dryRun) return { ok: true, dryRun: true, wouldWrite: { action, drive: next } };
	const dir = join(boardDir(), "actions");
	await mkdir(dir, { recursive: true });
	await writeAtomic(join(dir, id + ".json"), action);
	await mkdir(driveDir(), { recursive: true });
	await writeDrive(c.itemId, next);
	return { ok: true, queued: true, actionId: id, itemId: c.itemId, trigger: params.trigger };
}

async function review(argv) {
	const { out, rest } = options(argv, ["--pr", "--sha", "--action", "--after", "--run", "--seen-me", "--seen-others"]);
	const dryRun = rest.includes("--dry-run");
	if (rest.filter((a) => a !== "--dry-run").length || !out.pr) throw new Error(USAGE);
	checkSha(out.sha);
	const seen = seenMarks(out);
	return requestReviewRound({ number: prNumber(out.pr), sha: out.sha, actionId: out.action, after: out.after, run: out.run, seen, dryRun });
}

async function done(argv) {
	const { out, rest } = options(argv, ["--pr", "--sha", "--seen-me", "--seen-others"]);
	const requestMaintainer = rest.includes("--request-maintainer");
	if (rest.filter((a) => a !== "--request-maintainer").length || !out.pr) throw new Error(USAGE);
	checkSha(out.sha);
	const seen = seenMarks(out);
	const c = await watchContext(prNumber(out.pr));
	// Without the request, done changes only the drive file, so it also runs while paused
	if (requestMaintainer && isPaused()) return { ok: false, paused: true, result: PAUSED_MESSAGE };
	const next = enterWatch(c.drive ?? baseDrive(c), { sha: out.sha, seen: marksFor(seen) });
	await mkdir(driveDir(), { recursive: true });
	await writeDrive(c.itemId, next);
	const result = { ok: true, stage: "watch", itemId: c.itemId, seenAt: next.seenAt };
	if (requestMaintainer) result.maintainerReview = await requestMaintainerReview({ repo: c.repo, number: c.number });
	return result;
}

export async function main(argv) {
	const [command, ...rest] = argv;
	let outcome;
	try {
		if (command === "list") outcome = await list(rest);
		else if (command === "round") outcome = await round(rest);
		else if (command === "review") outcome = await review(rest);
		else if (command === "done") outcome = await done(rest);
		else throw new Error(USAGE);
	} catch (e) {
		outcome = { ok: false, ...(e instanceof Refused && { refused: true }), result: e.message };
	}
	if (typeof outcome.text === "string") console.log(outcome.text);
	else console.log(JSON.stringify(outcome));
	process.exitCode = outcome.ok ? 0 : outcome.paused ? 4 : outcome.refused ? 3 : 1;
}
