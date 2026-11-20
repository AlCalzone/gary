// The watch on the PRs we control after the review bot's rounds: the maintainer's feedback starts a round without a
// click, other people's feedback waits for the hourly run, the review bot cap of 3 per PR, the restart for feedback
// no round handled, the wider set of the bot's PRs, and the safety rules. Runs offline against the fake gh.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("pr-watch");
const T = tempDir();
const { home, env: baseEnv, root } = makeHome(T);
const WRITES = join(T, "gh-writes.jsonl");
const OVERRIDES = join(T, "overrides.json");
writeFileSync(OVERRIDES, "{}");
const env = { ...baseEnv, FAKE_GH_WRITES: WRITES, FAKE_GH_OVERRIDES: OVERRIDES };
const state = join(home, "state");
const actionsDir = join(state, "board", "actions");
const itemsDir = join(state, "board", "items");
const driveDir = join(state, "drive");
const driveFile = join(driveDir, "pr-19.json");
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
const lines = (r) => r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const feedbackLines = (r) => lines(r).filter((l) => l.event === "maintainer-feedback");
const SHA = "9".repeat(40);
const at = (day, hour) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();
const setOverrides = (o) => writeFileSync(OVERRIDES, JSON.stringify(o));
const setSnapshot = (items) => writeFileSync(join(state, "snapshot.json"), JSON.stringify({ items }));
const setFixes = (o) => writeFileSync(join(state, "fixes.json"), JSON.stringify(o));
const reset = () => {
	rmSync(driveDir, { recursive: true, force: true });
	rmSync(actionsDir, { recursive: true, force: true });
	mkdirSync(actionsDir, { recursive: true });
	rmSync(WRITES, { force: true });
	rmSync(join(state, "snapshot.pending.json"), { force: true });
	for (const n of readdirSync(itemsDir)) rmSync(join(itemsDir, n));
};

const user = (login) => ({ login, __typename: "User" });
const bot = (login) => ({ login, __typename: "Bot" });
const review = (author, submittedAt, state = "COMMENTED") => ({ author, state, submittedAt, url: `https://github.com/acme/widgets/pull/19#pullrequestreview-${Date.parse(submittedAt)}` });
const comment = (author, createdAt) => ({ author, createdAt, body: "A note.", url: `https://github.com/acme/widgets/pull/19#issuecomment-${Date.parse(createdAt)}` });
const ourCommit = (committedDate) => ({ commit: { committedDate, author: { user: { login: "widgets-bot" } }, committer: { user: { login: "widgets-bot" } } } });
// PR 19 as GitHub shows it: our last commit, Copilot's first review and whatever the test adds
const pr19 = ({ reviews = [], comments = [], ...rest } = {}) => ({
	"pr-19": {
		recentCommits: { nodes: [ourCommit(at(18, 9))] },
		allReviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [review(bot("copilot-pull-request-reviewer"), at(18, 10)), ...reviews] },
		timelineComments: { totalCount: comments.length, nodes: comments },
		...rest,
	},
});
const record = { number: 19, url: "https://github.com/acme/widgets/pull/19", branch: "gary/fix-issue-23", run: "run-1", startedBy: "routine", at: at(18, 8), readyAt: at(18, 11) };

// The facts the watch compares
const facts = await (async () => {
	process.env.GARY_HOME = root;
	return import("../scripts/lib/facts.mjs");
})();
const timeline = [
	{ at: at(18, 8), author: "widgets-bot", side: "us", kind: "opened" },
	{ at: at(18, 10), author: "copilot-pull-request-reviewer", side: "bot", kind: "review" },
	{ at: at(19, 9), author: "octocat", side: "us", kind: "review" },
	{ at: at(19, 10), author: "hubot", side: "them", kind: "comment" },
	{ at: at(19, 11), author: "widgets-bot", side: "us", kind: "thread_comment" },
];
const ff = facts.feedbackFacts(timeline, [ourCommit(at(18, 9))], { me: "octocat", bot: "widgets-bot", writeLogin: "widgets-bot", reviewBots: ["copilot"] });
t.check("feedback facts name his last review, the last outside comment, our last commit and the review bot rounds", ff.lastMeAt === at(19, 9) && ff.lastOthersAt === at(19, 10) && ff.ourLastCommitAt === at(18, 9) && ff.reviewBotReviews === 1, ff);

// Restart: a fix PR whose drive finished before the watch existed, with his review after our last push
setFixes({ "issue-23": [record] });
setSnapshot({ "pr-19": { author: "widgets-bot", headSha: SHA, feedback: { ourLastCommitAt: at(18, 9), reviewBotReviews: 1, lastMeAt: at(19, 9) } } });
setOverrides(pr19({ reviews: [review(user("octocat"), at(19, 9), "CHANGES_REQUESTED")] }));
let r = gary("watch-queue", "--once");
const expected = { instance: "widgets", id: "watch-pr-19", itemId: "pr-19", action: "drive", event: "maintainer-feedback", pr: 19, at: at(19, 9) };
t.check("restart: his unhandled review on a fix PR with a finished drive prints one event", r.status === 0 && JSON.stringify(feedbackLines(r)) === JSON.stringify([expected]) && !existsSync(driveFile), r.stdout + r.stderr);
let o = json(gary("pr-watch", "list", "--json"));
t.check("list names the fix PR with his unhandled feedback", o.prs?.length === 1 && o.prs[0].why === "fix" && o.prs[0].stage === "watch" && o.prs[0].me === at(19, 9) && o.prs[0].others === null && o.prs[0].pushWork === false, o);

// A running watcher prints each review once, the first time right at its start
const watcher = spawn(process.execPath, [GARY, "watch-queue", "--all"], { env: { ...env, GARY_WATCH_POLL_MS: "200" }, stdio: ["ignore", "pipe", "pipe"] });
let seen = "";
watcher.stdout.on("data", (d) => (seen += d));
for (let i = 0; i < 30 && !/maintainer-feedback/.test(seen); i++) await new Promise((res) => setTimeout(res, 100));
await new Promise((res) => setTimeout(res, 800));
const first = seen.split("\n").filter((l) => /maintainer-feedback/.test(l)).length;
setOverrides(pr19({ reviews: [review(user("octocat"), at(19, 9), "CHANGES_REQUESTED"), review(user("octocat"), at(19, 12))] }));
for (let i = 0; i < 30 && seen.split("\n").filter((l) => /maintainer-feedback/.test(l)).length < 2; i++) await new Promise((res) => setTimeout(res, 100));
await new Promise((res) => setTimeout(res, 600));
watcher.kill("SIGTERM");
const all = seen.split("\n").filter((l) => /maintainer-feedback/.test(l)).map((l) => JSON.parse(l).at);
t.check("a running watcher prints the event once per review", first === 1 && JSON.stringify(all) === JSON.stringify([at(19, 9), at(19, 12)]), seen);
setOverrides(pr19({ reviews: [review(user("octocat"), at(19, 9), "CHANGES_REQUESTED")] }));

// The master queues the round
r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", at(19, 9), "--dry-run");
t.check("round as a dry run writes nothing", r.status === 0 && json(r).dryRun === true && actions().length === 0 && !existsSync(driveFile), r.stdout);
r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", at(19, 9));
o = json(r);
let doc = actions().find((a) => a.id === o.actionId);
t.check("round queues an open drive request for his feedback", r.status === 0 && doc?.action === "drive" && doc.status === "queued" && doc.result === "" && doc.params.trigger === "maintainer" && doc.params.by === "fix" && doc.params.fixFor === "issue-23" && doc.params.at === at(19, 9), [o, doc]);
let drive = read(driveFile);
t.check("round writes the watch with his feedback seen", drive.stage === "watch" && drive.watch === true && drive.by === "fix" && drive.actionId === o.actionId && drive.seenAt.me === at(19, 9) && drive.maxRounds === 3, drive);
r = gary("watch-queue", "--once");
t.check("the queued round prints as a request and his review prints no second event", JSON.stringify(lines(r)) === JSON.stringify([{ instance: "widgets", id: o.actionId, itemId: "pr-19", action: "drive" }]), r.stdout);
r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", at(19, 9));
t.check("a second round while one is queued is refused", r.status === 3 && /already works/.test(json(r).result) && actions().length === 1, r.stdout);
o = json(gary("fixes", "--json"))["issue-23"];
t.check("the fix chip names no review bot round while his round runs", o.review === undefined, o);

// The round ends through fix-review finish. The PR was marked ready once, so it is not marked again
r = gary("fix-review", "finish", "--pr", "19", "--outcome", "done", "--reason", "Addressed both threads of the maintainer.", "--seen-me", at(19, 10));
o = json(r);
const fullReview = actions().find((a) => a.id === o.reviewId);
t.check("finish after his round queues the full review and marks nothing ready", r.status === 0 && !writes().some((w) => w.mutation === "markPullRequestReadyForReview") && fullReview?.params.trigger === "maintainer" && fullReview.params.ready === true && actions().find((a) => a.id === drive.actionId).status === "done", [o, writes(), fullReview]);
drive = read(driveFile);
t.check("finish leaves the PR watched with the seen mark of the round", drive.stage === "watch" && drive.actionId === undefined && drive.seenAt.me === at(19, 10), drive);
rmSync(join(actionsDir, o.reviewId + ".json"));
r = gary("watch-queue", "--once");
t.check("a review the round handled prints nothing", r.stdout.trim() === "", r.stdout);
r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", at(19, 9));
t.check("a round for handled feedback is refused", r.status === 3 && /already handled/.test(json(r).result), r.stdout);
setOverrides(pr19({ reviews: [review(user("octocat"), at(19, 9), "CHANGES_REQUESTED"), review(user("octocat"), at(19, 12))] }));
r = gary("watch-queue", "--once");
t.check("his next review prints a new event", JSON.stringify(feedbackLines(r).map((l) => l.at)) === JSON.stringify([at(19, 12)]), r.stdout);

// During the review bot rounds his feedback goes into the next round and ends nothing
reset();
const now = new Date().toISOString();
const soon = new Date(Date.now() + 60000).toISOString();
writeFileSync(join(actionsDir, "pr-19-1.json"), JSON.stringify({ itemId: "pr-19", action: "drive", params: { by: "fix", fixFor: "issue-23", maxRounds: 3 }, status: "queued", via: "queue", createdAt: now, result: "claimed by run run-1" }));
mkdirSync(driveDir, { recursive: true });
writeFileSync(driveFile, JSON.stringify({ actionId: "pr-19-1", repo: "acme/widgets", number: 19, by: "fix", fixFor: "issue-23", maxRounds: 3, reviewBot: "copilot", rounds: [], lastPushedSha: SHA, watch: true, stage: "review", copilotRounds: 2, seenAt: { me: now, others: now }, reviewRequestedAt: now }));
setOverrides(pr19({ reviews: [review(user("octocat"), soon, "CHANGES_REQUESTED")] }));
r = gary("watch-queue", "--once");
t.check("his review during the rounds prints no event and keeps the drive waiting", r.stdout.trim() === "" && read(driveFile).stage === "review" && actions()[0].status === "queued", r.stdout);
t.check("the chip shows the round over the PR's life", JSON.stringify(json(gary("fixes", "--json"))["issue-23"].review) === '{"reviewer":"copilot","round":2,"maxRounds":3}');
setOverrides(pr19({ reviews: [review(user("octocat"), soon, "CHANGES_REQUESTED"), review(bot("copilot-pull-request-reviewer"), soon)] }));
r = gary("watch-queue", "--once");
t.check("the review bot's review still prints the next round", JSON.stringify(lines(r)) === JSON.stringify([{ instance: "widgets", id: "pr-19-1", itemId: "pr-19", action: "drive", event: "review-arrived" }]), r.stdout);

// The review bot cap of 3 counts over the PR's life
r = gary("pr-watch", "review", "--pr", "19", "--sha", "a".repeat(40));
t.check("the third review bot round is requested", r.status === 0 && json(r).round === 3 && writes().at(-1)?.mutation === "requestCopilotCodeReview" && read(driveFile).copilotRounds === 3 && read(driveFile).stage === "review" && read(driveFile).lastPushedSha === "a".repeat(40), [r.stdout, writes()]);
r = gary("pr-watch", "done", "--pr", "19", "--sha", "a".repeat(40), "--seen-me", soon);
t.check("done puts the PR back to watching", r.status === 0 && read(driveFile).stage === "watch" && read(driveFile).reviewRequestedAt === undefined && read(driveFile).copilotRounds === 3, read(driveFile));
const before = writes().length;
r = gary("pr-watch", "review", "--pr", "19", "--sha", "a".repeat(40), "--action", "pr-19-1");
t.check("a fourth review bot round is refused", r.status === 3 && /3 of 3/.test(json(r).result) && writes().length === before, r.stdout);
writeFileSync(driveFile, JSON.stringify({ ...read(driveFile), copilotRounds: 1 }));
setSnapshot({ "pr-19": { author: "widgets-bot", headSha: SHA, feedback: { reviewBotReviews: 3 } } });
r = gary("pr-watch", "review", "--pr", "19", "--sha", "a".repeat(40), "--action", "pr-19-1");
t.check("the review bot's reviews on GitHub count toward the cap", r.status === 3 && /3 of 3/.test(json(r).result) && writes().length === before, r.stdout);

// Other people's feedback waits for the hourly run
reset();
setSnapshot({ "pr-19": { author: "widgets-bot", headSha: SHA, feedback: { ourLastCommitAt: at(18, 9), lastOthersAt: at(19, 10) } } });
setOverrides(pr19({ comments: [comment(user("hubot"), at(19, 10))], reviews: [review(user("hubot"), at(19, 10), "CHANGES_REQUESTED")] }));
r = gary("watch-queue", "--once");
t.check("another person's comment and review print no event", r.stdout.trim() === "", r.stdout);
o = json(gary("pr-watch", "list", "--json"));
t.check("list names the outside feedback for the hourly run", o.prs?.[0]?.others === at(19, 10) && o.prs[0].me === null, o);
r = gary("pr-watch", "round", "--pr", "19", "--by", "others", "--at", at(19, 10), "--run", "hourly-1");
o = json(r);
doc = actions().find((a) => a.id === o.actionId);
t.check("the hourly run queues a claimed round for the outside feedback", r.status === 0 && doc?.params.trigger === "others" && doc.result === "claimed by run hourly-1" && read(driveFile).seenAt.others === at(19, 10) && read(driveFile).seenAt.me === undefined, [o, doc]);

// The wider set: every open PR by the bot, also outside fixes.json, and taken-over PRs
reset();
setFixes({});
setSnapshot({ "pr-19": { author: "widgets-bot", headSha: SHA, feedback: {} }, "pr-25": { author: "hubot", headSha: "5".repeat(40), feedback: {} } });
setOverrides({ ...pr19({ reviews: [review(user("octocat"), at(19, 9))] }), "pr-25": { allReviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [review(user("octocat"), at(19, 9))] } } });
r = gary("watch-queue", "--once");
t.check("a bot PR outside fixes.json is watched, a contributor PR is not", JSON.stringify(feedbackLines(r).map((l) => l.pr)) === "[19]", r.stdout + r.stderr);
o = json(gary("pr-watch", "list", "--json"));
t.check("list names the bot PR", o.prs?.length === 1 && o.prs[0].why === "bot", o);
r = gary("pr-watch", "round", "--pr", "25", "--by", "me", "--at", at(19, 9));
t.check("a round on a contributor PR that is not taken over is refused", r.status === 1 && /Only those are watched/.test(json(r).result) && actions().length === 0, r.stdout);
r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", at(19, 9));
t.check("a round on the bot PR is queued with by watch", r.status === 0 && actions()[0]?.params.by === "watch" && actions()[0].params.fixFor === undefined && read(driveFile).by === "watch", actions());
reset();
writeFileSync(join(itemsDir, "pr-25.json"), JSON.stringify({ kind: "pr", repo: "acme/widgets", number: 25, author: "hubot", authorType: "contributor", takenOver: true, pushed: { action: "take_over", sha: "5".repeat(40), at: at(18, 9) } }));
r = gary("watch-queue", "--once");
t.check("a taken-over PR is watched", JSON.stringify(feedbackLines(r).map((l) => l.pr).sort()) === "[19,25]", r.stdout + r.stderr);
o = json(gary("pr-watch", "list", "--json"));
t.check("list names the taken-over PR", o.prs?.find((p) => p.number === 25)?.why === "taken_over", o);

// Sensitive files: a bot PR with someone else's commit is not ours alone
reset();
setSnapshot({ "pr-19": { author: "widgets-bot", headSha: SHA, sensitiveFiles: [".github/workflows/ci.yml"], feedback: {} } });
const foreign = { totalCount: 2, nodes: [{ commit: { message: "Fix", author: { name: "Bot", email: "b@x", user: { login: "widgets-bot" } }, committer: { name: "Bot", email: "b@x", user: { login: "widgets-bot" } } } }, { commit: { message: "Tweak", author: { name: "Hu", email: "h@x", user: { login: "hubot" } }, committer: { name: "Hu", email: "h@x", user: { login: "hubot" } } } }] };
setOverrides(pr19({ reviews: [review(user("octocat"), at(19, 9))], isCrossRepository: false, files: { totalCount: 1, nodes: [{ path: ".github/workflows/ci.yml", additions: 1, deletions: 0 }] }, allCommits: foreign }));
r = gary("watch-queue", "--once");
t.check("a sensitive bot PR that is not ours alone prints no event", feedbackLines(r).length === 0, r.stdout + r.stderr);
r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", at(19, 9));
t.check("a round on it is refused", r.status === 3 && /sensitive files/.test(json(r).result) && actions().length === 0, r.stdout);

// A merged PR ends its watch
reset();
setFixes({ "issue-23": [record] });
setSnapshot({ "pr-19": { author: "widgets-bot", headSha: SHA, feedback: {} } });
mkdirSync(driveDir, { recursive: true });
writeFileSync(driveFile, JSON.stringify({ repo: "acme/widgets", number: 19, by: "fix", watch: true, stage: "watch", rounds: [], seenAt: {} }));
setOverrides(pr19({ reviews: [review(user("octocat"), at(19, 9))], state: "MERGED" }));
r = gary("watch-queue", "--once");
t.check("a merged PR prints nothing and its watch is removed", r.stdout.trim() === "" && !existsSync(driveFile), r.stdout);

// Paused and without an account that may push
setOverrides(pr19({ reviews: [review(user("octocat"), at(19, 9))] }));
gary("pause");
r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", at(19, 9));
t.check("paused: round queues nothing", r.status === 4 && json(r).paused === true && actions().length === 0, r.stdout);
t.check("paused: the watcher prints nothing", gary("watch-queue", "--once").stdout.trim() === "");
gary("resume");
const config = read(join(home, "config.json"));
writeFileSync(join(home, "config.json"), JSON.stringify({ ...config, bot: null }));
r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", at(19, 9));
t.check("without an account that may push, round is refused", r.status === 3 && /No account may push/.test(json(r).result), r.stdout);
t.check("without an account that may push, the watcher prints nothing", gary("watch-queue", "--once").stdout.trim() === "");
writeFileSync(join(home, "config.json"), JSON.stringify(config));

removeDir(T);
t.done();
