// Drive and Focus on the maintainer's own PR in a contributions instance: the facts, the rules, the working copy and
// the one push. Local bare repos stand in for GitHub through a `url.<base>.insteadOf` in the test's git config, so
// every fetch and push stays on this machine.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { ME } from "./fixtures/github.mjs";
import { githubRepoOf, isInside, ownPrFacts, ownPrRefusal } from "../scripts/lib/own-pr.mjs";
import { validateItem } from "../scripts/lib/validate-item.mjs";
import { PROFILE_DEFAULTS, validateConfig } from "../scripts/lib/config.mjs";

const { check, done } = runner("own-pr");
const T = tempDir();
const PORT = await freePort();
const { root, env: baseEnv } = makeHome(T, { port: PORT });
const HOME = join(root, "instances", "mine");
const STATE = join(HOME, "state");
const BOARD = join(STATE, "board");
for (const c of ["items", "actions"]) mkdirSync(join(BOARD, c), { recursive: true });
const ROOTS = join(T, "repos");
// The local review has its own suite. Here it is off, so the push runs as it did before it existed
const writeConfig = (extra = {}) => writeFileSync(join(HOME, "config.json"), JSON.stringify({ kind: "contributions", me: ME, checkoutRoots: [ROOTS], review: { local: "off" }, ...extra }, null, "\t"));
writeConfig();

// ---------- git: two bare repos for GitHub, a clone of the maintainer's with a worktree on the PR's branch ----------

const REMOTES = join(T, "remotes");
const gitconfig = join(T, "gitconfig");
writeFileSync(gitconfig, `[url "file://${REMOTES}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Octo Cat\n\temail = octocat@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n`);
const env = { ...baseEnv, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) => {
	const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
for (const repo of ["other/lib", "octocat/lib"]) {
	mkdirSync(join(REMOTES, repo + ".git"), { recursive: true });
	git(join(REMOTES, repo + ".git"), "init", "--bare", "-q");
}
const seed = join(T, "seed");
mkdirSync(seed);
git(seed, "init", "-q");
writeFileSync(join(seed, "download.sh"), "curl -o typst.tar.xz $URL\n");
git(seed, "add", "-A");
git(seed, "commit", "-qm", "Initial");
git(seed, "push", "-q", "https://github.com/other/lib.git", "HEAD:refs/heads/main");
git(seed, "checkout", "-qb", "fix-sha");
writeFileSync(join(seed, "download.sh"), "curl -o typst.tar.xz $URL\ntar xf typst.tar.xz\n");
git(seed, "commit", "-qam", "Unpack the download");
const B = git(seed, "rev-parse", "HEAD");
git(seed, "push", "-q", "https://github.com/octocat/lib.git", "HEAD:refs/heads/fix-sha");
git(seed, "push", "-q", "https://github.com/other/lib.git", "HEAD:refs/pull/5/head");

mkdirSync(ROOTS);
const CLONE = join(ROOTS, "lib");
git(ROOTS, "clone", "-q", "https://github.com/other/lib.git", "lib");
writeFileSync(join(CLONE, "secret.txt"), "confidential, uncommitted\n");
git(CLONE, "fetch", "-q", "https://github.com/octocat/lib.git", "fix-sha:fix-sha");
const USER_WT = join(ROOTS, "lib-fix");
git(CLONE, "worktree", "add", "-q", USER_WT, "fix-sha");
mkdirSync(join(ROOTS, "unrelated"));
git(join(ROOTS, "unrelated"), "init", "-q");
const cloneState = () => ({ head: git(CLONE, "rev-parse", "--abbrev-ref", "HEAD"), status: git(CLONE, "status", "--porcelain"), wtHead: git(USER_WT, "rev-parse", "HEAD"), wtStatus: git(USER_WT, "status", "--porcelain") });
const before = cloneState();

// ---------- facts and rules ----------

const commitBy = (login, message = "x") => ({ commit: { oid: "c".repeat(40), message, author: { name: login, email: `${login}@example.com`, user: { login } }, committer: { name: login, email: `${login}@example.com`, user: { login } } } });
const ownNode = (extra = {}) => ({
	number: 5, state: "OPEN", headRefName: "fix-sha", headRefOid: B, isCrossRepository: true, author: { login: ME },
	baseRepository: { nameWithOwner: "other/lib" }, headRepository: { nameWithOwner: "octocat/lib", owner: { login: ME }, viewerPermission: "ADMIN" },
	allCommits: { totalCount: 1, nodes: [commitBy(ME)] }, ...extra,
});
const f = ownPrFacts(ownNode(), { me: ME });
check("a PR from the maintainer's own fork is pushable and has no foreign commit", f.pushable === true && f.foreign === null && f.headRepo === "octocat/lib" && f.headRef === "fix-sha", f);
check("a fork of someone else without write access is not pushable", ownPrFacts(ownNode({ headRepository: { nameWithOwner: "org/lib", owner: { login: "org" }, viewerPermission: "READ" } }), { me: ME }).notPushable === "your login cannot push to org/lib");
check("write access to another fork is enough", ownPrFacts(ownNode({ headRepository: { nameWithOwner: "org/lib", owner: { login: "org" }, viewerPermission: "WRITE" } }), { me: ME }).pushable === true);
check("a deleted head repo is not pushable", ownPrFacts(ownNode({ headRepository: null }), { me: ME }).pushable === false);
const foreign = ownPrFacts(ownNode({ allCommits: { totalCount: 2, nodes: [commitBy(ME), commitBy("bob")] } }), { me: ME });
check("a commit by someone else is foreign", foreign.foreign === "commit 2 of 2 was authored by bob", foreign);
check("a human co-author is foreign, an AI co-author is not", /co-author bob/.test(ownPrFacts(ownNode({ allCommits: { totalCount: 1, nodes: [commitBy(ME, "x\n\nCo-authored-by: bob <bob@example.com>")] } }), { me: ME }).foreign) && ownPrFacts(ownNode({ allCommits: { totalCount: 1, nodes: [commitBy(ME, "x\n\nCo-authored-by: Claude <noreply@anthropic.com>")] } }), { me: ME }).foreign === null);
check("an incomplete commit list counts as foreign", /incomplete/.test(ownPrFacts(ownNode({ allCommits: { totalCount: 101, nodes: [commitBy(ME)] } }), { me: ME }).foreign));
const item = { kind: "pr", number: 5, author: ME };
const entry = { author: ME, githubState: "open", ownPr: f };
check("ownPrRefusal lets the maintainer's own pushable PR through", ownPrRefusal(item, entry, ME) === null);
check("ownPrRefusal refuses other people's PRs, issues, closed PRs and foreign commits", /not your PR/.test(ownPrRefusal({ ...item, author: "alice" }, { ...entry, author: "alice" }, ME)) && /Only a PR/.test(ownPrRefusal({ ...item, kind: "issue" }, entry, ME)) && /merged/.test(ownPrRefusal(item, { ...entry, githubState: "merged" }, ME)) && /Someone else has commits/.test(ownPrRefusal(item, { ...entry, ownPr: foreign }, ME)) && /no snapshot/.test(ownPrRefusal(item, undefined, ME)));
check("a remote URL names its GitHub repo", githubRepoOf("git@github.com:Other/Lib.git") === "other/lib" && githubRepoOf("https://github.com/other/lib") === "other/lib" && githubRepoOf("https://gitlab.com/other/lib.git") === null);
check("isInside keeps paths in their directory", isInside("/a/b/c", "/a/b") && !isInside("/a/bc", "/a/b") && !isInside("/a/b", "/a/b"));
check("checkoutRoots takes absolute and ~/ paths", validateConfig({ kind: "contributions", me: ME, checkoutRoots: ["~/repositories", "/srv/src"] }).length === 0 && validateConfig({ kind: "contributions", me: ME, checkoutRoots: ["repositories"] }).some((e) => /checkoutRoots/.test(e)) && validateConfig({ kind: "contributions", me: ME, checkoutRoots: "~/x" }).some((e) => /checkoutRoots/.test(e)));
check("a maintainer config treats checkoutRoots as unknown", validateConfig({ kind: "maintainer", me: ME, profile: "x", checkoutRoots: [] }).join() === 'unknown field "checkoutRoots"');

// ---------- the snapshot ----------

const ghData = join(T, "contributions.json");
const H = 3600000;
const ago = (h) => new Date(Date.now() - h * H).toISOString();
const user = (login) => ({ login, __typename: "User" });
const list = (nodes) => ({ totalCount: nodes.length, nodes });
const prNode = (number, author, extra = {}) => ({
	__typename: "PullRequest", number, title: `PR ${number}`, url: `https://github.com/other/lib/pull/${number}`, body: "Body", createdAt: ago(300), updatedAt: ago(1), closedAt: null, isDraft: false, state: "OPEN",
	repository: { nameWithOwner: "other/lib", viewerPermission: "READ" }, author: user(author), authorAssociation: "CONTRIBUTOR", labels: list([]), assignees: list([]),
	headRefOid: B, headRefName: "fix-sha", reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE", commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
	recentCommits: { nodes: [] }, comments: list([]), timelineComments: list([]), statusEvents: { nodes: [] },
	allReviews: { nodes: [{ author: user("bob"), state: "CHANGES_REQUESTED", submittedAt: ago(2), url: "https://github.com/other/lib/pull/5#r1", body: "Verify the Typst download against its SHA." }] },
	reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] }, ...extra,
});
const ghWith = (own = ownNode()) => writeFileSync(ghData, JSON.stringify({
	searches: [
		{ match: "review-requested:@me", nodes: [prNode(6, "alice", { reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: ME } }] } })] },
		{ match: "is:pr draft:false author:@me", nodes: [prNode(5, ME)] },
	],
	items: { "other/lib#5": prNode(5, ME) },
	ownPrs: { "other/lib#5": own },
}));
ghWith();
const cli = (args, extra = {}) => spawnSync(process.execPath, [GARY, "--instance", "mine", ...args], { env: { ...env, FAKE_GH_CONTRIBUTIONS: ghData, ...extra }, encoding: "utf8" });
const json = (r) => {
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { raw: r.stdout + r.stderr };
	}
};
const out = join(T, "run", "snapshot.json");
let r = cli(["snapshot", "--out", out]);
check("the snapshot runs", r.status === 0, r.stderr);
const snap = JSON.parse(readFileSync(out, "utf8"));
const own = snap.changed.find((e) => e.id === "other.lib.pr-5");
check("the maintainer's own PR carries ownPr and its head branch", own?.facts.ownPr?.pushable === true && own.facts.ownPr.foreign === null && own.headRef === "fix-sha", own?.facts.ownPr);
check("a PR of someone else carries no ownPr", !snap.changed.find((e) => e.id === "other.lib.pr-6")?.facts.ownPr);
cli(["snapshot", "--commit"]);
const committed = JSON.parse(readFileSync(join(STATE, "snapshot.json"), "utf8")).items;
check("the committed entry keeps ownPr for the server", committed["other.lib.pr-5"]?.ownPr?.headRepo === "octocat/lib" && committed["other.lib.pr-5"].headRef === "fix-sha", committed["other.lib.pr-5"]);

// ---------- the item rules ----------

const base = { repo: "other/lib", kind: "pr", number: 5, title: "PR 5", url: "https://github.com/other/lib/pull/5", author: ME, authorType: "maintainer", category: "act", state: "Bob asked to verify the download.", reviewDepth: "quick", effortMinutes: 5, priority: 1 };
const drive = { id: "r1", type: "drive", as: "agent", title: "Drive: verify the download against its SHA", recommended: true, text: "Check the SHA-256 of the archive before unpacking it." };
const withRoutes = (doc, ...routes) => ({ ...doc, hint: routes.find((x) => x.recommended)?.title, routes });
const opts = { mode: "none", profile: { ...PROFILE_DEFAULTS, name: "Contributions", repo: null }, repos: ["other/lib"], kind: "contributions", entry: committed["other.lib.pr-5"], me: ME };
const codes = (doc, o = opts, id = "other.lib.pr-5") => validateItem(id, doc, o).errors.map((e) => e.code);
check("a drive passes on the maintainer's own pushable PR", codes(withRoutes(base, drive)).length === 0, validateItem("other.lib.pr-5", withRoutes(base, drive), opts).errors);
check("a drive is refused on a PR of someone else", codes(withRoutes({ ...base, number: 6, author: "alice", authorType: "contributor", url: "https://github.com/other/lib/pull/6" }, drive), { ...opts, entry: committed["other.lib.pr-6"] }, "other.lib.pr-6").includes("contribution-drive"));
check("a drive is refused when someone else committed to the branch", codes(withRoutes(base, drive), { ...opts, entry: { ...opts.entry, ownPr: { ...opts.entry.ownPr, foreign: "commit 2 of 2 was authored by bob" } } }).includes("contribution-drive"));
check("a drive needs its text and runs as the agent", codes(withRoutes(base, { ...drive, text: "" })).includes("contribution-drive") && codes(withRoutes(base, { ...drive, as: "me" })).includes("contribution-as"));
const change = { id: "r1", type: "open", as: "me", title: "Change: verify the Typst download against its SHA", recommended: true };
check("an open card named Change is refused where a drive is allowed", codes(withRoutes(base, change)).includes("contribution-change"));
check("an open card named Change stays allowed where no drive is", !codes(withRoutes(base, change), { ...opts, entry: { ...opts.entry, ownPr: { ...opts.entry.ownPr, pushable: false, notPushable: "x" } } }).includes("contribution-change"));
const itemFile = join(T, "item.json");
writeFileSync(itemFile, JSON.stringify(withRoutes(base, drive, { id: "r2", type: "reply", as: "me", title: "Reply: on it", text: "On it." })));
r = cli(["put", "items", "other.lib.pr-5", itemFile]);
check("gary put writes the item with its drive", r.status === 0, r.stdout + r.stderr);
writeFileSync(join(BOARD, "items", "other.lib.pr-6.json"), JSON.stringify(withRoutes({ ...base, number: 6, author: "alice", authorType: "contributor", url: "https://github.com/other/lib/pull/6", category: "unblock" }, { ...drive, id: "r1" })));

// ---------- the working copy ----------

r = cli(["own-pr", "locate", "other.lib.pr-5"]);
const loc = json(r);
check("locate finds the clone by its remote and the worktree with the PR's branch", r.status === 0 && loc.clone === CLONE && loc.fresh === false && loc.branchWorktree === USER_WT && loc.refused === null, loc);
const action = (id, extra = {}) => writeFileSync(join(BOARD, "actions", id + ".json"), JSON.stringify({ itemId: "other.lib.pr-5", action: "drive", params: { ownPr: true, headSha: B }, text: "x", status: "queued", createdAt: new Date().toISOString(), ...extra }));
action("drive-1");
r = cli(["own-pr", "workdir", "other.lib.pr-5", "--sha", B]);
check("workdir needs the request", r.status === 1 && /--request/.test(json(r).result), json(r));
action("other-1", { action: "reanalyze" });
check("a request that is no drive does not count", cli(["own-pr", "workdir", "other.lib.pr-5", "--request", "other-1"]).status === 3);
r = cli(["own-pr", "workdir", "other.lib.pr-5", "--request", "drive-1", "--sha", "f".repeat(40)]);
check("workdir refuses a head that moved", r.status === 3 && /Someone pushed/.test(json(r).refused), json(r));
r = cli(["own-pr", "workdir", "other.lib.pr-5", "--request", "drive-1", "--sha", B]);
const wd = json(r);
check("workdir adds a detached worktree of the PR head under the state directory", r.status === 0 && wd.worktree === join(STATE, "own-pr", "worktrees", "other.lib.pr-5") && wd.headSha === B && wd.clone === CLONE && git(wd.worktree, "rev-parse", "HEAD") === B, wd);
check("the maintainer's clone and worktree are untouched", JSON.stringify(cloneState()) === JSON.stringify(before), [before, cloneState()]);

// ---------- the push ----------

writeFileSync(join(wd.worktree, "download.sh"), "curl -o typst.tar.xz $URL\nsha256sum -c typst.sha256\ntar xf typst.tar.xz\n");
git(wd.worktree, "commit", "-qam", "Verify the download against its SHA");
const C = git(wd.worktree, "rev-parse", "HEAD");
const fork = join(REMOTES, "octocat/lib.git");
const pushCmd = (extra = [], envExtra = {}) => cli(["own-pr", "push", "other.lib.pr-5", "--worktree", wd.worktree, "--sha", B, "--request", "drive-1", ...extra], envExtra);
r = pushCmd(["--dry-run"]);
check("a dry run names the push and sends nothing", r.status === 0 && json(r).dryRun === true && json(r).invocation.command.includes("HEAD:refs/heads/fix-sha") && !json(r).invocation.command.includes("--force") && git(fork, "rev-parse", "fix-sha") === B, json(r));
check("GARY_DRY_RUN stops the push too", pushCmd([], { GARY_DRY_RUN: "1" }).status === 0 && git(fork, "rev-parse", "fix-sha") === B);
writeFileSync(join(STATE, "control.json"), JSON.stringify({ paused: true }));
r = pushCmd();
check("a paused instance pushes nothing, exit 4", r.status === 4 && git(fork, "rev-parse", "fix-sha") === B, json(r));
writeFileSync(join(STATE, "control.json"), JSON.stringify({ paused: false }));
ghWith(ownNode({ allCommits: { totalCount: 2, nodes: [commitBy(ME), commitBy("bob")] } }));
r = pushCmd();
check("a foreign commit on GitHub now refuses the push", r.status === 3 && /Someone else has commits/.test(json(r).refused) && git(fork, "rev-parse", "fix-sha") === B, json(r));
ghWith();
r = cli(["own-pr", "push", "other.lib.pr-5", "--worktree", USER_WT, "--sha", B, "--request", "drive-1"]);
check("a push from the maintainer's own worktree is refused", r.status === 3 && /not one of Gary's worktrees/.test(json(r).refused), json(r));
r = pushCmd([], { FAKE_GH_LOGIN: "someone" });
check("another stored gh login pushes nothing", r.status !== 0 && git(fork, "rev-parse", "fix-sha") === B, json(r));
// The default local review of a contributions instance is the self review, and the push waits for it
writeConfig({ review: undefined });
r = pushCmd();
check("with the default self review a push without a local review is refused", r.status === 3 && /has no local review/.test(json(r).refused) && git(fork, "rev-parse", "fix-sha") === B, json(r));
const quiet = join(T, "quiet-review.mjs");
writeFileSync(quiet, 'console.log(JSON.stringify({ findings: [] }));\n');
writeConfig({ review: { local: [{ kind: "cli", argv: [process.execPath, quiet] }] } });
r = cli(["local-review", "pass", "other.lib.pr-5", "--base", B, "--head", C, "--worktree", wd.worktree, "--job", "drive-1"]);
check("a CLI reviewer runs on the own PR's commit and finds nothing", r.status === 0 && json(r).findings === 0 && json(r).cli[0].status === "done", json(r));
check("gary own-pr push asks for the local review of its HEAD", cli(["local-review", "check", "other.lib.pr-5", "--head", C, "--base", B]).status === 0);
r = pushCmd();
check("the push puts the new commit on the PR's head branch", r.status === 0 && json(r).pushed === C && git(fork, "rev-parse", "fix-sha") === C && json(r).url === `https://github.com/other/lib/pull/5/commits/${C}`, json(r));
check("the maintainer's clone and worktree are still untouched", JSON.stringify(cloneState()) === JSON.stringify(before), [before, cloneState()]);
action("drive-1", { status: "done" });
check("a finished request pushes nothing more", pushCmd().status === 3);
r = cli(["own-pr", "cleanup", "other.lib.pr-5", "--worktree", wd.worktree]);
check("cleanup removes Gary's worktree and its ref from the clone", r.status === 0 && !existsSync(wd.worktree) && !git(CLONE, "worktree", "list").includes("own-pr") && !git(CLONE, "for-each-ref", "refs/gary").length, json(r));
check("cleanup refuses another path", cli(["own-pr", "cleanup", "other.lib.pr-5", "--worktree", USER_WT]).status === 3 && existsSync(USER_WT));
writeConfig({ checkoutRoots: [] });
r = cli(["own-pr", "locate", "other.lib.pr-5"]);
check("without a clone the work uses a fresh clone under the state directory", json(r).fresh === true && json(r).clone === join(STATE, "own-pr", "clones", "other-lib") && !existsSync(json(r).clone), json(r));
action("drive-2");
r = cli(["own-pr", "workdir", "other.lib.pr-5", "--request", "drive-2", "--sha", B]);
check("workdir clones the repo fresh when no root holds it", r.status === 0 && json(r).fresh === true && existsSync(join(STATE, "own-pr", "clones", "other-lib", ".git")) && git(json(r).worktree, "rev-parse", "HEAD") === B, json(r));
cli(["own-pr", "cleanup", "other.lib.pr-5", "--worktree", json(r).worktree]);
writeConfig();
action("drive-2", { status: "done" });
check("own-pr refuses an item that is no own PR", cli(["own-pr", "check", "other.lib.pr-6"]).status === 3);

// ---------- focus ----------

r = cli(["focus", "brief", "other.lib.pr-5", "--harness", "t3code", "--master", "m1"]);
const brief = json(r);
check("focus brief on the own PR names the clone and the worktree with its branch", r.status === 0 && brief.checkout === CLONE && brief.branchWorktree === USER_WT && brief.headRef === "fix-sha" && brief.worktree === null, brief);
r = cli(["focus", "brief", "other.lib.pr-5", "--harness", "t3code", "--master", "m1", "--worktree", "/tmp/w"]);
check("the briefing names Gary's worktree and the push command", /own-pr push other\.lib\.pr-5 --worktree \/tmp\/w/.test(json(r).briefing) && /Never check out, edit, commit or stash in any other checkout/.test(json(r).briefing) && !/push-check/.test(json(r).briefing), json(r).briefing);
r = cli(["focus", "brief", "other.lib.pr-6", "--harness", "t3code"]);
check("focus brief gives a PR of someone else a session that only reads", r.status === 0 && json(r).mode === "discuss" && json(r).checkout === CLONE && /Commit nothing, push nothing and open no PR/.test(json(r).briefing) && !/own-pr push/.test(json(r).briefing), json(r));
check("the own PR's brief names its mode", brief.mode === "own_pr");
check("focus workdir refuses the own PR", cli(["focus", "workdir", "other.lib.pr-5", "--request", "drive-1"]).status === 3);
git(seed, "push", "-q", "https://github.com/other/lib.git", `${B}:refs/pull/6/head`);
action("focus-6", { itemId: "other.lib.pr-6", action: "focus", params: {} });
const beforeRead = JSON.stringify(cloneState());
r = cli(["focus", "workdir", "other.lib.pr-6", "--request", "focus-6"]);
check("focus workdir adds a detached worktree of the PR's head for reading", r.status === 0 && json(r).worktree === join(STATE, "own-pr", "worktrees", "other.lib.pr-6") && git(json(r).worktree, "rev-parse", "HEAD") === B && JSON.stringify(cloneState()) === beforeRead, json(r));
r = cli(["focus", "brief", "other.lib.pr-6", "--harness", "t3code", "--worktree", json(r).worktree]);
check("the discuss briefing names Gary's worktree", json(r).briefing.includes(join(STATE, "own-pr", "worktrees", "other.lib.pr-6")) && /Do not run code from it/.test(json(r).briefing), json(r).briefing);
action("focus-6", { itemId: "other.lib.pr-6", action: "focus", params: {}, status: "done" });

// ---------- the server ----------

const child = spawn(process.execPath, [join(ROOT, "server", "server.mjs"), "--port", String(PORT)], { env: { ...env, FAKE_GH_CONTRIBUTIONS: ghData }, stdio: ["ignore", "ignore", "pipe"] });
process.on("exit", () => child.kill("SIGTERM"));
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await new Promise((res) => setTimeout(res, 100));
const TOKEN = readFileSync(join(root, "state", "server-token"), "utf8").trim();
async function api(path, body) {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: body ? "POST" : "GET", headers: { "X-Board-Token": TOKEN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, data: await res.json() };
}
const queued = () => readdirSync(join(BOARD, "actions")).map((n) => JSON.parse(readFileSync(join(BOARD, "actions", n), "utf8"))).filter((a) => a.status === "queued");
try {
	const served = Object.fromEntries((await api("/api/state")).data.items.filter((i) => i.instance === "mine").map((i) => [i.id, i]));
	const ownItem = served["other.lib.pr-5"];
	check("the own PR is served as eligible, with its drive as an agent route", ownItem?.ownPr?.eligible === true && ownItem.routes[0].actor === "agent" && ownItem.routes[0].ownPr === true, ownItem?.routes);
	check("a drive stored on someone else's PR is served unavailable", served["other.lib.pr-6"]?.routes[0].actor === "unavailable" && served["other.lib.pr-6"].ownPr === undefined, served["other.lib.pr-6"]?.routes);
	const click = (id, routeId = "r1", extra = {}) => api("/api/action", { instance: "mine", action: served[id].routes.find((x) => x.id === routeId).type, itemId: id, routeId, draftHash: served[id].routes.find((x) => x.id === routeId).draftHash, ...extra });
	check("the reply card stays a prefill", (await click("other.lib.pr-5", "r2")).data.readOnly === true);
	let res = await click("other.lib.pr-6");
	check("a drive on someone else's PR is refused", res.data.ok === false && /not your PR/.test(res.data.result) && !queued().some((a) => a.itemId === "other.lib.pr-6"), res.data);
	res = await click("other.lib.pr-5", "r1", { text: "Check the SHA-256 before unpacking. Fail on a mismatch." });
	const doc = queued().find((a) => a.action === "drive" && a.itemId === "other.lib.pr-5");
	check("Drive queues one agent request with the head it saw", res.data.ok === true && res.data.queued === true && doc?.params?.ownPr === true && doc.params.headSha === B && doc.params.headRepo === "octocat/lib" && doc.params.headRef === "fix-sha" && /Fail on a mismatch/.test(doc.text), [res.data, doc]);
	res = await click("other.lib.pr-5");
	check("the same Drive does not queue twice", res.status === 409 && res.data.duplicate === true, res.data);
	res = await api("/api/action", { instance: "mine", action: "focus", itemId: "other.lib.pr-6" });
	check("Focus on someone else's PR queues a focus request too", res.data.ok === true && queued().some((a) => a.action === "focus" && a.itemId === "other.lib.pr-6"), res.data);
	res = await api("/api/action", { instance: "mine", action: "focus", itemId: "other.lib.pr-5" });
	check("Focus on the own PR queues a focus request", res.data.ok === true && queued().some((a) => a.action === "focus" && a.itemId === "other.lib.pr-5"), res.data);
} finally {
	child.kill("SIGTERM");
}

// A dry-run server answers a Drive with the push it would run and queues nothing
for (const n of readdirSync(join(BOARD, "actions"))) if (/drive|focus/.test(readFileSync(join(BOARD, "actions", n), "utf8"))) writeFileSync(join(BOARD, "actions", n), JSON.stringify({ ...JSON.parse(readFileSync(join(BOARD, "actions", n), "utf8")), status: "done" }));
writeFileSync(itemFile, JSON.stringify(withRoutes({ ...base, state: "Bob asked again.", reviewedAt: new Date().toISOString() }, drive)));
cli(["put", "items", "other.lib.pr-5", itemFile]);
const PORT2 = await freePort();
writeFileSync(join(root, "config.json"), JSON.stringify({ port: PORT2 }));
const dry = spawn(process.execPath, [join(ROOT, "server", "server.mjs"), "--dry-run", "--port", String(PORT2)], { env: { ...env, FAKE_GH_CONTRIBUTIONS: ghData }, stdio: ["ignore", "ignore", "pipe"] });
process.on("exit", () => dry.kill("SIGTERM"));
let dryErr = "";
dry.stderr.on("data", (d) => (dryErr += d));
for (let i = 0; i < 50 && !dryErr.includes(" on http://127.0.0.1:"); i++) await new Promise((res) => setTimeout(res, 100));
try {
	const res2 = await fetch(`http://127.0.0.1:${PORT2}/api/state`, { headers: { "X-Board-Token": TOKEN } });
	const route = (await res2.json()).items.find((i) => i.id === "other.lib.pr-5").routes[0];
	const before2 = queued().length;
	const res = await (await fetch(`http://127.0.0.1:${PORT2}/api/action`, { method: "POST", headers: { "X-Board-Token": TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ instance: "mine", action: "drive", itemId: "other.lib.pr-5", routeId: "r1", draftHash: route.draftHash }) })).json();
	check("a dry run answers a Drive with the push and queues nothing", res.ok === true && res.result?.dryRun === true && queued().length === before2, res);
} finally {
	dry.kill("SIGTERM");
	removeDir(T);
}
done();
