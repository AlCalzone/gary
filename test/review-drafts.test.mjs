// Review drafts of a contributions instance: the limits on drafts that start without a click, the checks of a draft
// item, the pending review the server creates under the maintainer's login through the fake gh, and the served state.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { ME } from "./fixtures/github.mjs";
import { validateConfig } from "../scripts/lib/config.mjs";
import { validateItem } from "../scripts/lib/validate-item.mjs";
import { reviewDraftFacts } from "../scripts/lib/contributions.mjs";
import {
	botCommandIn, commentLineProblem, countWaiting, diffUrl, draftDecision, planDrafts, readReviewDrafts, reviewDraftSettings, reviewDraftState, rightSideHunks, servedWalkthrough, waitsForUser,
} from "../scripts/lib/review-drafts.mjs";

const { check, done } = runner("review-drafts");
const T = tempDir();
const PORT = await freePort();
const { root, env } = makeHome(T, { port: PORT });
const NAME = "mine";
const HOME = join(root, "instances", NAME);
const STATE = join(HOME, "state");
const BOARD = join(STATE, "board");
for (const c of ["items", "actions"]) mkdirSync(join(BOARD, c), { recursive: true });
const writeConfig = (extra = {}) => writeFileSync(join(HOME, "config.json"), JSON.stringify({ kind: "contributions", me: ME, ...extra }, null, "\t"));
writeConfig();
process.env.GARY_HOME = root;

// ---------- settings ----------

check("the settings default to no automatic start, 5 waiting drafts and 800 lines", JSON.stringify(reviewDraftSettings({})) === JSON.stringify({ perRun: 0, maxPending: 5, maxLines: 800 }));
check("the settings are valid in a contributions config", validateConfig({ kind: "contributions", me: ME, maxAutoReviewDraftsPerRun: 2, maxPendingAutoReviewDrafts: 3, reviewDraftMaxLines: 400 }).length === 0);
const bad = validateConfig({ kind: "contributions", me: ME, maxAutoReviewDraftsPerRun: -1, maxPendingAutoReviewDrafts: 51, reviewDraftMaxLines: 0 });
check("out-of-range values are named", ["maxAutoReviewDraftsPerRun", "maxPendingAutoReviewDrafts", "reviewDraftMaxLines"].every((k) => bad.some((p) => p.startsWith(`"${k}"`))), bad);
check("the settings are unknown in a maintainer config", validateConfig({ profile: "p", me: ME, maxAutoReviewDraftsPerRun: 1 }).join() === 'unknown field "maxAutoReviewDraftsPerRun"');

// ---------- facts ----------

const facts = reviewDraftFacts({ additions: 30, deletions: 12, changedFiles: 3, reviewRequestEvents: { nodes: [
	{ createdAt: "2026-11-20T10:00:00Z", requestedReviewer: { login: ME } },
	{ createdAt: "2026-11-22T10:00:00Z", requestedReviewer: { login: "someone" } },
	{ createdAt: "2026-11-21T10:00:00Z", requestedReviewer: { login: ME.toUpperCase() } },
] } }, { me: ME, requested: true });
check("the facts count the changed lines and take the newest request of the maintainer", facts.changedLines === 42 && facts.changedFiles === 3 && facts.reviewRequestedAt === "2026-11-21T10:00:00Z", facts);
check("a request older than the events read is null", reviewDraftFacts({ reviewRequestEvents: { nodes: [] } }, { me: ME, requested: true }).reviewRequestedAt === null);
check("a PR that requests no review has no request time", !("reviewRequestedAt" in reviewDraftFacts({}, { me: ME, requested: false })));

// ---------- the decision ----------

const NOW = Date.parse("2026-11-24T12:00:00Z");
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const REQ = "2026-11-24T09:00:00.000Z";
const entry = (id, extra = {}) => ({ id, kind: "pr", repo: "other/lib", number: Number(id.split("-").pop()), author: "alice", githubState: "open", isDraft: false, headSha: "c".repeat(40), ...extra, facts: { reviewRequested: true, reviewRequestedAt: REQ, changedLines: 120, ...extra.facts } });
const on = { perRun: 2, maxPending: 3, maxLines: 800 };
const decide = (e, opts = {}) => draftDecision({ entry: e, record: null, started: 0, waiting: 0, settings: on, me: ME, ...opts });
check("a requested PR within the limits starts", decide(entry("other.lib.pr-1")).start === true && decide(entry("other.lib.pr-1")).request === REQ);
check("a PR that requests no review does not start and shows no button", (() => { const d = decide(entry("other.lib.pr-1", { facts: { reviewRequested: false } })); return d.start === false && d.hold === false; })());
check("the maintainer's own PR never gets a draft", decide(entry("other.lib.pr-1", { author: ME })).code === "own");
check("a draft PR waits", decide(entry("other.lib.pr-1", { isDraft: true })).code === "draft");
const off = decide(entry("other.lib.pr-1"), { settings: { ...on, perRun: 0 } });
check("with maxAutoReviewDraftsPerRun 0 nothing starts, and the card offers the click", off.code === "off" && off.hold === true && /maxAutoReviewDraftsPerRun is 0/.test(off.message), off);
const big = decide(entry("other.lib.pr-1", { facts: { changedLines: 1240 } }));
check("a PR over the size limit waits for a click and names both numbers", big.code === "size" && big.hold && /1,240 lines/.test(big.message) && /800/.test(big.message), big);
check("a PR of unknown size waits for a click", decide(entry("other.lib.pr-1", { facts: { changedLines: undefined } })).code === "size");
const full = decide(entry("other.lib.pr-1"), { waiting: 3 });
check("while maxPendingAutoReviewDrafts drafts wait, none starts by itself", full.code === "pending" && full.hold && /3 of 3/.test(full.message), full);
const runLimit = decide(entry("other.lib.pr-1"), { started: 2 });
check("a run starts at most maxAutoReviewDraftsPerRun drafts", runLimit.code === "run-limit" && runLimit.hold, runLimit);
const record = { starts: [{ at: iso(NOW - H), by: "auto", request: REQ }] };
check("one draft per PR and review request: new commits start none", decide(entry("other.lib.pr-1", { headSha: "d".repeat(40) }), { record }).code === "already");
check("a click for the same request also counts as its draft", decide(entry("other.lib.pr-1"), { record: { starts: [{ at: iso(NOW - H), by: "click", request: REQ }] } }).code === "already");
check("a re-request of the review may start a new one", decide(entry("other.lib.pr-1", { facts: { reviewRequestedAt: "2026-11-24T11:00:00.000Z" } }), { record }).start === true);

// ---------- waiting drafts ----------

const draftItem = (extra = {}) => ({ kind: "pr", reviewedAt: iso(NOW - H / 2), reviewedSha: "c".repeat(40), routes: [{ id: "r1", type: "review", as: "me", params: { pending: true, event: "approve" } }], ...extra });
const cur = entry("other.lib.pr-1");
check("an arrived draft waits for the maintainer", waitsForUser(record, { item: draftItem(), entry: cur, now: NOW }));
check("a draft on its way waits too", waitsForUser(record, { item: null, entry: cur, now: NOW }));
check("a draft that never arrived stops waiting", !waitsForUser(record, { item: null, entry: cur, now: NOW + 4 * H }));
check("the pending review or a prefill handles it", !waitsForUser(record, { item: draftItem({ handled: { at: iso(NOW - H / 4) } }), entry: cur, now: NOW }));
check("a snooze or a hide handles it", !waitsForUser(record, { item: draftItem({ snoozedUntil: iso(NOW + 24 * H) }), entry: cur, now: NOW }) && !waitsForUser(record, { item: draftItem({ hidden: true }), entry: cur, now: NOW }));
check("a dismissed draft route handles it", !waitsForUser(record, { item: draftItem({ routes: [] }), entry: cur, now: NOW }));
check("a closed PR frees the slot", !waitsForUser(record, { item: draftItem(), entry: { ...cur, githubState: "merged" }, now: NOW }) && !waitsForUser(record, { item: draftItem(), entry: undefined, now: NOW }));
check("a review request that went away frees the slot", !waitsForUser(record, { item: draftItem(), entry: entry("other.lib.pr-1", { facts: { reviewRequested: false } }), now: NOW }));
check("a draft the maintainer clicked never counts", !waitsForUser({ starts: [{ at: iso(NOW - H), by: "click", request: REQ }] }, { item: draftItem(), entry: cur, now: NOW }));

// ---------- planning across runs, with a fixed clock ----------

const settings = { perRun: 2, maxPending: 3, maxLines: 800 };
const run1 = await planDrafts({ changed: [entry("other.lib.pr-1"), entry("other.lib.pr-2"), entry("other.lib.pr-3"), entry("other.lib.pr-4", { facts: { changedLines: 5000 } })], settings, me: ME, now: NOW, instance: NAME });
check("a run starts at most perRun drafts and holds the rest with the reason", run1.start.map((s) => s.id).join() === "other.lib.pr-1,other.lib.pr-2" && run1.held.map((h) => `${h.id}:${h.code}`).join() === "other.lib.pr-3:run-limit,other.lib.pr-4:size", run1);
let stored = await readReviewDrafts(NAME);
check("every start and hold is recorded in the state file", stored["other.lib.pr-1"].starts[0].by === "auto" && stored["other.lib.pr-1"].starts[0].request === REQ && stored["other.lib.pr-4"].held.lines === 5000 && stored["other.lib.pr-4"].held.limit === 800, stored);
const entries = Object.fromEntries(["other.lib.pr-1", "other.lib.pr-2", "other.lib.pr-3", "other.lib.pr-4"].map((id) => [id, { repo: "other/lib", githubState: "open", isDraft: false, author: "alice", reviewRequested: true, reviewRequestedAt: REQ }]));
const items = { "other.lib.pr-1": draftItem({ reviewedAt: iso(NOW + H) }), "other.lib.pr-2": draftItem({ reviewedAt: iso(NOW + H) }) };
const run2 = await planDrafts({ changed: [entry("other.lib.pr-5")], entries, items, settings: { ...settings, maxPending: 2 }, me: ME, now: NOW + 2 * H, instance: NAME });
check("the next run counts the waiting drafts from the file, and the held one and the new one wait", run2.start.length === 0 && run2.held.map((h) => `${h.id}:${h.code}`).sort().join() === "other.lib.pr-3:pending,other.lib.pr-5:pending", run2);
check("the size hold is not retried without a change of its PR", !run2.held.some((h) => h.id === "other.lib.pr-4"));
const handledItems = { ...items, "other.lib.pr-1": draftItem({ reviewedAt: iso(NOW + H), handled: { at: iso(NOW + 2.5 * H) } }) };
const run3 = await planDrafts({ changed: [], entries: { ...entries, "other.lib.pr-5": entries["other.lib.pr-1"] }, items: handledItems, settings: { ...settings, maxPending: 2 }, me: ME, now: NOW + 3 * H, instance: NAME });
check("once the maintainer handled one, a held draft starts in a later run without a change of its PR", run3.start.map((s) => s.id).join() === "other.lib.pr-3" && run3.held.map((h) => h.id).join() === "other.lib.pr-5", run3);
stored = await readReviewDrafts(NAME);
check("the counts survive runs: two drafts wait now", countWaiting(stored, { items: handledItems, entries: { ...entries, "other.lib.pr-5": entries["other.lib.pr-1"] }, now: NOW + 3 * H }) === 2);
const run4 = await planDrafts({ changed: [entry("other.lib.pr-1", { headSha: "e".repeat(40) })], entries, items: handledItems, settings, me: ME, now: NOW + 4 * H, instance: NAME });
check("a new head without a new request starts nothing", run4.start.length === 0 && run4.skipped.some((s) => s.id === "other.lib.pr-1" && s.code === "already"), run4);

// ---------- what the board shows ----------

const snap = { headSha: "c".repeat(40), reviewRequested: true };
check("a held draft shows its reason and the button", (() => { const s = reviewDraftState({ kind: "pr" }, { held: { code: "size", message: "big", at: iso(NOW) }, starts: [] }, snap, NOW); return s.state === "held" && s.message === "big" && s.canPrepare === true; })());
check("a draft on its way shows no button", reviewDraftState({ kind: "pr" }, record, snap, NOW).state === "started" && reviewDraftState({ kind: "pr" }, record, snap, NOW).canPrepare === false);
check("a draft that did not arrive offers the click again", reviewDraftState({ kind: "pr" }, record, snap, NOW + 4 * H).canPrepare === true);
check("an arrived draft is ready", reviewDraftState(draftItem(), record, snap, NOW).state === "ready" && reviewDraftState(draftItem(), record, snap, NOW).canPrepare === false);
check("new commits after the draft offer it again", reviewDraftState(draftItem(), record, { ...snap, headSha: "f".repeat(40) }, NOW).canPrepare === true);

// ---------- the diff ----------

const patch = "@@ -10,3 +10,4 @@ fn\n a\n-b\n+c\n+d\n e\n@@ -40,2 +41,2 @@\n x\n+y";
const hunks = rightSideHunks(patch);
check("the right side of each hunk is known", [...hunks[0].lines].join() === "10,11,12,13" && [...hunks[1].lines].join() === "41,42", hunks.map((h) => [...h.lines]));
const files = new Map([["src/a.js", patch], ["logo.png", null]]);
check("a comment on a line of a hunk passes", commentLineProblem({ path: "src/a.js", line: 12 }, files) === null && commentLineProblem({ path: "src/a.js", startLine: 10, line: 13 }, files) === null);
check("a line outside the diff is refused", /not in the PR's diff/.test(commentLineProblem({ path: "src/a.js", line: 30 }, files)));
check("a range across two hunks is refused", /one hunk/.test(commentLineProblem({ path: "src/a.js", startLine: 12, line: 41 }, files)));
check("a file the PR does not change or without a diff is refused", /does not change/.test(commentLineProblem({ path: "x.js", line: 1 }, files)) && /no diff/.test(commentLineProblem({ path: "logo.png", line: 1 }, files)));
check("a diff link names the file's hash and the line", /\/pull\/5\/files#diff-[0-9a-f]{64}R12$/.test(diffUrl("https://github.com/other/lib/pull/5", "src/a.js", 12)) && /#diff-[0-9a-f]{64}$/.test(diffUrl("https://github.com/other/lib/pull/5#x", "src/a.js")));

// ---------- the item ----------

check("bot commands are found", botCommandIn("Looks good.\n/lgtm") === "/lgtm" && botCommandIn("ping @dependabot rebase") === "@dependabot" && botCommandIn("@renovate[bot] wait") === "@renovate[bot]" && botCommandIn("bors r+") === "bors r+" && botCommandIn("Use a/b paths and @alice") === null);
const HEAD = "c".repeat(40);
const walkthrough = {
	why: "The debug capture drops frames when the buffer fills, so `capture()` loses the end of long logs.",
	what: "The PR grows the buffer on demand and flushes it once per frame.",
	how: [{ text: "`Buffer.grow` doubles the size.", path: "src/a.js", line: 12 }, { text: "The test fills it twice.", path: "test/a.test.js" }],
};
const draft = (extra = {}, params = {}) => ({
	repo: "other/lib", kind: "pr", number: 5, title: "Fix the debug capture", url: "https://github.com/other/lib/pull/5", author: "alice", authorType: "contributor", category: "unblock",
	state: "Two changes before it is ready.", story: "s", reviewDepth: "full", reviewedSha: HEAD, reviewedAt: iso(NOW), effortMinutes: 5, priority: 1, hint: "Request changes: two comments", walkthrough,
	findings: [{ severity: "major", text: "The buffer never shrinks.", ref: "src/a.js:12" }],
	routes: [{ id: "r1", type: "review", as: "me", recommended: true, title: "Request changes: two comments", text: "Two things before this can go in.", why: "The buffer grows without a limit.",
		params: { pending: true, event: "request_changes", bodies: { request_changes: "Two things before this can go in.", approve: "Thanks, this works.", comment: "A few notes." },
			comments: [{ id: "c1", path: "src/a.js", line: 12, text: "This grows without a limit.", diffHunk: "@@ -10,3 +10,4 @@ fn\n a\n-b\n+c" }], ...params } }],
	...extra,
});
const v = (doc, kind = "contributions") => validateItem("other.lib.pr-5", doc, { mode: "none", profile: {}, repos: ["other/lib"], kind });
const codes = (doc, kind) => v(doc, kind).errors.map((e) => e.code);
check("a review draft with inline comments is valid on a contributions instance", v(draft()).errors.length === 0, v(draft()).errors);
check("without pending, a contributions review still carries no inline comments", codes(draft({}, { pending: undefined, bodies: undefined })).includes("contribution-comments"));
check("a pending review is refused on a maintainer instance", codes(draft(), "maintainer").includes("pending-kind"));
check("a draft needs its walkthrough and a full review of a head", ["pending-walkthrough", "pending-sha", "pending-depth"].every((c) => codes(draft({ walkthrough: undefined, reviewedSha: "abc", reviewDepth: "quick" })).includes(c)));
check("the body must be the one written for the suggested verdict", codes(draft({}, { bodies: { request_changes: "Other words." } })).includes("pending-bodies"));
check("a bot command in a comment is refused", codes(draft({}, { comments: [{ id: "c1", path: "src/a.js", line: 12, text: "/rebase please", diffHunk: "@@ -1 +1 @@" }] })).includes("pending-bot-command"));
check("a comment needs its diff hunk", codes(draft({}, { comments: [{ id: "c1", path: "src/a.js", line: 12, text: "x" }] })).includes("pending-hunk"));
const approve = draft({ findings: [], hint: "Approve: the fix is complete", routes: [{ id: "r1", type: "review", as: "me", recommended: true, title: "Approve: the fix is complete", text: "Thanks, this works.", why: "Checked the buffer paths and the new test. Nothing open.", params: { pending: true, event: "approve" } }] });
check("a draft without findings may suggest a plain approval", v(approve).errors.length === 0, v(approve).errors);
check("a walkthrough has three parts and steps with a file", codes(draft({ walkthrough: { why: "w", how: [] } })).includes("walkthrough") && codes(draft({ walkthrough: { ...walkthrough, how: [{ text: "x", path: "../etc" }] } })).includes("walkthrough"));
check("a maintainer item may carry a walkthrough", !codes({ ...draft({ routes: [], hint: undefined }), walkthrough }, "maintainer").includes("walkthrough"));
const served = servedWalkthrough(draft());
check("the served walkthrough links each step into the diff", served.how[0].url === diffUrl("https://github.com/other/lib/pull/5", "src/a.js", 12) && served.how[1].url.endsWith(diffUrl("x", "test/a.test.js").split("#")[1]));

// ---------- the CLI ----------

const cli = (args, extra = {}) => spawnSync(process.execPath, [GARY, "--instance", NAME, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
writeFileSync(join(T, "work.json"), JSON.stringify({ changed: [entry("other.lib.pr-9")] }));
let r = cli(["review-draft", "plan", "--snapshot", join(T, "work.json")]);
check("gary review-draft plan holds a draft with the default settings", r.status === 0 && JSON.parse(r.stdout).held[0]?.code === "off", r.stdout + r.stderr);
writeConfig({ maxAutoReviewDraftsPerRun: 1 });
writeFileSync(join(T, "work.json"), JSON.stringify({ changed: [entry("other.lib.pr-10")] }));
r = cli(["review-draft", "plan", "--snapshot", join(T, "work.json")]);
check("gary review-draft plan starts one with maxAutoReviewDraftsPerRun 1", r.status === 0 && JSON.parse(r.stdout).start[0]?.id === "other.lib.pr-10", r.stdout + r.stderr);
check("gary review-draft refuses a maintainer instance", spawnSync(process.execPath, [GARY, "--instance", "widgets", "review-draft", "list"], { env, encoding: "utf8" }).status === 3);
writeConfig();

// ---------- the server ----------

const ghData = join(T, "gh.json");
const ghWrites = join(T, "writes.jsonl");
writeFileSync(ghWrites, "");
const target = (extra = {}) => ({
	id: "PR_5", number: 5, state: "OPEN", isDraft: false, headRefOid: HEAD, url: "https://github.com/other/lib/pull/5", author: { login: "alice" },
	reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: ME } }] }, reviews: { nodes: [] },
	files: [{ filename: "src/a.js", patch }, { filename: "test/a.test.js", patch: "@@ -0,0 +1,2 @@\n+t\n+u" }], ...extra,
});
const setTarget = (extra) => writeFileSync(ghData, JSON.stringify({ searches: [], items: {}, reviewTargets: { "other/lib#5": target(extra), "other/lib#6": target({ id: "PR_6", number: 6, author: { login: ME } }) } }));
setTarget();
// The committed snapshot says which PRs request the maintainer's review
writeFileSync(join(STATE, "snapshot.json"), JSON.stringify({ items: {
	"other.lib.pr-5": { repo: "other/lib", githubState: "open", headSha: HEAD, reviewRequested: true, reviewRequestedAt: REQ, title: "t", author: "alice" },
	"other.lib.pr-6": { repo: "other/lib", githubState: "open", headSha: HEAD, reviewRequested: true, reviewRequestedAt: REQ, title: "t", author: ME },
	"other.lib.pr-7": { repo: "other/lib", githubState: "open", headSha: HEAD, reviewRequested: true, reviewRequestedAt: REQ, title: "t", author: "bob" },
	"other.lib.pr-8": { repo: "other/lib", githubState: "open", headSha: HEAD, title: "t", author: "bob" },
} }));
const writeItem = (id, doc) => writeFileSync(join(BOARD, "items", id + ".json"), JSON.stringify(doc));
const fresh = () => ({ ...draft(), reviewedAt: new Date().toISOString() });
writeItem("other.lib.pr-5", fresh());
writeItem("other.lib.pr-6", { ...fresh(), number: 6, url: "https://github.com/other/lib/pull/6", author: ME, authorType: "maintainer" });
writeItem("other.lib.pr-7", { ...fresh(), number: 7, url: "https://github.com/other/lib/pull/7", author: "bob", walkthrough: undefined, routes: [], hint: undefined });
writeItem("other.lib.pr-8", { ...fresh(), number: 8, url: "https://github.com/other/lib/pull/8", author: "bob" });
writeFileSync(join(STATE, "review-drafts.json"), JSON.stringify({ "other.lib.pr-7": { repo: "other/lib", number: 7, starts: [], held: { code: "size", message: "PR #7 changes 1,240 lines, more than the limit of 800 in reviewDraftMaxLines.", at: iso(NOW), request: REQ } } }));

const child = spawn(process.execPath, [join(ROOT, "server", "server.mjs"), "--port", String(PORT)], { env: { ...env, FAKE_GH_CONTRIBUTIONS: ghData, FAKE_GH_WRITES: ghWrites }, stdio: ["ignore", "ignore", "pipe"] });
process.on("exit", () => child.kill("SIGTERM"));
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await new Promise((res) => setTimeout(res, 100));
const TOKEN = readFileSync(join(root, "state", "server-token"), "utf8").trim();
async function api(path, body) {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: body ? "POST" : "GET", headers: { "X-Board-Token": TOKEN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, data: await res.json() };
}
const writes = () => readFileSync(ghWrites, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const actions = () => readdirSync(join(BOARD, "actions")).map((n) => JSON.parse(readFileSync(join(BOARD, "actions", n), "utf8")));
try {
	const state = async () => Object.fromEntries((await api("/api/state")).data.items.filter((i) => i.instance === NAME).map((i) => [i.id, i]));
	let items = await state();
	check("the served draft carries its walkthrough with diff links", items["other.lib.pr-5"].walkthrough?.how?.[0]?.url === diffUrl("https://github.com/other/lib/pull/5", "src/a.js", 12), items["other.lib.pr-5"].walkthrough);
	check("a held draft is served with its reason and the button", items["other.lib.pr-7"].reviewDraft?.state === "held" && /1,240 lines/.test(items["other.lib.pr-7"].reviewDraft.message) && items["other.lib.pr-7"].reviewDraft.canPrepare === true, items["other.lib.pr-7"].reviewDraft);
	const route = (id) => items[id].routes.find((x) => x.id === "r1");
	const pending = (id, extra = {}) => api("/api/action", { instance: NAME, action: "pending_review", itemId: id, routeId: "r1", draftHash: route(id).draftHash, text: route(id).text, input: { commentIds: ["c1"] }, ...extra });

	check("the user's own PR gets no pending review", /your own PR/.test((await pending("other.lib.pr-6")).data.result) && writes().length === 0);
	check("an item of a PR that requests no review is refused", /does not request your review/.test((await api("/api/action", { instance: NAME, action: "pending_review", itemId: "other.lib.pr-8", routeId: "r1", draftHash: "x" })).data.result));
	check("an item without a pending review route is refused", (await api("/api/action", { instance: NAME, action: "pending_review", itemId: "other.lib.pr-7", routeId: "r1", draftHash: "x" })).data.outdated === true);
	check("a stale draft hash is refused", (await pending("other.lib.pr-5", { draftHash: "0000" })).data.outdated === true);

	spawnSync(process.execPath, [GARY, "--instance", NAME, "pause"], { env, encoding: "utf8" });
	const paused = await pending("other.lib.pr-5");
	check("while paused, nothing is sent", paused.data.paused === true && writes().length === 0, paused.data);
	spawnSync(process.execPath, [GARY, "--instance", NAME, "resume"], { env, encoding: "utf8" });

	setTarget({ headRefOid: "d".repeat(40) });
	check("new commits since the draft refuse it", /new commits since the draft/.test((await pending("other.lib.pr-5")).data.result) && writes().length === 0);
	setTarget({ reviews: { nodes: [{ id: "PRR_1", url: "https://github.com/other/lib/pull/5#pullrequestreview-1", author: { login: ME } }] } });
	const existing = await pending("other.lib.pr-5");
	check("an existing pending review of the user is refused, and left as it is", existing.data.existing === true && /already have a pending review/.test(existing.data.result) && writes().length === 0, existing.data);
	setTarget({ files: [{ filename: "src/a.js", patch: "@@ -1,1 +1,1 @@\n-a\n+b" }] });
	check("a comment on a line outside the diff is refused", /not in the PR's diff/.test((await pending("other.lib.pr-5")).data.result) && writes().length === 0);
	setTarget({ reviewRequests: { nodes: [] } });
	check("a PR that no longer requests the review is refused", /does not request your review anymore/.test((await pending("other.lib.pr-5")).data.result) && writes().length === 0);

	setTarget();
	const edited = await pending("other.lib.pr-5", { text: "Thanks, this works.", input: { commentIds: ["c1"], commentTexts: { c1: "Cap the size, please." }, event: "approve" } });
	const sent = writes();
	check("the click creates one pending review", edited.data.ok === true && sent.length === 1 && sent[0].mutation === "addPullRequestReview" && sent[0].as === ME, [edited.data, sent]);
	const vars = sent[0]?.variables ?? {};
	check("it has no event, so it stays pending, and is pinned to the reviewed head", !("event" in vars) && vars.sha === HEAD && vars.id === "PR_5", vars);
	check("it carries the body and the edited comment on the right side", vars.body === "Thanks, this works." && vars.threads?.length === 1 && vars.threads[0].body === "Cap the size, please." && vars.threads[0].line === 12 && vars.threads[0].side === "RIGHT", vars);
	check("the answer names the verdict to pick and the files view", /"Approve"/.test(edited.data.result) && edited.data.url === "https://github.com/other/lib/pull/5/files", edited.data);
	const logged = actions().find((a) => a.action === "pending_review");
	check("the click is logged as done with its result", logged?.status === "done" && logged.params.event === "approve" && logged.routeId === "r1", logged);
	items = await state();
	check("the route is served as done, and a second click is refused", !!route("other.lib.pr-5").done && (await pending("other.lib.pr-5")).status === 409 && writes().length === 1);

	const prep = await api("/api/action", { instance: NAME, action: "prepare_review", itemId: "other.lib.pr-7" });
	const queued = actions().find((a) => a.action === "full_review" && a.itemId === "other.lib.pr-7");
	check("Prepare review queues the draft whatever the limits", prep.data.ok === true && queued?.status === "queued" && queued.params.by === "review_draft" && queued.params.number === 7, [prep.data, queued]);
	check("the click start is recorded, and the hold is gone", (await readReviewDrafts(NAME))["other.lib.pr-7"].starts.at(-1).by === "click" && (await readReviewDrafts(NAME))["other.lib.pr-7"].held === null);
	check("a second click while it runs is refused", (await api("/api/action", { instance: NAME, action: "prepare_review", itemId: "other.lib.pr-7" })).status === 409);
	check("Prepare review on the user's own PR is refused", /your own PR/.test((await api("/api/action", { instance: NAME, action: "prepare_review", itemId: "other.lib.pr-6" })).data.result));
	check("a maintainer instance takes neither", /contributions instance/.test((await api("/api/action", { instance: "widgets", action: "pending_review", itemId: "pr-1", routeId: "r1" })).data.result));
	check("every other route click stays read-only", (await api("/api/action", { instance: NAME, itemId: "other.lib.pr-5", routeId: "r1", draftHash: route("other.lib.pr-5").draftHash })).data.readOnly === true);
	check("only the pending review reached GitHub", writes().length === 1);
} finally {
	child.kill("SIGTERM");
	removeDir(T);
}
done();
