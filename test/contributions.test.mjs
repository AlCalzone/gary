// A contributions instance: its settings, its snapshot through the fake gh, its items, and a server that writes
// nothing to GitHub for it. The root also holds a maintainer instance for acme/widgets, which the contributions never cover.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { ME } from "./fixtures/github.mjs";
import { contributionId, mergeReminderDaysOf, newsOf, repoCovered, scopeQualifiers } from "../scripts/lib/contributions.mjs";
import { validateItem } from "../scripts/lib/validate-item.mjs";
import { PROFILE_DEFAULTS, tabIconFile, validateConfig } from "../scripts/lib/config.mjs";

const { check, done } = runner("contributions");
const T = tempDir();
const PORT = await freePort();
const { root, env } = makeHome(T, { port: PORT });
const HOME = join(root, "instances", "mine");
const STATE = join(HOME, "state");
const BOARD = join(STATE, "board");
for (const c of ["items", "actions"]) mkdirSync(join(BOARD, c), { recursive: true });
const writeConfig = (extra = {}) => writeFileSync(join(HOME, "config.json"), JSON.stringify({ kind: "contributions", me: ME, exclude: ["skipped/*"], ...extra }, null, "\t"));
writeConfig();
const ghData = join(T, "contributions.json");
const ghLog = join(T, "gh.log");
const cli = (args, extra = {}) => spawnSync(process.execPath, [GARY, "--instance", "mine", ...args], { env: { ...env, FAKE_GH_CONTRIBUTIONS: ghData, FAKE_GH_LOG: ghLog, ...extra }, encoding: "utf8" });

// ---------- settings ----------

check("a contributions config needs only kind and me", validateConfig({ kind: "contributions", me: "octocat" }).length === 0);
const problems = validateConfig({ kind: "contributions", me: "octocat", profile: "~/p", checkout: "~/c", bot: null, fixReview: {}, include: ["acme"], exclude: ["*/*"], maxItems: 5, title: "", typo: 1 });
check("maintainer fields are errors in a contributions config", ["profile", "checkout", "bot", "fixReview"].every((k) => problems.some((p) => p.startsWith(`"${k}" is only for maintainer instances`))), problems);
check("include and exclude take owner/name or owner/*", problems.some((p) => p.startsWith('"include" must')) && problems.some((p) => p.startsWith('"exclude" must')));
check("maxItems has a range, title a length", problems.some((p) => p.startsWith('"maxItems" must be a whole number from 10 to 500')) && problems.some((p) => p.startsWith('"title" must')));
check("an unknown field is named", problems.includes('unknown field "typo"'));
check("a tab takes an icon, a color and a background, in both kinds", validateConfig({ kind: "contributions", me: "octocat", tab: { icon: "user", color: "rose", background: true, favorite: true } }).length === 0 && validateConfig({ profile: "p", me: "me", tab: { icon: "zap", color: "blue" } }).length === 0 && validateConfig({ profile: "p", me: "me", tab: { color: "#0071BC" } }).length === 0);
const tabProblems = validateConfig({ kind: "contributions", me: "octocat", tab: { icon: "rocket", color: "red", background: "yes", size: 2 } });
check("a tab refuses unknown icons, colors and fields", tabProblems.some((p) => p.startsWith('"tab.icon" must')) && tabProblems.some((p) => p.startsWith('"tab.color" must')) && tabProblems.some((p) => p.startsWith('"tab.background" must')) && tabProblems.includes('unknown field "tab.size"'), tabProblems);
check("a tab icon may be an image file", validateConfig({ kind: "contributions", me: "octocat", tab: { icon: "~/pics/logo.svg" } }).length === 0 && validateConfig({ kind: "contributions", me: "octocat", tab: { icon: "logo.txt" } }).some((p) => p.startsWith('"tab.icon" must')));
check("a relative icon path starts at the instance directory", tabIconFile({ tab: { icon: "logo.png" } }, "/x/inst")?.file === "/x/inst/logo.png" && tabIconFile({ tab: { icon: "logo.png" } }, "/x/inst").type === "image/png" && tabIconFile({ tab: { icon: "zap" } }, "/x/inst") === null);
check("a background needs a color", validateConfig({ kind: "contributions", me: "octocat", tab: { background: true } }).some((p) => p.startsWith('"tab.background" needs')));
check("a maintainer config still needs a profile", validateConfig({ kind: "maintainer", me: "octocat" }).some((p) => p.startsWith('"profile" must')));
check("a maintainer config treats the contributions fields as unknown", validateConfig({ kind: "maintainer", me: "octocat", profile: "x", maxItems: 20 }).join() === 'unknown field "maxItems"');

const paths = JSON.parse(cli(["paths"]).stdout);
check("paths: no profile and no checkout", paths.profile === null && paths.checkout === null && paths.state === STATE, paths);
const doctor = JSON.parse(cli(["doctor", "--json"]).stdout);
const named = (n) => doctor.find((c) => c.name === n);
check("doctor checks the kind, the token scopes, what it leaves out and the caps", named("kind")?.status === "ok" && !!named("token scopes") && /acme\/widgets/.test(named("left out")?.detail) && /skipped\/\*/.test(named("left out")?.detail) && /at most 150 threads/.test(named("caps")?.detail), doctor);
check("doctor runs no profile, bot or checkout check", !named("profile") && !named("bot") && !named("checkout") && !named("fix review"));

// ---------- ids and the repo filter ----------

check("an id names repo, kind and number", contributionId("Other/Lib", "pr", 5) === "other.lib.pr-5" && contributionId("other/lib", "discussion", 5) === "other.lib.disc-5");
check("a dotted repo name keeps the owner apart, because an owner holds no dot", contributionId("a/b.c", "pr", 1) === "a.b.c.pr-1" && contributionId("a/b", "pr", 1) !== contributionId("a/b.pr-1", "pr", 1));
const long = contributionId("owner/" + "x".repeat(100), "issue", 12345);
check("a long repo name is cut to the id pattern with a hash", /^[a-z0-9][a-z0-9._-]{0,99}$/.test(long) && long.length <= 100 && long.endsWith(".issue-12345") && long !== contributionId("owner/" + "x".repeat(99) + "y", "issue", 12345), long);
const blocked = new Set(["acme/widgets"]);
check("a maintainer repo is never covered", repoCovered("Acme/Widgets", { blocked }).reason === "maintainer");
check("exclude wins, include narrows", repoCovered("skipped/x", { exclude: ["skipped/*"] }).reason === "exclude" && repoCovered("other/lib", { include: ["mine/*"] }).reason === "include" && repoCovered("mine/tool", { include: ["mine/*"] }).ok);
const q = scopeQualifiers({ include: ["mine/*", "other/lib"], exclude: ["skipped/*"], blocked }, "is:open involves:@me");
check("the search narrows itself with qualifiers", q.join(" ") === "user:mine repo:other/lib -repo:acme/widgets -user:skipped", q);
check("qualifiers that would make the query too long are left out", scopeQualifiers({ include: ["a/" + "b".repeat(240), "c/d"] }, "x".repeat(20)).length === 0);

// ---------- the snapshot ----------

const H = 3600000;
const ago = (h) => new Date(Date.now() - h * H).toISOString();
const user = (login) => ({ login, __typename: "User" });
const botUser = (login) => ({ login, __typename: "Bot" });
const comment = (login, h, body, url = "https://github.com/x#c") => ({ id: `C_${login}_${h}`, author: login.endsWith("[bot]") ? botUser(login) : user(login), authorAssociation: "NONE", createdAt: ago(h), body, url });
const list = (nodes) => ({ totalCount: nodes.length, nodes });
function issue(repo, number, { author = ME, comments = [], status = [], state = "OPEN", stateReason = null, assignees = [], updated = 1 } = {}) {
	return {
		__typename: "Issue", number, title: `Issue ${repo}#${number}`, url: `https://github.com/${repo}/issues/${number}`, body: "Body", createdAt: ago(200), updatedAt: ago(updated), closedAt: state === "CLOSED" ? ago(updated) : null, state, stateReason,
		repository: { nameWithOwner: repo }, author: user(author), authorAssociation: "NONE", labels: list([]), assignees: list(assignees.map((l) => ({ login: l }))),
		comments: list(comments.slice(-5)), timelineComments: list(comments), statusEvents: { nodes: status }, closedByPullRequestsReferences: { nodes: [] },
	};
}
function pr(repo, number, { author = ME, comments = [], reviews = [], status = [], state = "OPEN", requested = [], ci = "SUCCESS", commits = [], threads = [], updated = 1, permission = "READ" } = {}) {
	return {
		__typename: "PullRequest", number, title: `PR ${repo}#${number}`, url: `https://github.com/${repo}/pull/${number}`, body: "Body", createdAt: ago(300), updatedAt: ago(updated), closedAt: state === "OPEN" ? null : ago(updated), isDraft: false, state,
		repository: { nameWithOwner: repo, viewerPermission: permission }, author: user(author), authorAssociation: "CONTRIBUTOR", labels: list([]), assignees: list([]),
		headRefOid: "a".repeat(40), reviewDecision: null, mergeable: "MERGEABLE", commits: { nodes: [{ commit: { statusCheckRollup: { state: ci } } }] },
		recentCommits: { nodes: commits.map(([login, h]) => ({ commit: { oid: "b".repeat(40), committedDate: ago(h), author: { name: login, user: { login } } } })) },
		comments: list(comments.slice(-5)), timelineComments: list(comments), statusEvents: { nodes: status },
		allReviews: { nodes: reviews.map(([login, h, st, body = ""]) => ({ author: user(login), state: st, submittedAt: ago(h), url: `https://github.com/${repo}/pull/${number}#r${h}`, body })) },
		reviewRequests: { nodes: requested.map((l) => ({ requestedReviewer: { __typename: "User", login: l } })) },
		reviewThreads: { nodes: threads },
	};
}
const event = (type, login, h) => ({ __typename: type, createdAt: ago(h), actor: user(login) });
const discussion = (repo, number, { comments = [] } = {}) => ({
	__typename: "Discussion", number, title: `Discussion ${repo}#${number}`, url: `https://github.com/${repo}/discussions/${number}`, body: "Q", createdAt: ago(100), updatedAt: ago(2), closed: false, closedAt: null,
	repository: { nameWithOwner: repo }, author: user(ME), authorAssociation: "NONE", labels: list([]), category: { name: "Q&A", isAnswerable: true }, isAnswered: false, answer: null,
	comments: list(comments.slice(-5).map((c) => ({ ...c, replies: list([]) }))), timelineComments: list(comments.map((c) => ({ ...c, replies: list([]) }))),
});

const nodes = {
	review: pr("other/lib", 5, { author: "alice", requested: [ME], comments: [comment("alice", 30, "Could you have a look?")] }),
	ownPr: pr("mine/tool", 7, { permission: "WRITE", comments: [comment(ME, 20, "Ready"), comment("bob", 4, "> @octocat said ready\nPlease split the commit. What do you think?")], reviews: [["bob", 5, "CHANGES_REQUESTED", "Split it"]] }),
	maintainerRepo: pr("acme/widgets", 99),
	excluded: pr("skipped/thing", 1),
	plusOne: issue("other/lib", 3, { author: "carol", comments: [comment(ME, 10, "Same for me on 1.2"), comment("carol", 5, "+1"), comment("ci[bot]", 4, "Stale soon")] }),
	answered: issue("other/lib", 4, { author: "carol", comments: [comment(ME, 10, "Any news?"), comment("dave", 6, "Fixed in 2.0, closing soon"), comment("ci[bot]", 5, "Released")] }),
	merged: pr("other/lib", 8, { state: "MERGED", status: [event("MergedEvent", "dave", 2)], comments: [comment(ME, 30, "Rebased")] }),
	closedByMe: issue("other/lib", 9, { state: "CLOSED", stateReason: "COMPLETED", status: [event("ClosedEvent", ME, 3)], comments: [comment("erin", 5, "Thanks")] }),
	disc: discussion("third/app", 2, { comments: [comment("frank", 3, "Try the reset pin")] }),
};
const searches = (extra = {}) => ({
	searches: [
		{ match: "review-requested:@me", nodes: [nodes.review] },
		{ match: "is:pr draft:false author:@me", nodes: [nodes.ownPr, nodes.maintainerRepo, nodes.excluded] },
		{ match: "is:open involves:@me archived:false", nodes: extra.involved ?? [nodes.plusOne, nodes.answered] },
		{ match: "is:closed involves:@me archived:false", nodes: [nodes.merged, nodes.closedByMe] },
		{ match: "is:open involves:@me updated", nodes: [nodes.disc] },
	],
	items: { "other/lib#4": nodes.answered, "mine/tool#7": nodes.ownPr },
});
writeFileSync(ghData, JSON.stringify(searches()));
writeFileSync(ghLog, "");
const out = join(T, "run", "snapshot.json");
let r = cli(["snapshot", "--out", out]);
check("the snapshot runs", r.status === 0, r.stderr);
let snap = JSON.parse(readFileSync(out, "utf8"));
const ids = (list) => list.map((e) => (typeof e === "string" ? e : e.id)).sort();
const byId = Object.fromEntries(snap.changed.map((e) => [e.id, e]));
check("it keeps the threads of covered repos", ids(snap.changed).join() === ["other.lib.pr-5", "mine.tool.pr-7", "other.lib.issue-4", "other.lib.pr-8", "third.app.disc-2"].sort().join(), ids(snap.changed));
check("a maintainer repo and an excluded repo never reach it", !ids([...snap.changed, ...snap.quiet]).some((id) => /acme\.widgets|skipped\./.test(id)));
check("a thread the maintainer closed themself holds no news and is left out", !ids([...snap.changed, ...snap.quiet]).includes("other.lib.issue-9"));
check("a thread with only a +1 and a bot since the maintainer's comment is quiet", snap.quiet.join() === "other.lib.issue-3", snap.quiet);
check("every entry carries its repo", snap.changed.every((e) => typeof e.repo === "string" && e.id === contributionId(e.repo, e.kind, e.number)));
const own = byId["mine.tool.pr-7"].facts;
check("the maintainer's own PR: author, the change request and the news after their comment", own.involvement.includes("author") && own.changesRequestedBy.join() === "bob" && own.lookedVia === "comment" && own.news.map((n) => n.kind).join() === "review,comment", own);
check("a mention inside a quote is no mention, the question still asks the maintainer", own.news.at(-1).mentionsMe === undefined && own.news.at(-1).asksMe === true && !/@octocat/.test(own.news.at(-1).excerpt));
check("a review request carries the involvement and nothing the maintainer looked at", byId["other.lib.pr-5"].facts.involvement.join() === "review_requested" && byId["other.lib.pr-5"].facts.lookedAt === null && byId["other.lib.pr-5"].facts.reviewRequested === true);
const answered = byId["other.lib.issue-4"].facts;
check("the news drop bots and keep the maintainer's answer", answered.news.length === 1 && answered.news[0].by === "dave" && answered.involvement.join() === "commenter", answered);
const reminders = { mergeReminderDays: 14, mergeReminderDaysFor: { "acme/*": 30, "acme/widgets": 60 } };
check("the merge reminder takes the exact repo, then owner/*, then the default", mergeReminderDaysOf("acme/widgets", reminders) === 60 && mergeReminderDaysOf("acme/gadgets", reminders) === 30 && mergeReminderDaysOf("other/lib", reminders) === 14 && mergeReminderDaysOf("other/lib") === 14);
check("a PR carries the days before a merge reminder", own.mergeReminderDays === 14 && byId["other.lib.issue-4"].facts.mergeReminderDays === undefined, own.mergeReminderDays);
check("mergeReminderDaysFor takes repos and whole days only", validateConfig({ kind: "contributions", me: ME, mergeReminderDaysFor: { "acme/*": 30 } }).length === 0 && validateConfig({ kind: "contributions", me: ME, mergeReminderDaysFor: { "acme": 30 } }).some((e) => /mergeReminderDaysFor/.test(e)) && validateConfig({ kind: "contributions", me: ME, mergeReminderDays: 0 }).some((e) => /mergeReminderDays/.test(e)));
check("canMerge follows the login's permission on the repo", own.canMerge === true && byId["other.lib.pr-5"].facts.canMerge === false, [own.canMerge, byId["other.lib.pr-5"].facts.canMerge]);
check("a merged PR of the maintainer's carries who merged it", byId["other.lib.pr-8"].facts.closed.by === "dave" && byId["other.lib.pr-8"].facts.closed.how === "merged" && byId["other.lib.pr-8"].facts.news.some((n) => n.kind === "merged"));
check("only the instance's maintainer is us in the timeline, so a maintainer who spoke last waits on them", byId["other.lib.issue-4"].facts.timeline.find((e) => e.author === "dave").side === "them" && byId["other.lib.issue-4"].facts.waitingOn === "us");
check("no cut without a cap", snap.cut === undefined && snap.stale.issues === 0);
const log = readFileSync(ghLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => /ContributionsSearch/.test(l.stdin));
const queries = log.map((l) => JSON.parse(l.stdin).variables.q);
check("the searches narrow themselves to the covered repos", queries.length === 10 && queries.every((x) => x.includes("-repo:acme/widgets") && x.includes("-user:skipped")), queries);
check("own PRs and review requests count at any age, the rest only in the active window", queries.filter((x) => !/updated:>=|closed:>=/.test(x)).length === 2);
const pending = JSON.parse(readFileSync(join(STATE, "snapshot.pending.json"), "utf8"));
check("the staged entries keep repo, state and activity", pending.items["other.lib.pr-8"].repo === "other/lib" && pending.items["other.lib.pr-8"].githubState === "merged" && Array.isArray(pending.items["other.lib.issue-4"].activity.events));

cli(["snapshot", "--commit"]);

// Got it: the stored item's time counts as the maintainer's last look
writeFileSync(join(BOARD, "items", "other.lib.issue-4.json"), JSON.stringify({ repo: "other/lib", kind: "issue", number: 4, gotIt: { at: ago(3) } }));
r = cli(["snapshot", "--out", out]);
snap = JSON.parse(readFileSync(out, "utf8"));
const unchangedAfter = snap.unchanged.includes("other.lib.issue-4");
r = cli(["item", "other.lib.issue-4"]);
const fresh = JSON.parse(r.stdout || "{}");
check("gary item reads a thread of any covered repo", fresh.repo === "other/lib" && fresh.id === "other.lib.issue-4", r.stderr);
check("after Got it, the news before it are no news", fresh.facts?.lookedVia === "got_it" && fresh.facts.news.length === 0 && fresh.facts.quiet === true && unchangedAfter, fresh.facts);
nodes.answered.timelineComments = list([...nodes.answered.timelineComments.nodes, comment("dave", 1, "2.0.1 has the full fix")]);
nodes.answered.updatedAt = ago(0.5);
writeFileSync(ghData, JSON.stringify(searches()));
r = cli(["snapshot", "--out", out]);
snap = JSON.parse(readFileSync(out, "utf8"));
const back = snap.changed.find((e) => e.id === "other.lib.issue-4");
check("new relevant activity after Got it comes back as news", back?.facts.lookedVia === "got_it" && back.facts.news.length === 1 && /2\.0\.1/.test(back.facts.news[0].excerpt), back?.facts);
r = cli(["item", "issue", "4"]);
check("gary item without --repo names the missing repo", r.status !== 0 && /--repo/.test(r.stderr), r.stderr);
r = cli(["item", "pr", "99", "--repo", "acme/widgets"]);
check("gary item refuses a maintainer repo", r.status !== 0 && /not a repository of instance mine/.test(r.stderr), r.stderr);

// The cap
writeConfig({ maxItems: 10 });
writeFileSync(ghData, JSON.stringify(searches({ involved: Array.from({ length: 14 }, (_, i) => issue("many/repo", 100 + i)) })));
r = cli(["snapshot", "--out", out]);
snap = JSON.parse(readFileSync(out, "utf8"));
check("the cap keeps maxItems threads and says where it cut", snap.changed.length + snap.quiet.length <= 10 && snap.cut?.search === "involved" && snap.cut.max === 10 && /stopped at maxItems 10/.test(r.stderr) && /"involved" matched 14 threads/.test(snap.cut.message), { cut: snap.cut, stderr: r.stderr });
const kept = ids([...snap.changed, ...snap.quiet, ...snap.unchanged]);
check("the cap keeps who waits on the maintainer first", kept.includes("other.lib.pr-5") && kept.includes("mine.tool.pr-7"), kept);
writeConfig({ include: ["mine/*"] });
writeFileSync(ghData, JSON.stringify(searches()));
writeFileSync(ghLog, "");
r = cli(["snapshot", "--out", out]);
snap = JSON.parse(readFileSync(out, "utf8"));
check("include keeps only its repos", ids([...snap.changed, ...snap.quiet, ...snap.unchanged]).join() === "mine.tool.pr-7", snap);
check("include goes into the query", readFileSync(ghLog, "utf8").includes("user:mine"));
writeConfig();
writeFileSync(ghData, JSON.stringify(searches()));
cli(["snapshot", "--out", out]);
cli(["snapshot", "--commit"]);

// ---------- items ----------

const instances = JSON.parse(cli(["instances", "--json"]).stdout);
const mine = instances.find((i) => i.name === "mine");
check("its repos are the snapshot's, never a maintainer repo", mine.kind === "contributions" && mine.repos.includes("other/lib") && !mine.repos.some((x) => x.toLowerCase() === "acme/widgets"), mine);
const base = { repo: "other/lib", kind: "issue", number: 4, title: "t", url: "https://github.com/other/lib/issues/4", author: "carol", authorType: "contributor", state: "Dave fixed it in 2.0.", reviewDepth: "quick", effortMinutes: 1 };
const opts = { mode: "none", profile: { ...PROFILE_DEFAULTS, name: "Contributions", repo: null }, repos: ["other/lib"], kind: "contributions" };
const errs = (doc, o = opts) => validateItem("other.lib.issue-4", doc, o).errors.map((e) => e.code);
check("an fyi item without routes passes with newsAt", errs({ ...base, category: "fyi", newsAt: ago(6) }).length === 0, errs({ ...base, category: "fyi", newsAt: ago(6) }));
check("an fyi item needs newsAt", errs({ ...base, category: "fyi" }).includes("newsAt"));
check("a maintainer instance refuses fyi", validateItem("issue-4", { ...base, repo: "acme/widgets", category: "fyi", newsAt: ago(6) }, { mode: "bot", profile: { ...PROFILE_DEFAULTS, repo: "acme/widgets" } }).errors.some((e) => e.code === "category" && /Only a contributions instance/.test(e.message)));
const withRoute = (route) => ({ ...base, category: "unblock", hint: route.title, priority: 1, routes: [{ id: "r1", recommended: true, ...route }] });
check("a reply the maintainer posts themself passes", errs(withRoute({ type: "reply", as: "me", title: "Reply: thanks", text: "Thanks" })).length === 0);
check("a bot reply is refused", errs(withRoute({ type: "reply", as: "bot", title: "Reply: thanks", text: "Thanks" })).includes("contribution-as"));
check("agent routes and merges are refused", errs(withRoute({ type: "follow_up", as: "agent", title: "Start fix: x", text: "x" })).includes("contribution-route") && errs(withRoute({ type: "merge", as: "me", title: "Merge: x" })).includes("contribution-route"));
check("label buttons and wants are refused", errs(withRoute({ type: "reply", as: "me", title: "Reply: x", text: "x", params: { alsoLabel: { add: ["bug"] } } })).includes("contribution-part") && errs({ ...base, category: "decide", wants: { assignees: ["x"] }, wantsReason: "x" }).includes("contribution-wants"));
check("a repo outside the snapshot is refused", errs({ ...base, repo: "acme/widgets", category: "decide" }).includes("repo"));
const fyiFile = join(T, "fyi.json");
writeFileSync(fyiFile, JSON.stringify({ ...base, category: "fyi", newsAt: ago(6) }));
r = cli(["put", "items", "other.lib.issue-4", fyiFile]);
const stored = JSON.parse(readFileSync(join(BOARD, "items", "other.lib.issue-4.json"), "utf8"));
check("gary put writes an fyi item and keeps the maintainer's Got it", r.status === 0 && stored.category === "fyi" && typeof stored.gotIt?.at === "string", r.stdout + r.stderr);

// ---------- no writes to GitHub ----------

const actionFile = join(T, "action.json");
writeFileSync(actionFile, JSON.stringify({ repo: "other/lib", action: "comment", kind: "issue", number: 4, text: "hi" }));
r = cli(["action", actionFile], { FAKE_GH_WRITES: join(T, "writes.log") });
check("gary action refuses for a contributions instance", r.status !== 0 && /writes nothing to GitHub/.test(r.stdout), r.stdout + r.stderr);
for (const args of [["pr-watch", "list", "--json"], ["link-escalated"], ["pr-origin"], ["fix-review", "start", "--pr", "1"], ["focus", "brief", "x"], ["reconcile", "due", "--json"], ["auto-review", "list"], ["push-check", "--pr", "1"]]) {
	r = cli(args);
	check(`gary ${args[0]} refuses with exit 3`, r.status === 3 && JSON.parse(r.stdout).kind === "contributions", r.stdout + r.stderr);
}
check("gary focus list still answers", cli(["focus", "list", "--json"]).status === 0);
const gh = await import("../scripts/lib/gh.mjs");
const config = await import("../scripts/lib/config.mjs");
process.env.GARY_HOME = root;
process.env.PATH = env.PATH;
process.env.FAKE_GH_WRITES = join(T, "writes.log");
let thrown = "";
try {
	await config.withInstance("mine", () => gh.graphql("mutation { addComment(input: {}) { clientMutationId } }"));
} catch (e) {
	thrown = e.message;
}
check("the gh wrapper refuses a mutation while a contributions instance is in scope", /writes nothing to GitHub/.test(thrown), thrown);
check("no write reached the fake gh", !readdirSync(T).includes("writes.log"));

// ---------- the server ----------

// Got it can mark the thread's notification as done, when the instance turns that on
const inbox = [
	{ id: "9001", unread: true, repo: "other/lib", subject: { type: "Issue", title: "Issue", url: "https://api.github.com/repos/other/lib/issues/4" } },
	{ id: "9002", unread: true, repo: "other/lib", subject: { type: "PullRequest", title: "PR", url: "https://api.github.com/repos/other/lib/pulls/4" } },
	{ id: "9003", unread: false, repo: "third/app", subject: { type: "Discussion", title: "Which version?", url: null } },
];
writeFileSync(ghData, JSON.stringify({ ...searches(), notifications: inbox }));
const ghWrites = join(T, "writes.jsonl");
writeFileSync(ghWrites, "");
const GH_LIB = JSON.stringify(new URL("../scripts/lib/gh.mjs", import.meta.url).href);
function clear(arg, extra = {}) {
	const code = `import { clearNotification } from ${GH_LIB}; try { console.log(JSON.stringify(await clearNotification(${JSON.stringify(arg)}))); } catch (e) { console.log(JSON.stringify({ error: e.message })); }`;
	const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...env, GARY_INSTANCE: "mine", FAKE_GH_CONTRIBUTIONS: ghData, FAKE_GH_WRITES: ghWrites, ...extra }, encoding: "utf8" });
	return JSON.parse(r.stdout || "{}");
}
const doneIds = () => readFileSync(ghWrites, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).notificationDone);
check("without the setting, no notification is cleared", /clearNotifications/.test(clear({ repo: "other/lib", kind: "issue", number: 4 }).error ?? "") && doneIds().length === 0);
writeConfig({ clearNotifications: true });
const clearedIssue = clear({ repo: "other/lib", kind: "issue", number: 4 });
check("an issue's notification is marked as done, and the PR with the same number stays", clearedIssue.found === true && clearedIssue.wasUnread === true && doneIds().join() === "9001", [clearedIssue, doneIds()]);
const clearedDisc = clear({ repo: "third/app", kind: "discussion", number: 2, title: "Which version?" });
check("a discussion is matched by its title", clearedDisc.found === true && clearedDisc.wasUnread === false && doneIds().join() === "9001,9003", [clearedDisc, doneIds()]);
check("a thread without a notification clears nothing", clear({ repo: "other/lib", kind: "pr", number: 5 }).found === false && doneIds().length === 2);
check("a dry run reads the inbox and sends nothing", clear({ repo: "other/lib", kind: "pr", number: 4, dryRun: true }).dryRun === true && doneIds().length === 2);
check("another login clears nothing", /stored gh login/.test(clear({ repo: "other/lib", kind: "pr", number: 4 }, { FAKE_GH_LOGIN: "someone" }).error ?? "") && doneIds().length === 2);
check("clearNotifications must be true or false", validateConfig({ kind: "contributions", me: ME, clearNotifications: "yes" }).some((e) => /clearNotifications/.test(e)));

const write = (id, doc) => writeFileSync(join(BOARD, "items", id + ".json"), JSON.stringify(doc));
const reviewedAt = ago(1);
write("other.lib.pr-5", { repo: "other/lib", kind: "pr", number: 5, title: "Review asked", url: "https://github.com/other/lib/pull/5", author: "alice", authorType: "contributor", category: "unblock", state: "s", reviewDepth: "quick", effortMinutes: 5, reviewedAt, hint: "Review: looks good",
	routes: [{ id: "r1", type: "review", as: "me", title: "Review: looks good", recommended: true, text: "LGTM", params: { event: "approve" } }, { id: "r2", type: "reply", as: "bot", title: "Reply: as bot", text: "x" }, { id: "r3", type: "follow_up", as: "agent", title: "Start fix: x", text: "x" }] });
write("other.lib.issue-4", { ...stored, gotIt: undefined, reviewedAt });
write("other.lib.pr-8", { repo: "other/lib", kind: "pr", number: 8, title: "Merged", url: "https://github.com/other/lib/pull/8", author: ME, authorType: "maintainer", category: "fyi", newsAt: ago(1), state: "s", reviewDepth: "quick", effortMinutes: 1, reviewedAt, routes: [] });
write("acme.widgets.issue-1", { repo: "acme/widgets", kind: "issue", number: 1, title: "sneaked", url: "https://github.com/acme/widgets/issues/1", author: "x", authorType: "contributor", category: "fyi", newsAt: ago(1), state: "s", reviewDepth: "quick", effortMinutes: 1, reviewedAt });
const child = spawn(process.execPath, [join(ROOT, "server", "server.mjs"), "--dry-run", "--port", String(PORT)], { env: { ...env, FAKE_GH_CONTRIBUTIONS: ghData }, stdio: ["ignore", "ignore", "pipe"] });
process.on("exit", () => child.kill("SIGTERM"));
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await new Promise((res) => setTimeout(res, 100));
const TOKEN = readFileSync(join(root, "state", "server-token"), "utf8").trim();
async function api(path, body) {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: body ? "POST" : "GET", headers: { "X-Board-Token": TOKEN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, data: await res.json() };
}
try {
	const st = (await api("/api/state")).data;
	const info = st.board.instances.find((i) => i.name === "mine");
	check("the board names the instance read-only, without one repo URL", info.kind === "contributions" && info.readOnly === true && info.repoUrl === null && info.title === "Contributions" && info.accountMode === "none", info);
	const served = Object.fromEntries(st.items.filter((i) => i.instance === "mine").map((i) => [i.id, i]));
	check("items carry their full ref", served["other.lib.pr-5"]?.ref === "other/lib#5");
	check("a thread the snapshot found merged is served as merged before any refresh", served["other.lib.pr-8"]?.liveState?.state === "MERGED" && served["other.lib.pr-5"]?.liveState === undefined, [served["other.lib.pr-8"]?.liveState, served["other.lib.pr-5"]?.liveState]);
	const hash = (id, route) => served[id].routes.find((x) => x.id === route).draftHash;
	const clickR = (id, route) => api("/api/action", { instance: "mine", itemId: id, routeId: route, draftHash: hash(id, route) });
	const readOnly = (res) => res.status === 200 && res.data.ok === false && res.data.readOnly === true;
	for (const route of ["r1", "r2", "r3"]) check(`route ${route} is refused, nothing goes to GitHub`, readOnly(await clickR("other.lib.pr-5", route)));
	check("Focus is refused: there is no checkout", readOnly(await api("/api/action", { instance: "mine", action: "focus", itemId: "other.lib.pr-5" })));
	check("a reconcile request is refused", readOnly(await api("/api/action", { instance: "mine", action: "request_reconcile" })));
	check("a label button is refused", readOnly(await api("/api/action", { instance: "mine", itemId: "other.lib.pr-5", routeId: "r1", input: { part: "label" } })));
	const db = await api("/api/db", { instance: "mine", op: "set", path: "actions/other.lib.pr-5-1", data: { itemId: "other.lib.pr-5", action: "start_fix", status: "queued", createdAt: new Date().toISOString() } });
	check("a page write of an agent job is refused", db.status === 409 && db.data.readOnly === true, db);
	const re = await api("/api/db", { instance: "mine", op: "set", path: "actions/other.lib.pr-5-2", data: { itemId: "other.lib.pr-5", action: "reanalyze", text: "Look again", status: "queued", via: "queue", createdAt: new Date().toISOString() } });
	check("Analyze again still queues", re.status === 200, re);
	check("Got it on an item that is no fyi is refused", (await api("/api/action", { instance: "mine", action: "got_it", itemId: "other.lib.pr-5" })).data.ok === false);
	check("Got it on a maintainer repo's item is refused", /no thread of this instance/.test((await api("/api/action", { instance: "mine", action: "got_it", itemId: "acme.widgets.issue-1" })).data.result));
	const refresh = await api("/api/refresh", { instance: "mine", itemId: "acme.widgets.issue-1" });
	check("the repo check refuses a maintainer repo even when an item names it", refresh.data.ok === false && /no thread of this instance/.test(refresh.data.result), refresh);
	const got = await api("/api/action", { instance: "mine", action: "got_it", itemId: "other.lib.issue-4" });
	const after = JSON.parse(readFileSync(join(BOARD, "items", "other.lib.issue-4.json"), "utf8"));
	check("Got it stores its time on the item", got.data.ok === true && after.gotIt?.at === got.data.gotIt.at, got);
	check("Got it reports the notification, and the dry run sends nothing", got.data.result === "Hidden until there is news. Dry run: the notification stays." && doneIds().length === 2, got.data.result);
	const logged = readdirSync(join(BOARD, "actions")).map((n) => JSON.parse(readFileSync(join(BOARD, "actions", n), "utf8"))).find((a) => a.action === "got_it");
	check("Got it is logged as the maintainer's choice", logged?.status === "done" && logged.itemId === "other.lib.issue-4" && logged.params?.by === undefined);
	check("a maintainer instance answers its own clicks as before", (await api("/api/action", { instance: "widgets", action: "got_it", itemId: "pr-404" })).data.result === "The board is out of date, reload it.");
} finally {
	child.kill("SIGTERM");
	removeDir(T);
}
done();
