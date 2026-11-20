// The facts the snapshot computes per entry: the timeline, who we wait on, and the PR, issue and discussion facts.
// Unit checks on scripts/lib/facts.mjs, then `gary item` and `gary snapshot` against the fake gh.
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOT, ME } from "./fixtures/github.mjs";
import { GARY, PROFILE, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("facts");
const T = tempDir();
const profile = join(T, "profile");
cpSync(PROFILE, profile, { recursive: true });
const pfile = join(profile, "profile.json");
const AUTOMATED = [{ name: "logfile feedback", pattern: "<!-- LOGFILE_COMMENT_TAG -->", origin: "a workflow" }, { name: "beep", pattern: "^\\*\\*Beep, boop! 🤖\\*\\*" }];
writeFileSync(pfile, JSON.stringify({ ...JSON.parse(readFileSync(pfile, "utf8")), automatedComments: AUTOMATED }));
const { root, env } = makeHome(T, { profile });
process.env.GARY_HOME = root;
const f = await import("../scripts/lib/facts.mjs");

// Unit checks
const user = (login) => ({ login, __typename: "User" });
const ctx = { us: [ME, BOT], patterns: AUTOMATED };
const at = (h) => new Date(Date.UTC(2026, 10, 17, h)).toISOString();
const ev = (h, login, kind = "comment", body = "text") => ({ at: at(h), author: user(login), body, kind });
const NOW = Date.UTC(2026, 10, 20, 12);

let tl = f.buildTimeline([ev(0, "hubot", "opened"), ev(1, ME)], ctx).timeline;
let s = f.speakerFacts(tl, NOW);
t.check("after our comment we wait on them", s.waitingOn === "them" && s.lastSpeaker === "us" && s.lastUsAt === at(1) && s.lastThemAt === at(0) && s.waitingDays === 3, s);
tl = f.buildTimeline([ev(0, "hubot", "opened"), ev(1, ME), ev(2, "hubot", "reply")], ctx).timeline;
s = f.speakerFacts(tl, NOW);
t.check("a reply after our comment flips waitingOn to us", s.waitingOn === "us" && s.lastSpeaker === "them" && s.lastThemAt === at(2), s);
tl = f.buildTimeline([ev(0, "hubot", "opened"), ev(2, BOT, "comment", "<!-- LOGFILE_COMMENT_TAG -->\nThanks"), ev(1, ME)], ctx).timeline;
s = f.speakerFacts(tl, NOW);
t.check("the timeline is sorted by time", JSON.stringify(tl.map((e) => e.at)) === JSON.stringify([at(0), at(1), at(2)]), tl);
t.check("an automated comment is marked and ignored for lastSpeaker", tl[2].side === "automated" && s.lastSpeaker === "us" && s.waitingOn === "them", { tl, s });
tl = f.buildTimeline([ev(0, ME, "opened"), ev(1, "hubot", "comment", "  **Beep, boop! 🤖** Here is what the docs say")], ctx).timeline;
t.check("a pattern anchored with ^ matches the start of the body only", tl[1].side === "automated" && f.buildTimeline([ev(1, "hubot", "comment", "Quote: **Beep, boop! 🤖**")], ctx).timeline[0].side === "them");
t.check("a bot without a pattern is a bot, not a person", f.buildTimeline([{ ...ev(1, "renovate"), author: { login: "renovate", __typename: "Bot" } }, ev(2, "dependabot[bot]")], ctx).timeline.every((e) => e.side === "bot"));
s = f.speakerFacts(f.buildTimeline([{ ...ev(1, "renovate", "opened"), author: { login: "renovate", __typename: "Bot" } }], ctx).timeline, NOW);
t.check("bots alone leave nobody to wait on", s.waitingOn === "nobody" && s.lastSpeaker === "bot" && s.waitingDays === 0, s);
t.check("an empty timeline waits on nobody", f.speakerFacts([], NOW).waitingOn === "nobody" && f.speakerFacts([], NOW).lastSpeaker === null);
const many = Array.from({ length: 250 }, (_, i) => ({ at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), author: user("hubot"), body: "", kind: "comment" }));
const big = f.buildTimeline(many, ctx);
t.check("the timeline keeps the newest 200 events and says it is truncated", big.timeline.length === 200 && big.timelineTruncated === true && big.timeline.at(-1).at === many.at(-1).at);
t.check("a timeline with every event is not truncated", f.buildTimeline(many.slice(0, 10), ctx).timelineTruncated === false);
t.check("the text an automated pattern sees is capped", !f.isAutomated("x".repeat(30000) + "<!-- LOGFILE_COMMENT_TAG -->", AUTOMATED) && f.isAutomated("<!-- LOGFILE_COMMENT_TAG -->" + "x".repeat(30000), AUTOMATED));

const withUrls = f.buildTimeline([{ ...ev(0, "hubot", "opened"), url: "u0" }, { ...ev(2, BOT, "comment", "<!-- LOGFILE_COMMENT_TAG -->"), url: "u2" }, { ...ev(1, ME), url: "u1" }], ctx);
t.check("lastEventUrl is the newest event's url, automated ones included", withUrls.lastEventUrl === "u2" && withUrls.timeline.every((e) => e.url === undefined), withUrls);
t.check("lastEventUrl is null with only the opening post", f.buildTimeline([{ ...ev(0, "hubot", "opened"), url: "u0" }], ctx).lastEventUrl === null);

const node = (over) => ({ headRefName: "fix-x", allCommits: { nodes: [{ commit: { message: "x", author: { name: "Jane", user: { login: "jane" } }, committer: { name: "Jane", user: { login: "jane" } } } }] }, ...over });
const commitBy = (name, login, message = "x") => ({ allCommits: { nodes: [{ commit: { message, author: { name, user: login ? { login } : null }, committer: { name: "GitHub", user: null } } }] } });
const takenOver = { author: { login: "jane" }, headRefName: "fix-x", allCommits: { nodes: [node().allCommits.nodes[0], commitBy("Widgets Bot", BOT).allCommits.nodes[0]] } };
const own = f.aiFacts(takenOver, { logins: [BOT], names: [], own: BOT });
t.check("our own commit on a contributor's PR does not make it AI-written", own.aiAuthored === false && own.ourCommits === 1 && own.aiSignals.length === 0, own);
t.check("the bot's own PR stays AI or bot authored", f.aiFacts({ ...takenOver, author: { login: BOT } }, { logins: [BOT], names: [], own: BOT }).aiAuthored === true);
t.check("another agent's commit next to ours still counts", f.aiFacts({ ...takenOver, allCommits: { nodes: [...takenOver.allCommits.nodes, commitBy("Copilot", "Copilot").allCommits.nodes[0]] } }, { logins: [BOT], names: [], own: BOT }).aiAuthored === true);
t.check("a human PR has no AI signals", f.aiFacts(node(), { logins: [BOT], names: [] }).aiAuthored === false);
t.check("the configured bot and botLogins count", f.aiFacts(node(commitBy("Widgets Bot", BOT)), { logins: [BOT], names: [] }).aiSignals[0] === `commit author ${BOT}`);
t.check("copilot logins and copilot/ branches count", f.aiFacts(node(commitBy("Copilot", "Copilot")), {}).aiAuthored && f.aiFacts(node({ headRefName: "copilot/fix-1" }), {}).aiSignals.includes("branch copilot/fix-1"));
t.check("aiAuthors adds name patterns", f.aiFacts(node(commitBy("Devin AI", null)), { logins: [], names: ["devin"] }).aiSignals[0] === "commit author Devin AI" && !f.aiFacts(node(commitBy("Devin AI", null)), {}).aiAuthored);
t.check("a Claudette is not Claude", !f.aiFacts(node(commitBy("Claudette", "claudette")), {}).aiAuthored);
t.check("a co-author email can name the agent", f.aiFacts(node(commitBy("Jane", "jane", "x\n\nCo-authored-by: Someone <copilot@users.noreply.github.com>")), {}).aiSignals[0] === "co-author Someone");

const pr = { ci: "passing", mergeable: "MERGEABLE", files: ["package.json", "yarn.lock"], changedFileCount: 2, reviewSummary: [{ author: ME, state: "approved" }] };
let p = f.prFacts(pr);
t.check("a PR that changes only manifests and lock files is dependency-only and clean", p.dependencyOnly && p.isClean && p.ciGreen && JSON.stringify(p.approvedBy) === `["${ME}"]` && p.openThreadCount === 0 && !p.touchesSensitive, p);
t.check("a PR with a source file is not dependency-only", !f.prFacts({ ...pr, files: ["package.json", "src/index.ts"] }).dependencyOnly);
t.check("a PR whose file list is cut short is not dependency-only", !f.prFacts({ ...pr, changedFileCount: 80 }).dependencyOnly);
t.check("nested manifests and requirements files count", f.prFacts({ ...pr, files: ["packages/core/package.json", "docs/requirements-docs.txt", "go.sum"], changedFileCount: 3 }).dependencyOnly);
p = f.prFacts({ ...pr, openThreadCount: 2, reviewSummary: [{ author: "hubot", state: "changes_requested" }], sensitiveFiles: ["package.json"] });
t.check("open threads or requested changes make a PR unclean", !p.isClean && p.openThreadCount === 2 && JSON.stringify(p.changesRequestedBy) === '["hubot"]' && p.touchesSensitive, p);
t.check("a PR names the sensitive files it touches", JSON.stringify(p.sensitiveFiles) === '["package.json"]' && p.sensitiveFileCount === 1 && f.prFacts(pr).sensitiveFiles === undefined && f.prFacts(pr).sensitiveFileCount === undefined, p);
p = f.prFacts({ ...pr, sensitiveFiles: Array.from({ length: 8 }, (_, i) => `.github/workflows/w${i}.yml`) });
t.check("the fact lists at most five sensitive files and counts all", p.sensitiveFiles.length === 5 && p.sensitiveFiles[0] === ".github/workflows/w0.yml" && p.sensitiveFileCount === 8 && p.touchesSensitive, p);
t.check("a discussion's category is a fact", f.issueFacts({ category: "Feature Requests" }, []).category === "Feature Requests" && !("category" in f.issueFacts({}, [])));
t.check("red CI or a conflict make a PR unclean", !f.prFacts({ ...pr, ci: "failing" }).isClean && !f.prFacts({ ...pr, mergeable: "CONFLICTING" }).isClean);
const opened = f.buildTimeline([ev(0, ME, "opened")], ctx).timeline;
t.check("issue facts", JSON.stringify(f.issueFacts({ closingPrs: [{ state: "closed" }, { state: "open" }], isAnswered: true }, opened)) === '{"hasClosingPr":true,"isAnswered":true,"authorIsUs":true}' && f.issueFacts({ closingPrs: [{ state: "closed" }] }, []).hasClosingPr === false);

// Against the fake gh
const gary = (...args) => spawnSync(process.execPath, [GARY, ...args], { env, encoding: "utf8" });
const item = (...args) => {
	const r = gary("item", ...args);
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { error: r.stdout + r.stderr };
	}
};

const dep = item("pr", "17");
t.check("gary item gives a dependency PR its facts", dep.facts?.dependencyOnly === true && dep.facts.isClean === true && dep.facts.ciGreen === true && dep.facts.waitingOn === "nobody" && dep.facts.timeline.length === 1 && dep.facts.timeline[0].side === "bot", dep.facts ?? dep);
t.check("a bot commit marks a PR as AI or bot authored", dep.facts?.aiAuthored === true && dep.facts.aiSignals.includes("commit author renovate[bot]") && dep.facts.changedFiles === 2 && dep.facts.changedLines === 2, dep.facts);
const ai = item("pr", "18");
t.check("a claude/ branch and a co-author trailer are AI signals", ai.facts?.aiAuthored === true && ai.facts.aiSignals.includes("branch claude/restore-timeout") && ai.facts.aiSignals.includes("co-author Claude") && ai.facts.aiSignals.length === 2, ai.facts?.aiSignals);
t.check("changedLines leaves out lock files", ai.facts?.changedLines === 120 && ai.facts.changedFiles === 3, ai.facts);
const pr12 = item("pr", "12");
t.check("a PR without AI signals is not AI authored", pr12.facts?.aiAuthored === false && JSON.stringify(pr12.facts.aiSignals) === "[]", pr12.facts);
const kinds = pr12.facts?.timeline.map((e) => e.kind) ?? [];
t.check("a PR timeline holds reviews and thread comments", kinds.includes("opened") && kinds.includes("comment") && kinds.includes("review") && kinds.includes("thread_comment"), pr12.facts);
t.check("the snapshot entry's facts name its sensitive files", Array.isArray(pr12.facts?.sensitiveFiles) && pr12.facts.sensitiveFiles.length > 0 && pr12.facts.sensitiveFiles.every((x) => pr12.sensitiveFiles.includes(x)) && pr12.facts.sensitiveFileCount === pr12.sensitiveFiles.length, pr12.facts);
t.check("PR facts come from the entry", pr12.facts?.touchesSensitive === true && pr12.facts.openThreadCount === 3 && pr12.facts.dependencyOnly === false && JSON.stringify(pr12.facts.approvedBy) === `["${ME}"]`, pr12.facts);
const issue = item("issue", "23");
t.check("the bot's log feedback does not count as our turn", issue.facts?.lastSpeaker === "them" && issue.facts.waitingOn === "us" && issue.facts.timeline.at(-1).side === "automated" && issue.facts.authorIsUs === false, issue.facts);
t.check("issue facts are there", issue.facts?.hasClosingPr === false && item("issue", "22").facts?.hasClosingPr === true);
t.check("lastEventUrl points at the newest comment, also an automated one", issue.facts?.lastEventUrl === "https://github.com/acme/widgets/issues/23#issuecomment-333", issue.facts?.lastEventUrl);
t.check("lastEventUrl of a PR can be a review", pr12.facts?.lastEventUrl === "https://github.com/acme/widgets/pull/12#pullrequestreview-2", pr12.facts?.lastEventUrl);
t.check("lastEventUrl is absent without comments", dep.facts && !("lastEventUrl" in dep.facts), dep.facts);
const disc = item("discussion", "35");
const replies = disc.facts?.timeline.filter((e) => e.kind === "reply") ?? [];
t.check("more replies than the inline page are fetched", replies.length === 3 && !disc.facts.timelineTruncated && disc.facts.waitingOn === "us", disc.facts ?? disc);
t.check("lastEventUrl of a discussion is the newest fetched reply", disc.facts?.lastEventUrl === "https://github.com/acme/widgets/discussions/35#discussioncomment-507", disc.facts?.lastEventUrl);
t.check("a discussion says whether answers are possible and chosen", disc.facts?.answerable === true && disc.facts.answerChosen === false && issue.facts.answerable === undefined, disc.facts);
t.check("discussion facts are there", disc.facts?.isAnswered === false && disc.facts.hasClosingPr === false);

const snap = gary("snapshot");
let out = {};
try {
	out = JSON.parse(snap.stdout);
} catch {
	out = { error: snap.stdout + snap.stderr };
}
t.check("the full snapshot carries lastEventUrl too", out.changed?.find((e) => e.id === "issue-23")?.facts.lastEventUrl === "https://github.com/acme/widgets/issues/23#issuecomment-333");
t.check("every snapshot entry has facts", out.changed?.length > 0 && out.changed.every((e) => e.facts && Array.isArray(e.facts.timeline) && typeof e.facts.waitingOn === "string"), out);
t.check("the full snapshot fetches the missing replies too", out.changed?.find((e) => e.id === "disc-35")?.facts.timeline.filter((e) => e.kind === "reply").length === 3, out.changed?.find((e) => e.id === "disc-35"));
const pending = JSON.parse(readFileSync(join(root, "instances", "widgets", "state", "snapshot.pending.json"), "utf8"));
t.check("the staged snapshot keeps labels and assignees for every entry", Object.values(pending.items).every((e) => Array.isArray(e.labels) && Array.isArray(e.assignees)) && JSON.stringify(pending.items["pr-17"]?.assignees) === `["${ME}"]`, pending.items["pr-17"]);
const act12 = pending.items["pr-12"]?.activity;
t.check("the staged snapshot keeps the activity of a PR for the timeline", act12?.events.filter((e) => e.kind === "review").map((e) => e.state).join() === "approved,commented" && act12.openThreads.length === 3 && !act12.events.some((e) => e.kind === "thread_reply") && act12.ci.map((c) => c.state).join() === "passing", act12);
t.check("the work list leaves the activity out", out.changed?.every((e) => e.activity === undefined));

removeDir(T);
t.done();
