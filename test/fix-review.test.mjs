// The review rounds of Gary's own fix PRs: the hand-off from the fix to the drive, the two end states, the watcher's
// drive events, the pause, and the limit on pending automatic fixes. Runs offline against the fake gh.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("fix-review");
const T = tempDir();
const { home, env: baseEnv, root } = makeHome(T);
const WRITES = join(T, "gh-writes.jsonl");
const OVERRIDES = join(T, "overrides.json");
writeFileSync(OVERRIDES, "{}");
const env = { ...baseEnv, FAKE_GH_WRITES: WRITES, FAKE_GH_OVERRIDES: OVERRIDES };
const state = join(home, "state");
const actionsDir = join(state, "board", "actions");
const driveFile = join(state, "drive", "pr-19.json");
const gary = (...args) => spawnSync(process.execPath, [GARY, ...args], { env, encoding: "utf8" });
const json = (r) => {
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { unparsed: r.stdout + r.stderr };
	}
};
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const writes = () => (existsSync(WRITES) ? readFileSync(WRITES, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const actions = () => readdirSync(actionsDir).filter((n) => n.endsWith(".json")).map((n) => ({ id: n.slice(0, -5), ...read(join(actionsDir, n)) }));
const editConfig = (fn) => writeFileSync(join(home, "config.json"), JSON.stringify(fn(read(join(home, "config.json")))));
const SHA = "9".repeat(40);
const reset = () => {
	rmSync(join(state, "drive"), { recursive: true, force: true });
	rmSync(actionsDir, { recursive: true, force: true });
	mkdirSync(actionsDir, { recursive: true });
	rmSync(WRITES, { force: true });
};

// Only a fix PR Gary recorded gets the rounds
let r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-1");
t.check("start refuses a PR that is not in fixes.json", r.status === 1 && /not a fix PR Gary recorded/.test(json(r).result) && writes().length === 0, r.stdout);
r = gary("fix-review", "finish", "--pr", "13", "--outcome", "done", "--reason", "Nothing open.");
t.check("finish marks no PR ready that is not in fixes.json", r.status === 1 && /not a fix PR Gary recorded/.test(json(r).result) && writes().length === 0, r.stdout);
gary("fix-record", "issue-23", "--pr", "19", "--branch", "triage/issue-23", "--run", "run-1", "--by", "routine");
gary("snapshot");

// The hand-off from the fix to the drive
r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-1", "--dry-run");
let o = json(r);
t.check("a dry run names the request and writes nothing", r.status === 0 && o.dryRun === true && o.started === false && o.invocations?.[0]?.as === "octocat" && /requestCopilotCodeReview/.test(o.invocations[0].stdin.query) && o.wouldWrite.drive.by === "fix" && !existsSync(driveFile) && actions().length === 0 && writes().length === 0, o);
r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-1");
o = json(r);
t.check("start requests the Copilot review under the maintainer's login", r.status === 0 && o.started === true && writes().length === 1 && writes()[0].mutation === "requestCopilotCodeReview" && writes()[0].as === "octocat" && writes()[0].variables.id === "PR_19", [o, writes()]);
let drive = read(driveFile);
t.check("start writes the waiting drive with by fix", drive.by === "fix" && drive.fixFor === "issue-23" && drive.repo === "acme/widgets" && drive.number === 19 && drive.maxRounds === 3 && drive.markReady === true && drive.reviewBot === "copilot" && drive.lastPushedSha === SHA && drive.rounds.length === 0 && Date.parse(drive.reviewRequestedAt) > Date.now() - 10000 && drive.actionId === o.actionId, drive);
let doc = actions().find((a) => a.id === o.actionId);
t.check("the drive's action doc is a claimed push request for the PR item", doc?.itemId === "pr-19" && doc.action === "drive" && doc.status === "queued" && doc.via === "queue" && doc.result === "claimed by run run-1" && doc.params.by === "fix" && doc.params.maxRounds === 3, doc);
r = gary("watch-queue", "--once");
t.check("the queue watcher does not print the waiting drive as a new request", r.status === 0 && r.stdout.trim() === "", r.stdout + r.stderr);
r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-2");
t.check("a second start changes nothing", json(r).started === false && /already run/.test(json(r).reason) && writes().length === 1 && actions().length === 1, r.stdout);

// The stage on the issue's fix state
let fx = json(gary("fixes", "--json"))["issue-23"];
t.check("the fix state names the review round", fx.state === "draft" && JSON.stringify(fx.review) === '{"reviewer":"copilot","round":1,"maxRounds":3}', fx);
writeFileSync(driveFile, JSON.stringify({ ...drive, rounds: [{ n: 1, fixed: ["Guard the empty list."], dismissed: [], open: [] }] }));
t.check("a finished round moves the stage", json(gary("fixes", "--json"))["issue-23"].review.round === 2);

// The watcher notices the review within its poll
r = gary("watch-queue", "--once");
t.check("no drive event while the review is missing", r.stdout.trim() === "", r.stdout + r.stderr);
const later = new Date(Date.now() + 60000).toISOString();
const reviewBy = (login, typename) => ({ "pr-19": { allReviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ author: { login, __typename: typename }, state: "COMMENTED", submittedAt: later, url: "https://github.com/acme/widgets/pull/19#pullrequestreview-9" }] } } });
writeFileSync(OVERRIDES, JSON.stringify(reviewBy("hubot", "User")));
t.check("another reviewer is no drive event", gary("watch-queue", "--once").stdout.trim() === "");
writeFileSync(OVERRIDES, JSON.stringify(reviewBy("copilot-pull-request-reviewer", "Bot")));
r = gary("watch-queue", "--once");
t.check("the review bot's review prints one drive event", r.stdout.trim() === JSON.stringify({ instance: "widgets", id: drive.actionId, itemId: "pr-19", action: "drive", event: "review-arrived" }), r.stdout + r.stderr);
writeFileSync(OVERRIDES, "{}");
writeFileSync(driveFile, JSON.stringify({ ...drive, reviewRequestedAt: new Date(Date.now() - 31 * 60000).toISOString() }));
r = gary("watch-queue", "--once");
t.check("a review that did not arrive within 30 minutes prints a timeout event", JSON.parse(r.stdout.trim() || "{}").event === "review-timeout", r.stdout + r.stderr);

// A running watcher prints the event without a restart
writeFileSync(driveFile, JSON.stringify(drive));
const watcher = spawn(process.execPath, [GARY, "watch-queue", "--all"], { env: { ...env, GARY_DRIVE_POLL_MS: "200" }, stdio: ["ignore", "pipe", "pipe"] });
let seen = "";
watcher.stdout.on("data", (d) => (seen += d));
await new Promise((res) => setTimeout(res, 700));
const before = seen;
writeFileSync(OVERRIDES, JSON.stringify(reviewBy("Copilot", "Bot")));
for (let i = 0; i < 40 && !/review-arrived/.test(seen); i++) await new Promise((res) => setTimeout(res, 100));
watcher.kill("SIGTERM");
t.check("the running watcher prints the event once the review is there", before === "" && seen.trim().split("\n").filter((l) => /review-arrived/.test(l)).length === 1, [before, seen]);
writeFileSync(OVERRIDES, "{}");

// Paused: nothing is requested, marked or queued
gary("pause");
r = gary("fix-review", "finish", "--pr", "19", "--outcome", "done", "--reason", "Copilot has nothing open.");
t.check("paused: finish sends nothing and keeps the drive", r.status === 4 && json(r).paused === true && writes().length === 1 && existsSync(driveFile) && actions().length === 1, r.stdout);
t.check("paused: the watcher prints no drive event", gary("watch-queue", "--once").stdout.trim() === "");
rmSync(driveFile);
r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-3");
t.check("paused: start requests no review and writes no drive", r.status === 4 && json(r).paused === true && writes().length === 1 && !existsSync(driveFile) && actions().length === 1, r.stdout);
gary("resume");

// End state: Copilot has nothing open, or the rounds are used up
const rounds = [{ n: 1, fixed: ["Guard the empty list."], dismissed: [{ summary: "Use optional chaining.", reason: "The value is always set." }], open: ["A test for the timeout branch."] }];
writeFileSync(driveFile, JSON.stringify({ ...drive, rounds, lastPushedSha: "a".repeat(40) }));
r = gary("fix-review", "finish", "--pr", "19", "--outcome", "done", "--reason", "Copilot found nothing new after round 1.", "--dry-run");
o = json(r);
t.check("finish as a dry run names the ready mark and the review it would queue", o.dryRun === true && /markPullRequestReadyForReview/.test(o.invocations?.[0]?.stdin.query ?? "") && o.wouldWrite.action.action === "full_review" && existsSync(driveFile) && writes().length === 1, o);
r = gary("fix-review", "finish", "--pr", "19", "--outcome", "done", "--reason", "Copilot found nothing new after round 1.");
o = json(r);
t.check("done: the PR is marked ready as the bot", r.status === 0 && o.ready === true && writes().length === 2 && writes()[1].mutation === "markPullRequestReadyForReview" && writes()[1].as === "widgets-bot" && writes()[1].variables.id === "PR_19", [o, writes()]);
let review = actions().find((a) => a.id === o.reviewId);
t.check("done: a full review of the PR item is queued with the rounds", review?.itemId === "pr-19" && review.action === "full_review" && review.status === "queued" && review.result === "" && review.via === "queue" && review.params.outcome === "done" && review.params.ready === true && review.params.number === 19 && review.params.repo === "acme/widgets" && review.params.fixFor === "issue-23" && review.params.rounds[0].open[0] === "A test for the timeout branch." && review.params.lastPushedSha === "a".repeat(40) && /nothing new after round 1/.test(review.text), review);
r = gary("watch-queue", "--once");
t.check("done: the queue watcher prints the full review for the master", r.stdout.trim() === JSON.stringify({ instance: "widgets", id: o.reviewId, itemId: "pr-19", action: "full_review" }), r.stdout);
t.check("done: the drive is over", !existsSync(driveFile) && actions().find((a) => a.id === drive.actionId).status === "done");
fx = json(gary("fixes", "--json"))["issue-23"];
t.check("done: the fix state is open and has no review stage", fx.state === "open" && fx.pr.isDraft === false && fx.review === undefined && typeof read(join(state, "fixes.json"))["issue-23"][0].readyAt === "string", fx);

// End state: stuck or failed
reset();
writeFileSync(join(state, "fixes.json"), JSON.stringify({ "issue-23": [{ number: 19, url: "https://github.com/acme/widgets/pull/19", branch: "triage/issue-23", run: "run-1", startedBy: "routine", at: new Date().toISOString() }] }));
gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-1");
r = gary("fix-review", "finish", "--pr", "19", "--outcome", "stopped", "--reason", "The review did not arrive within 30 minutes.");
o = json(r);
review = actions().find((a) => a.id === o.reviewId);
t.check("stopped: the PR stays a draft and the full review is queued anyway", r.status === 0 && o.ready === false && !writes().some((w) => w.mutation === "markPullRequestReadyForReview") && review?.action === "full_review" && review.params.outcome === "stopped" && review.params.ready === false && /did not arrive/.test(review.text) && !existsSync(driveFile), [o, review]);
t.check("stopped: the fix state stays a draft", json(gary("fixes", "--json"))["issue-23"].state === "draft");
r = gary("fix-review", "finish", "--pr", "19", "--outcome", "done", "--reason", "Again.");
t.check("finish without running rounds is refused", r.status === 1 && /no review rounds to end/.test(json(r).result), r.stdout);
r = gary("fix-review", "finish", "--pr", "19", "--outcome", "merged", "--reason", "x");
t.check("finish checks the outcome", r.status === 1 && /--outcome must be one of done, stopped/.test(json(r).result));

// Settings: markReady false, the bot as requester, and off
reset();
editConfig((c) => ({ ...c, fixReview: { requestAs: "bot", maxRounds: 2, markReady: false } }));
r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-1");
t.check("requestAs bot requests the review with the bot's token", json(r).started === true && writes()[0].as === "widgets-bot" && read(driveFile).maxRounds === 2 && read(driveFile).markReady === false, [r.stdout, writes()]);
r = gary("fix-review", "finish", "--pr", "19", "--outcome", "done", "--reason", "Two rounds are done.");
t.check("markReady false leaves the PR a draft after a done drive", json(r).ready === false && writes().length === 1 && actions().some((a) => a.action === "full_review" && a.params.ready === false), r.stdout);
reset();
editConfig((c) => ({ ...c, fixReview: { reviewer: "off" } }));
r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-1");
t.check("reviewer off starts nothing", r.status === 0 && json(r).started === false && /off/.test(json(r).reason) && writes().length === 0 && !existsSync(driveFile) && actions().length === 0, r.stdout);
editConfig(({ fixReview, ...c }) => c);
r = gary("doctor", "--json");
t.check("doctor names the fix review and the fix limit", /up to 3 copilot review rounds, requested as you, then it is marked ready/.test(r.stdout) && /at most 10 automatic fix PRs pending/.test(r.stdout), r.stdout.slice(0, 1500));

// The limit on pending automatic fixes
reset();
rmSync(join(state, "snapshot.pending.json"), { force: true });
const record = (number, by) => ({ number, url: `https://github.com/acme/widgets/pull/${number}`, branch: "b" + number, run: "r", startedBy: by, at: "2026-11-18T09:00:00Z" });
const setFixes = (o2) => writeFileSync(join(state, "fixes.json"), JSON.stringify(o2));
editConfig((c) => ({ ...c, maxPendingAutoFixes: 2 }));
setFixes({ "issue-101": [record(201, "routine")], "issue-102": [record(202, "maintainer")] });
r = gary("claim", "issue-103", "fix", "--run", "hourly");
t.check("below the limit the routine's fix claim is granted, his own fixes do not count", r.status === 0 && json(r).ok === true, r.stdout);
r = gary("claim", "issue-104", "fix", "--run", "hourly");
t.check("at the limit the claim is refused with the numbers", r.status === 3 && /limit of pending automatic fixes is reached: 2 of 2/.test(json(r).error) && json(r).limit.pending === 2 && json(r).limit.max === 2 && !existsSync(join(state, "claims", "issue-104.fix.json")), r.stdout);
writeFileSync(join(actionsDir, "issue-104-1.json"), JSON.stringify({ itemId: "issue-104", action: "start_fix", status: "queued", via: "queue", createdAt: new Date().toISOString() }));
r = gary("claim", "issue-104", "fix", "--run", "request-1", "--request", "issue-104-1");
t.check("a fix he clicked is claimed at the limit", r.status === 0 && json(r).ok === true, r.stdout);
gary("release", "issue-104", "fix", "--run", "request-1");
rmSync(join(actionsDir, "issue-104-1.json"));
gary("release", "issue-103", "fix", "--run", "hourly");
setFixes({ "issue-101": [record(201, "routine")], "issue-102": [record(202, "maintainer")], "issue-105": [record(205, "routine")] });
r = gary("claim", "issue-104", "fix", "--run", "hourly");
t.check("two draft fix PRs of the routine fill the limit", r.status === 3, r.stdout);
const snap = join(state, "snapshot.json");
rmSync(join(state, "snapshot.pending.json"), { force: true });
const closing = (number, st) => ({ closingPrs: [{ number, url: `https://github.com/acme/widgets/pull/${number}`, state: st, isDraft: false }] });
writeFileSync(snap, JSON.stringify({ items: { "issue-101": closing(201, "merged") } }));
r = gary("claim", "issue-104", "fix", "--run", "hourly");
t.check("a merged fix PR frees a slot", r.status === 0, r.stdout);
gary("release", "issue-104", "fix", "--run", "hourly");
writeFileSync(snap, JSON.stringify({ items: { "issue-101": closing(201, "open"), "issue-105": closing(205, "closed") } }));
r = gary("claim", "issue-104", "fix", "--run", "hourly");
t.check("a closed fix PR frees a slot", r.status === 0, r.stdout);
gary("release", "issue-104", "fix", "--run", "hourly");
editConfig((c) => ({ ...c, maxPendingAutoFixes: 0 }));
setFixes({});
r = gary("claim", "issue-104", "fix", "--run", "hourly");
t.check("0 turns automatic fixes off", r.status === 3 && /Automatic fixes are off/.test(json(r).error), r.stdout);
r = gary("claim", "issue-104", "review", "--run", "hourly");
t.check("the limit is only for fix claims", r.status === 0, r.stdout);
editConfig(({ maxPendingAutoFixes, ...c }) => c);
const fs = await (async () => {
	process.env.GARY_HOME = root;
	return import("../scripts/lib/fixes.mjs");
})();
const none = { claims: [], actions: [], records: {}, snapshot: {}, repo: "acme/widgets", drives: {} };
t.check("pending counts the routine's running jobs and its draft and open PRs", fs.pendingAutoFixes({ ...none, claims: [{ itemId: "issue-1", kind: "fix", at: "2026-11-18T10:00:00Z", expired: false }], records: { "issue-2": [record(30, "routine")], "issue-3": [record(31, "maintainer")] } }) === 2);
t.check("a queued fix he clicked does not count while it runs", fs.pendingAutoFixes({ ...none, claims: [{ itemId: "issue-1", kind: "fix", at: "2026-11-18T10:00:00Z", expired: false }], actions: [{ id: "a", data: { itemId: "issue-1", action: "start_fix", status: "queued" } }] }) === 0);

removeDir(T);
t.done();
