import { join } from "node:path";
// The "Since your last choice" timeline: the activity the snapshot stores, the anchor and the groups after it.
import { BOT, ME } from "./fixtures/github.mjs";
import { makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("since");
const T = tempDir();
process.env.GARY_HOME = makeHome(T).root;
const { activityOf, sinceAnchor, sinceSummary } = await import("../scripts/lib/since.mjs");
const { replaceFields } = await import("../scripts/lib/board-store.mjs");

const user = (login) => ({ login, __typename: "User" });
const bot = (login) => ({ login, __typename: "Bot" });
const at = (d, h, m = 0) => new Date(Date.UTC(2026, 10, d, h, m)).toISOString();
const ctx = { us: [ME, BOT], me: ME, patterns: [{ name: "beep", pattern: "^Beep" }] };

// The activity the snapshot stores
const node = {
	timelineComments: { nodes: [
		{ author: user("hubot"), createdAt: at(18, 1), body: `@${ME} can you look?` },
		{ author: user("hubot"), createdAt: at(18, 2), body: "Done. Anything else?\n\nThanks" },
		{ author: user(BOT), createdAt: at(18, 3), body: "Beep, the log is broken" },
		{ author: user("hubot"), createdAt: at(18, 4), body: "Is this it?", replies: { nodes: [{ author: user(ME), createdAt: at(18, 5), body: "Yes" }] } },
	] },
	allReviews: { nodes: [
		{ author: user(ME), state: "CHANGES_REQUESTED", submittedAt: at(18, 6) },
		{ author: user(ME), state: "PENDING", submittedAt: at(18, 7) },
	] },
	reviewThreads: { nodes: [
		{ isResolved: false, comments: { nodes: [{ author: bot("copilot-pull-request-reviewer"), createdAt: at(18, 8) }] },
			allComments: { nodes: [{ author: bot("copilot-pull-request-reviewer"), createdAt: at(18, 8), body: "Fix" }, { author: user(BOT), createdAt: at(18, 9), body: "Fixed in abc" }] } },
		{ isResolved: true, comments: { nodes: [{ author: user(ME), createdAt: at(18, 8) }] }, allComments: { nodes: [{ author: user(ME), createdAt: at(18, 8), body: "x" }] } },
	] },
	recentCommits: { nodes: [
		{ commit: { oid: "a".repeat(40), committedDate: at(18, 10), author: { user: { login: "hubot" } } } },
		{ commit: { oid: "b".repeat(40), committedDate: at(18, 11), author: { name: "Someone", user: null } } },
	] },
	statusEvents: { nodes: [
		{ __typename: "ReadyForReviewEvent", createdAt: at(18, 12), actor: user("hubot") },
		{ __typename: "LabeledEvent", createdAt: at(18, 13), actor: user(ME), label: { name: "bug" } },
		{ __typename: "SomethingElse", createdAt: at(18, 14), actor: user(ME) },
	] },
};
let act = activityOf("pr", node, ctx, { before: { ci: [{ at: at(17, 0), state: "passing" }] }, ci: "failing", at: at(18, 15) });
const kinds = act.events.map((e) => e.kind).join();
t.check("the activity lists comments, replies, reviews, thread replies, commits and status events in order", kinds === "comment,comment,comment,comment,reply,review,thread_reply,commit,commit,ready,labeled", act.events);
t.check("a comment by someone outside that mentions him or ends in a question asks him", act.events.filter((e) => e.asks).map((e) => e.at).join() === [at(18, 1), at(18, 4)].join(), act.events);
t.check("an automated comment keeps its side", act.events[2].side === "automated");
t.check("a review keeps its state, a pending one is left out", act.events.filter((e) => e.kind === "review").map((e) => e.state).join() === "changes_requested");
t.check("the first comment of a thread is left out, its replies stay", act.events.filter((e) => e.kind === "thread_reply").map((e) => e.by).join() === BOT);
t.check("commits carry their SHA, a commit without an account its name", act.events.find((e) => e.kind === "commit").sha === "a".repeat(40) && act.events.filter((e) => e.kind === "commit")[1].by === "Someone");
t.check("a label event carries the label", act.events.find((e) => e.kind === "labeled").label === "bug");
t.check("open threads list who started them", JSON.stringify(act.openThreads) === JSON.stringify([{ by: "copilot-pull-request-reviewer", at: at(18, 8) }]), act.openThreads);
t.check("a new CI result is appended to the previous ones", act.ci.map((c) => c.state).join() === "passing,failing" && act.ci[1].at === at(18, 15), act.ci);
act = activityOf("pr", node, ctx, { before: { ci: [{ at: at(17, 0), state: "failing" }] }, ci: "failing", at: at(18, 15) });
t.check("the same CI result adds nothing", act.ci.length === 1);
act = activityOf("pr", node, ctx, { before: { ci: [{ at: at(17, 0), state: "passing" }] }, ci: "pending", at: at(18, 15) });
t.check("a pending CI adds nothing", act.ci.length === 1);
act = activityOf("issue", { comments: { nodes: Array.from({ length: 80 }, (_, i) => ({ author: user("hubot"), createdAt: at(1, 0, i), body: "x" })) } }, ctx, {});
t.check("an issue keeps the newest 60 events", act.events.length === 60 && act.events.at(-1).at === at(1, 0, 79) && act.openThreads.length === 0 && act.ci.length === 0);

// The anchor
const click = { itemId: "pr-1", routeId: "r1", route: "take_over", action: "take_over", status: "done", createdAt: at(19, 10) };
const watch = { itemId: "pr-1", action: "drive", params: { by: "watch" }, status: "queued", createdAt: at(19, 12) };
let a = sinceAnchor({ seenAt: at(19, 20) }, [click, watch]);
t.check("his newest click is the anchor, before a later dialog open", a?.kind === "choice" && a.at === at(19, 10) && a.label === "Take over", a);
a = sinceAnchor({ handled: { at: at(19, 11), routeId: "r2", routeType: "reply" } }, [click, watch]);
t.check("a prefill he used later is the anchor", a?.kind === "choice" && a.at === at(19, 11) && a.label === "Reply", a);
a = sinceAnchor({}, [click, { itemId: "pr-1", routeId: "r3", route: "close", action: "dismiss_route", createdAt: at(19, 13) }, { itemId: "pr-1", action: "reanalyze", via: "queue", createdAt: at(19, 13) }]);
t.check("a dismissal is named, before the analysis it queued", a?.label === "Dismissed Close", a);
a = sinceAnchor({}, [{ itemId: "pr-1", action: "snooze", params: { days: 3 }, via: "board", createdAt: at(19, 14) }]);
t.check("a snooze is a choice", a?.label === "Snooze", a);
a = sinceAnchor({}, [{ itemId: "pr-1", action: "reanalyze", params: {}, text: "Look at the tests", via: "queue", createdAt: at(19, 14) }]);
t.check("Analyze again is a choice", a?.label === "Analyze again", a);
a = sinceAnchor({ seenAt: at(19, 20) }, [watch]);
t.check("without a choice the last dialog open is the anchor", a?.kind === "opened" && a.at === at(19, 20) && a.label === undefined, a);
t.check("without a choice or an open there is no anchor", sinceAnchor({}, [watch]) === null && sinceSummary({ events: [] }, null) === null);
t.check("without activity there is no timeline", sinceSummary(undefined, a) === null);
t.check("a replace by the routine keeps the open time", replaceFields({ seenAt: at(19, 20), title: "old" }, { title: "new" }).seenAt === at(19, 20));

// The groups after the anchor
const anchor = { at: at(19, 10), kind: "choice", label: "Take over" };
const GARY_SHA = "c".repeat(40);
const ev = (h, by, side, kind, extra = {}) => ({ at: at(19, h, extra.m ?? 0), by, side, kind, ...extra });
const commits = Array.from({ length: 8 }, (_, i) => ev(11, "jpoeppelman1", "them", "commit", { m: i, sha: String(i).repeat(40) }));
const activity = {
	events: [
		ev(9, "hubot", "them", "comment"),
		...commits,
		ev(12, "copilot-pull-request-reviewer", "bot", "review", { state: "commented" }),
		ev(12, "copilot-pull-request-reviewer", "bot", "thread_reply", { m: 1 }),
		ev(13, "copilot-pull-request-reviewer", "bot", "review", { state: "commented" }),
		ev(14, "copilot-pull-request-reviewer", "bot", "review", { state: "commented" }),
		ev(15, BOT, "us", "commit", { sha: GARY_SHA }),
		ev(15, BOT, "us", "thread_reply", { m: 5 }),
		ev(15, BOT, "us", "thread_reply", { m: 6 }),
		ev(15, BOT, "us", "comment", { m: 7 }),
		ev(15, BOT, "automated", "comment", { m: 8 }),
		ev(16, ME, "us", "review", { state: "changes_requested" }),
		ev(17, "hubot", "them", "comment", { asks: true }),
		ev(17, "hubot", "them", "labeled", { m: 1, label: "wontfix" }),
		ev(18, ME, "us", "labeled", { label: "bug" }),
		ev(18, ME, "us", "labeled", { m: 1, label: "triage" }),
		ev(19, "hubot", "them", "ready"),
	],
	openThreads: [{ by: "copilot-pull-request-reviewer", at: at(18, 0) }, { by: "copilot-pull-request-reviewer", at: at(19, 12) }, { by: "copilot-pull-request-reviewer", at: at(19, 13) }],
	ci: [{ at: at(18, 0), state: "passing" }, { at: at(19, 20), state: "failing" }],
};
const actions = [
	click,
	{ itemId: "pr-1", action: "revise", status: "done", createdAt: at(19, 14), finishedAt: at(19, 15, 30), result: `https://github.com/acme/widgets/commit/${GARY_SHA}`, resultParts: { commits: [`https://github.com/acme/widgets/commit/${GARY_SHA}`], threads: [] } },
];
let s = sinceSummary(activity, anchor, { me: ME, bot: BOT, actions });
const lines = s.groups.map((g) => g.text + (g.note ? " · " + g.note : ""));
const want = [
	"jpoeppelman1 pushed 8 commits",
	"Copilot reviewed 3 times · 2 threads still open",
	`${BOT} pushed 1 commit (Change)`,
	`${BOT} wrote 2 replies in review threads`,
	"You requested changes · not addressed yet",
	"hubot wrote 1 comment · asked you something, no answer yet",
	"You added labels bug, triage",
	"hubot marked it ready for review",
	"CI failed",
];
t.check("the groups by actor and kind, oldest first, with the callouts", JSON.stringify(lines) === JSON.stringify(want), lines);
t.check("the groups carry icons the page has", s.groups.map((g) => g.icon ?? "").join() === "commit,eye,commit,comments,changes,comments,,pr,ciFail", s.groups.map((g) => g.icon));
t.check("the summary names the anchor", s.anchor === anchor);

const later = { ...activity, events: [...activity.events, ev(21, "jpoeppelman1", "them", "commit", { sha: "d".repeat(40) }), ev(22, "octocat", "us", "comment")], ci: [...activity.ci, { at: at(19, 23), state: "passing" }] };
s = sinceSummary(later, anchor, { me: ME, bot: BOT, actions });
const byText = (re) => s.groups.find((g) => re.test(g.text));
t.check("a push after his change request answers it", byText(/^You requested changes$/)?.note === undefined, byText(/^You requested changes/));
t.check("our comment after a question answers it", byText(/^hubot wrote/)?.note === undefined && byText(/^You wrote 1 comment$/), s.groups);
t.check("the commits of one author stay one group", byText(/^jpoeppelman1 pushed 9 commits$/), s.groups);
t.check("CI back to green says so", s.groups.at(-1).text === "CI passing again" && s.groups.at(-1).icon === "ciPass", s.groups.at(-1));
const round = { itemId: "pr-1", action: "drive", params: { by: "watch" }, status: "done", createdAt: at(19, 16, 30), finishedAt: at(19, 17, 30), result: "" };
s = sinceSummary(activity, anchor, { me: ME, bot: BOT, actions: [...actions, round] });
t.check("a finished round after his change request answers it", s.groups.find((g) => g.text === "You requested changes")?.note === undefined, s.groups);
s = sinceSummary({ events: [ev(11, "alice", "them", "review", { state: "approved" }), ev(12, "alice", "them", "review", { state: "commented" }), ev(13, "bob", "them", "review", { state: "approved" }), ev(14, "carol", "them", "force_push"), ev(15, "carol", "them", "force_push")], openThreads: [], ci: [] }, anchor, { me: ME, bot: BOT });
t.check("review states and force-pushes", JSON.stringify(s.groups.map((g) => g.text)) === JSON.stringify(["alice reviewed 2 times, approved", "bob approved", "carol force-pushed 2 times"]), s.groups.map((g) => g.text));
s = sinceSummary({ events: [ev(9, "hubot", "them", "comment")], openThreads: [], ci: [{ at: at(18, 0), state: "failing" }] }, anchor, { me: ME, bot: BOT });
t.check("nothing after the anchor gives no groups", s.groups.length === 0 && s.anchor === anchor, s);
s = sinceSummary({ events: [], openThreads: [], ci: [{ at: at(19, 11), state: "failing" }] }, anchor, {});
t.check("the first CI result the snapshot saw is no change", s.groups.length === 0, s);

// `gary snapshot --out`: the work list goes into the run directory, never over the baseline
const { outPath } = await import("../scripts/snapshot.mjs");
const { stateDir } = await import("../scripts/lib/config.mjs");
const refused = (argv) => { try { outPath(argv); return false; } catch { return true; } };
t.check("--out resolves the path of the work list", outPath(["--out", join(T, "run", "snapshot.json")]) === join(T, "run", "snapshot.json"));
t.check("no --out means stdout", outPath([]) === null);
t.check("--out refuses the baseline", refused(["--out", join(stateDir(), "snapshot.json")]));
t.check("--out refuses the staged snapshot", refused(["--out", join(stateDir(), "snapshot.pending.json")]));
t.check("--out needs a path", refused(["--out"]));

removeDir(T);
t.done();
