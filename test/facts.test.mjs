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

const pr = { ci: "passing", mergeable: "MERGEABLE", files: ["package.json", "yarn.lock"], changedFileCount: 2, reviewSummary: [{ author: ME, state: "approved" }] };
let p = f.prFacts(pr);
t.check("a PR that changes only manifests and lock files is dependency-only and clean", p.dependencyOnly && p.isClean && p.ciGreen && JSON.stringify(p.approvedBy) === `["${ME}"]` && p.openThreadCount === 0 && !p.touchesSensitive, p);
t.check("a PR with a source file is not dependency-only", !f.prFacts({ ...pr, files: ["package.json", "src/index.ts"] }).dependencyOnly);
t.check("a PR whose file list is cut short is not dependency-only", !f.prFacts({ ...pr, changedFileCount: 80 }).dependencyOnly);
t.check("nested manifests and requirements files count", f.prFacts({ ...pr, files: ["packages/core/package.json", "docs/requirements-docs.txt", "go.sum"], changedFileCount: 3 }).dependencyOnly);
p = f.prFacts({ ...pr, openThreadCount: 2, reviewSummary: [{ author: "hubot", state: "changes_requested" }], sensitiveFiles: ["package.json"] });
t.check("open threads or requested changes make a PR unclean", !p.isClean && p.openThreadCount === 2 && JSON.stringify(p.changesRequestedBy) === '["hubot"]' && p.touchesSensitive, p);
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
const pr12 = item("pr", "12");
const kinds = pr12.facts?.timeline.map((e) => e.kind) ?? [];
t.check("a PR timeline holds reviews and thread comments", kinds.includes("opened") && kinds.includes("comment") && kinds.includes("review") && kinds.includes("thread_comment"), pr12.facts);
t.check("PR facts come from the entry", pr12.facts?.touchesSensitive === true && pr12.facts.openThreadCount === 3 && pr12.facts.dependencyOnly === false && JSON.stringify(pr12.facts.approvedBy) === `["${ME}"]`, pr12.facts);
const issue = item("issue", "23");
t.check("the bot's log feedback does not count as our turn", issue.facts?.lastSpeaker === "them" && issue.facts.waitingOn === "us" && issue.facts.timeline.at(-1).side === "automated" && issue.facts.authorIsUs === false, issue.facts);
t.check("issue facts are there", issue.facts?.hasClosingPr === false && item("issue", "22").facts?.hasClosingPr === true);
const disc = item("discussion", "35");
const replies = disc.facts?.timeline.filter((e) => e.kind === "reply") ?? [];
t.check("more replies than the inline page are fetched", replies.length === 3 && !disc.facts.timelineTruncated && disc.facts.waitingOn === "us", disc.facts ?? disc);
t.check("discussion facts are there", disc.facts?.isAnswered === false && disc.facts.hasClosingPr === false);

const snap = gary("snapshot");
let out = {};
try {
	out = JSON.parse(snap.stdout);
} catch {
	out = { error: snap.stdout + snap.stderr };
}
t.check("every snapshot entry has facts", out.changed?.length > 0 && out.changed.every((e) => e.facts && Array.isArray(e.facts.timeline) && typeof e.facts.waitingOn === "string"), out);
t.check("the full snapshot fetches the missing replies too", out.changed?.find((e) => e.id === "disc-35")?.facts.timeline.filter((e) => e.kind === "reply").length === 3, out.changed?.find((e) => e.id === "disc-35"));
const pending = JSON.parse(readFileSync(join(root, "instances", "widgets", "state", "snapshot.pending.json"), "utf8"));
t.check("the staged snapshot keeps labels and assignees for every entry", Object.values(pending.items).every((e) => Array.isArray(e.labels) && Array.isArray(e.assignees)) && JSON.stringify(pending.items["pr-17"]?.assignees) === `["${ME}"]`, pending.items["pr-17"]);

removeDir(T);
t.done();
