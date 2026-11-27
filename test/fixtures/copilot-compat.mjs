// An instance that asks Copilot the way it did before Gary knew several review bots: the old `fixReview.reviewer`,
// a profile with `reviewBots: ["copilot"]` and a drive file with `copilotRounds` and `reviewBot`. `runCompat(gary)`
// runs the same steps with the `bin/gary` at `gary` and returns what each step sent to the fake gh, so the suite can
// compare it with what the code before that change sent.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROFILE, makeHome, removeDir, tempDir } from "../lib.mjs";

const SHA = "9".repeat(40);
const NEXT = "a".repeat(40);
const OLD_CONFIG = { fixReview: { reviewer: "copilot", requestAs: "me", maxRounds: 3, markReady: true } };

export function runCompat(gary) {
	const T = tempDir();
	const profileDir = join(T, "profile");
	cpSync(PROFILE, profileDir, { recursive: true });
	const { home, env: baseEnv } = makeHome(T, { ...OLD_CONFIG, profile: profileDir });
	const WRITES = join(T, "gh-writes.jsonl");
	const env = { ...baseEnv, FAKE_GH_WRITES: WRITES, FAKE_GH_OVERRIDES: join(T, "none.json") };
	const state = join(home, "state");
	const driveFile = join(state, "drive", "pr-19.json");
	const actionsDir = join(state, "board", "actions");
	const run = (...args) => spawnSync(process.execPath, [gary, ...args], { env, encoding: "utf8" });
	const act = (request) => spawnSync(process.execPath, [gary, "action"], { env, input: JSON.stringify(request), encoding: "utf8" });
	const json = (r) => {
		try {
			return JSON.parse(r.stdout);
		} catch {
			return { unparsed: r.stdout + r.stderr };
		}
	};
	const writes = () => (existsSync(WRITES) ? readFileSync(WRITES, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
	const steps = [];
	// One entry per step: its exit code and the writes it added
	const step = (name, r, extra = {}) => {
		const all = writes();
		steps.push({ name, status: r.status, writes: all.slice(steps.reduce((n, s) => n + s.writes.length, 0)), ...extra });
		return r;
	};
	const files = { config: readFileSync(join(home, "config.json"), "utf8"), profile: readFileSync(join(profileDir, "profile.json"), "utf8") };

	run("fix-record", "issue-23", "--pr", "19", "--branch", "triage/issue-23", "--run", "run-1", "--by", "routine");
	run("snapshot");
	let r = run("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-1", "--dry-run");
	step("start, dry run", r, { invocations: (json(r).invocations ?? []).map((i) => ({ as: i.as, query: i.stdin?.query, variables: i.stdin?.variables })) });
	step("start", run("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-1"));

	// A drive file written before the change, in the middle of its second round
	const actionId = JSON.parse(readFileSync(driveFile, "utf8")).actionId;
	const now = new Date().toISOString();
	const legacy = JSON.stringify({ actionId, repo: "acme/widgets", number: 19, by: "fix", fixFor: "issue-23", maxRounds: 3, markReady: true, reviewBot: "copilot", rounds: [{ n: 1, fixed: ["Guard the empty list."], dismissed: [], open: [] }], lastPushedSha: SHA, watch: true, stage: "review", copilotRounds: 2, seenAt: { me: now, others: now }, reviewRequestedAt: now });
	writeFileSync(driveFile, legacy);
	step("watch-queue", run("watch-queue", "--once"));
	step("fixes", run("fixes", "--json"), { review: json(run("fixes", "--json"))["issue-23"]?.review?.round });
	step("pr-watch list", run("pr-watch", "list", "--json"), { rounds: json(run("pr-watch", "list", "--json")).prs?.[0]?.reviewRounds });
	const untouched = readFileSync(driveFile, "utf8") === legacy;
	step("third round", run("pr-watch", "review", "--pr", "19", "--sha", NEXT, "--action", actionId), { round: json(run("pr-watch", "list", "--json")).prs?.[0]?.reviewRounds?.used, untouched });
	step("fourth round refused", run("pr-watch", "review", "--pr", "19", "--sha", "b".repeat(40), "--action", actionId));
	step("finish", run("fix-review", "finish", "--pr", "19", "--outcome", "done", "--reason", "Copilot found nothing new.", "--request-maintainer"));
	step("request_review action", act({ kind: "pr", number: 19, action: "request_review", params: { reviewer: "copilot" }, text: "" }));

	// The rounds of a fix PR requested as the bot
	rmSync(join(state, "drive"), { recursive: true, force: true });
	rmSync(actionsDir, { recursive: true, force: true });
	mkdirSync(actionsDir, { recursive: true });
	writeFileSync(join(home, "config.json"), JSON.stringify({ ...JSON.parse(files.config), fixReview: { ...OLD_CONFIG.fixReview, requestAs: "bot" } }));
	step("start as the bot", run("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-2"));
	writeFileSync(join(home, "config.json"), files.config);

	// A revise push on a bot PR that is no fix PR
	rmSync(join(state, "drive"), { recursive: true, force: true });
	writeFileSync(join(state, "fixes.json"), "{}");
	writeFileSync(join(state, "snapshot.json"), JSON.stringify({ items: { "pr-19": { author: "widgets-bot", headSha: SHA, feedback: {} } } }));
	writeFileSync(join(actionsDir, "pr-19-revise.json"), JSON.stringify({ itemId: "pr-19", action: "revise", params: {}, text: "Rename the option.", status: "queued", via: "queue", createdAt: now, finishedAt: null, result: "claimed by run req-1" }));
	step("revise push", run("pr-watch", "review", "--pr", "19", "--sha", NEXT, "--after", "pr-19-revise", "--run", "req-1"));

	const unchanged = readFileSync(join(home, "config.json"), "utf8") === files.config && readFileSync(join(profileDir, "profile.json"), "utf8") === files.profile;
	removeDir(T);
	return { steps, unchanged };
}
