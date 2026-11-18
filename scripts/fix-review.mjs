// The review rounds a fix PR of Gary gets without a click. They run as a drive with `by: "fix"`.
//   gary fix-review start --pr <number> --sha <head sha> --run <run> [--dry-run]
//     Requests the first review and writes the waiting drive. The fix worker calls it right after `gary fix-record`.
//   gary fix-review finish --pr <number> --outcome done|stopped --reason <text> [--dry-run]
//     Ends the rounds: marks the PR ready after `done`, and queues the full review of the PR item.
// Both refuse a PR that is not in <state>/fixes.json, and do nothing while the instance is paused.
import { randomBytes } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { runAction } from "./lib/actions.mjs";
import { boardDir, readJson, writeAtomic } from "./lib/board-store.mjs";
import { fixReviewOf, instanceName, loadInstance } from "./lib/config.mjs";
import { PAUSED_MESSAGE, isPaused } from "./lib/control.mjs";
import { driveDir, fixRecordOf, prItemId, readFixRecords, recordFixReady } from "./lib/fixes.mjs";

const USAGE = "Usage: gary fix-review start --pr <number> --sha <head sha> --run <run> [--dry-run] | finish --pr <number> --outcome done|stopped --reason <text> [--dry-run]";
const OUTCOMES = ["done", "stopped"];
const MAX_REASON = 500;

function options(argv, names) {
	const out = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (names.includes(argv[i])) out[argv[i].slice(2)] = argv[++i];
		else rest.push(argv[i]);
	}
	return { out, rest };
}

async function writeAction(itemId, doc) {
	const dir = join(boardDir(), "actions");
	await mkdir(dir, { recursive: true });
	const id = `${itemId}-${Date.now()}-${randomBytes(2).toString("hex")}`;
	await writeAtomic(join(dir, id + ".json"), { itemId, ...doc });
	return id;
}

/** Everything both commands check first: the PR is Gary's recorded fix PR, and the instance is not paused. */
async function context(prArg) {
	const number = Number(prArg);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("--pr must be a PR number");
	const instance = loadInstance(instanceName());
	const hit = fixRecordOf(await readFixRecords(), number);
	if (!hit) throw new Error(`PR #${number} is not a fix PR Gary recorded in fixes.json. The review rounds and the ready mark are only for those.`);
	return { number, instance, repo: instance.repos[0], itemId: prItemId(number), fixFor: hit.itemId, startedBy: hit.record.startedBy, settings: fixReviewOf(instance.config, instance.profile) };
}

async function start(argv) {
	const { out, rest } = options(argv, ["--pr", "--sha", "--run"]);
	const dryRun = rest.includes("--dry-run");
	if (rest.filter((a) => a !== "--dry-run").length || !out.pr || !out.run) throw new Error(USAGE);
	if (typeof out.sha !== "string" || !/^[0-9a-f]{7,64}$/.test(out.sha)) throw new Error("--sha must be the head commit of the fix PR");
	const c = await context(out.pr);
	if (c.settings.reviewer === "off") return { ok: true, started: false, reason: c.settings.reason ?? "fixReview is off" };
	if (isPaused()) return { ok: false, started: false, paused: true, result: PAUSED_MESSAGE };
	const stateFile = join(driveDir(), c.itemId + ".json");
	if (await readJson(stateFile)) return { ok: true, started: false, reason: `The review rounds of PR #${c.number} already run` };

	const request = await runAction({ action: "request_review", kind: "pr", number: c.number, repo: c.repo, params: { reviewer: c.settings.reviewer, as: c.settings.requestAs }, dryRun });
	if (!request.ok) return { ok: false, started: false, result: `The review was not requested: ${request.result}` };
	const now = new Date().toISOString();
	const params = { maxRounds: c.settings.maxRounds, by: "fix", fixFor: c.fixFor };
	const drive = { repo: c.repo, number: c.number, ...params, markReady: c.settings.markReady, reviewBot: c.settings.reviewer, rounds: [], lastPushedSha: out.sha, reviewRequestedAt: now, startedAt: now };
	// The doc carries a claim from the start, so the queue watcher prints the drive only when its review arrived
	const action = { action: "drive", params, text: "", status: "queued", via: "queue", createdAt: now, finishedAt: null, result: `claimed by run ${out.run}` };
	if (dryRun) return { ok: true, started: false, dryRun: true, invocations: request.result.invocations, wouldWrite: { action: { itemId: c.itemId, ...action }, drive } };
	const actionId = await writeAction(c.itemId, action);
	await mkdir(driveDir(), { recursive: true });
	await writeAtomic(stateFile, { actionId, ...drive });
	return { ok: true, started: true, actionId, itemId: c.itemId, statePath: stateFile, maxRounds: c.settings.maxRounds };
}

async function finish(argv) {
	const { out, rest } = options(argv, ["--pr", "--outcome", "--reason"]);
	const dryRun = rest.includes("--dry-run");
	if (rest.filter((a) => a !== "--dry-run").length || !out.pr) throw new Error(USAGE);
	if (!OUTCOMES.includes(out.outcome)) throw new Error(`--outcome must be one of ${OUTCOMES.join(", ")}`);
	if (typeof out.reason !== "string" || !out.reason.trim() || out.reason.length > MAX_REASON) throw new Error(`--reason must say in at most ${MAX_REASON} characters why the rounds ended`);
	const c = await context(out.pr);
	if (isPaused()) return { ok: false, paused: true, result: PAUSED_MESSAGE };
	const stateFile = join(driveDir(), c.itemId + ".json");
	const drive = await readJson(stateFile);
	if (!drive || drive.by !== "fix") throw new Error(`PR #${c.number} has no review rounds to end`);

	// A stopped drive leaves the PR a draft, so he sees that it is unfinished
	const wantsReady = out.outcome === "done" && drive.markReady !== false;
	let ready = false;
	let readyNote = null;
	const invocations = [];
	if (wantsReady) {
		const r = await runAction({ action: "ready", kind: "pr", number: c.number, repo: c.repo, params: {}, dryRun });
		if (r.ok) {
			ready = true;
			if (dryRun) invocations.push(...r.result.invocations);
		} else if (r.paused) return { ok: false, paused: true, result: PAUSED_MESSAGE };
		else readyNote = `Marking the PR ready failed: ${r.result}`;
	}
	const now = new Date().toISOString();
	const rounds = Array.isArray(drive.rounds) ? drive.rounds : [];
	const review = {
		action: "full_review",
		params: { repo: c.repo, number: c.number, by: "fix", fixFor: c.fixFor, outcome: out.outcome, ready, rounds, lastPushedSha: drive.lastPushedSha ?? null },
		text: [out.reason.trim(), readyNote].filter(Boolean).join(" "),
		status: "queued",
		via: "queue",
		createdAt: now,
		finishedAt: null,
		result: "",
	};
	if (dryRun) return { ok: true, dryRun: true, ready, invocations, wouldWrite: { action: { itemId: c.itemId, ...review } } };

	if (ready) await recordFixReady(c.number, now);
	const reviewId = await writeAction(c.itemId, review);
	if (typeof drive.actionId === "string") {
		const file = join(boardDir(), "actions", drive.actionId + ".json");
		const doc = await readJson(file);
		if (doc) await writeAtomic(file, { ...doc, status: "done", finishedAt: now, result: review.text });
	}
	await unlink(stateFile).catch((e) => {
		if (e.code !== "ENOENT") throw e;
	});
	return { ok: true, ready, ...(readyNote && { warning: readyNote }), reviewId, itemId: c.itemId, rounds: rounds.length };
}

export async function main(argv) {
	const [command, ...rest] = argv;
	let outcome;
	try {
		if (command === "start") outcome = await start(rest);
		else if (command === "finish") outcome = await finish(rest);
		else throw new Error(USAGE);
	} catch (e) {
		outcome = { ok: false, result: e.message };
	}
	console.log(JSON.stringify(outcome));
	process.exitCode = outcome.ok ? 0 : outcome.paused ? 4 : 1;
}
