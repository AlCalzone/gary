// The decision log, dismiss_route, rule proposals and the pushing rule for contributor PRs, against a dry-run server.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, PROFILE, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("learning");
const T = tempDir();
// A writable copy of the fixture profile, as its own git repository
const profile = join(T, "profile");
cpSync(PROFILE, profile, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", profile, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" });
git("init", "-q");
git("add", "-A");
git("commit", "-q", "-m", "init");
writeFileSync(join(profile, "rules", "classification.md"), "# widgets: classification rules\n\n## Stale PRs\n\nOld rule.\n\n## Labels\n\nLabel rule.\n");
git("commit", "-q", "-am", "headings");

// The server's own port, so gary put writes through it
const port = await freePort();
const { home, env: baseEnv } = makeHome(T, { profile, port });
const env = { ...baseEnv, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
writeFileSync(join(home, "personal.md"), "# Personal rules\n");
const BOARD = join(home, "state", "board");
const reviewedAt = "2026-11-17T14:00:00Z";
const base = (kind, number, extra) => ({ kind, number, title: `Item ${number}`, url: `https://github.com/acme/widgets/${kind === "pr" ? "pull" : "issues"}/${number}`, author: "hubot", authorType: "contributor", section: "easy", priority: 1, effortMinutes: 5, reviewDepth: "full", state: "Decide.", reviewedAt, labels: ["bug"], ...extra });
const items = {
	"pr-12": base("pr", 12, {
		authorType: "maintainer", reviewedSha: "944d5aca1b70af1d87ca805b08639f3e17b83dcd", hint: "Reply: thanks",
		threads: [{ id: "PRRT_1", verdict: "valid", summary: "Restart the watchdog" }, { id: "PRRT_2", verdict: "wrong", summary: "Rename it" }],
		routes: [
			{ id: "r1", type: "reply", as: "bot", title: "Reply: thanks", text: "Thanks", recommended: true },
			{ id: "r2", type: "review", as: "bot", title: "Comment: two notes", text: "Notes", params: { event: "comment", comments: [{ id: "c1", path: "src/a.ts", line: 3, text: "Use const" }, { id: "c2", path: "src/b.ts", line: 9, text: "Rename" }] } },
			{ id: "r3", type: "address_review", as: "agent", title: "Fix: the threads", text: "" },
			{ id: "r4", type: "merge", as: "me", title: "Merge: ready", text: "Merging" },
		],
	}),
	"pr-14": base("pr", 14, {
		hint: "Take over: finish it",
		threads: [{ id: "PRRT_1", verdict: "valid", summary: "x" }],
		routes: [
			{ id: "r1", type: "take_over", as: "agent", title: "Take over: finish it", params: { mode: "push" }, text: "", recommended: true },
			{ id: "r2", type: "address_review", as: "agent", title: "Fix: threads", text: "" },
		],
	}),
	"issue-21": base("issue", 21, {
		hint: "Close: fixed",
		routes: [
			{ id: "r1", type: "close", as: "me", title: "Close: fixed", params: { reason: "completed" }, recommended: true },
			{ id: "r2", type: "reply", as: "me", title: "Reply: ask", text: "Can you check?" },
		],
		findings: [{ severity: "minor", text: "x", routeId: "r1" }],
	}),
	"issue-22": base("issue", 22, { hint: "Close: done", routes: [{ id: "r1", type: "close", as: "me", title: "Close: done", recommended: true }] }),
};
for (const [id, data] of Object.entries(items)) writeFileSync(join(BOARD, "items", id + ".json"), JSON.stringify(data));

const proposal = (id, extra) => ({ id, createdAt: "2026-11-18T08:00:00Z", title: "Close stale config PRs", why: "He closed three of them.", evidence: [{ at: "2026-11-17T10:00:00Z", itemId: "pr-12", type: "chose_alternative", gist: "close instead of reply" }], target: "profile", file: "rules/classification.md", heading: "## Stale PRs", text: "- Close config PRs after 30 days without reply.", status: "open", decidedAt: null, reason: "", ...extra });
const gary = (...args) => spawnSync(process.execPath, [GARY, ...args], { env, encoding: "utf8" });
const putFile = (name, data) => {
	const f = join(T, name);
	writeFileSync(f, JSON.stringify(data));
	return f;
};

// gary put proposals validates before the server starts
let r = gary("put", "proposals", "learn-2026-11-18-stale", putFile("p1.json", proposal("learn-2026-11-18-stale")));
t.check("put proposals writes a valid proposal", r.status === 0, r.stdout + r.stderr);
r = gary("put", "proposals", "learn-2026-11-18-personal", putFile("p2.json", proposal("learn-2026-11-18-personal", { target: "personal", file: "personal.md", heading: null, text: "Keep replies short." })));
t.check("put proposals writes a personal proposal", r.status === 0, r.stdout);
r = gary("put", "proposals", "learn-2026-11-18-drop", putFile("p3.json", proposal("learn-2026-11-18-drop", { file: "rules/review.md", heading: "" })));
t.check("put proposals writes a third one", r.status === 0, r.stdout);
r = gary("put", "proposals", "learn-2026-11-18-escape", putFile("p4.json", proposal("learn-2026-11-18-escape", { file: "../config.json" })));
t.check("put proposals refuses a path outside rules and templates", r.status === 1 && /rules\/<topic>.md/.test(r.stdout), r.stdout);
r = gary("put", "proposals", "Bad_Id", putFile("p5.json", proposal("Bad_Id")));
t.check("put proposals refuses a bad id", r.status === 1, r.stdout);
r = gary("put", "proposals", "learn-x", putFile("p6.json", proposal("learn-x", { title: "x".repeat(61), status: "maybe", evidence: "none" })));
t.check("put proposals lists every problem", r.status === 1 && /title/.test(r.stdout) && /status/.test(r.stdout) && /evidence/.test(r.stdout), r.stdout);
r = gary("put", "learn", putFile("l1.json", { reviewedUntil: "2026-11-18T08:00:00Z", lastLearnAt: "2026-11-18T08:05:00Z" }));
t.check("put learn writes the cursor", r.status === 0 && JSON.parse(readFileSync(join(home, "state", "learn.json"), "utf8")).lastLearnAt === "2026-11-18T08:05:00Z", r.stdout);
r = gary("put", "learn", putFile("l2.json", { reviewedUntil: "yesterday", other: 1 }));
t.check("put learn refuses bad fields", r.status === 1 && /reviewedUntil/.test(r.stdout) && /other/.test(r.stdout), r.stdout);

// A symlinked rules directory is refused on accept
const evil = join(T, "evil-profile");
cpSync(profile, evil, { recursive: true });

const stub = join(T, "stub.json");
writeFileSync(stub, JSON.stringify({ "*": { state: "OPEN" } }));
const server = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--port", String(port)], { env: { ...env, GARY_GUARD_STUB: stub }, stdio: ["ignore", "inherit", "pipe"] });
let stderr = "";
server.stderr.on("data", (d) => (stderr += d));
for (let i = 0; i < 50 && !stderr.includes("Board on"); i++) await sleep(100);
const token = readFileSync(join(home, "state", "server-token"), "utf8").trim();
const api = async (path, body) => {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? "POST" : "GET", headers: { "X-Board-Token": token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, data: await res.json() };
};
const state = async () => (await api("/api/state")).data;
const served = async (id) => (await state()).items.find((i) => i.id === id)?.data;
const hash = async (id, routeId) => (await served(id)).routes.find((r) => r.id === routeId).draftHash;
const click = async (id, routeId, extra = {}) => api("/api/action", { itemId: id, routeId, draftHash: await hash(id, routeId), ...extra });
const log = () => {
	try {
		return readFileSync(join(home, "state", "decisions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};
const logOf = (type) => log().filter((e) => e.type === type);
const actionDocs = () => readdirSync(join(BOARD, "actions")).map((n) => JSON.parse(readFileSync(join(BOARD, "actions", n), "utf8")));

try {
	// Pushing to a contributor PR is a take-over
	r = await click("pr-14", "r2", { input: { decisions: [{ threadId: "PRRT_1", decision: "fix" }] } });
	t.check("address_review on a contributor PR that is not taken over is refused", r.data.ok === false && /take_over/.test(r.data.result), r);
	r = await click("pr-14", "r1", { input: { decisions: [{ threadId: "PRRT_1", decision: "dismiss", note: "Not needed" }] } });
	t.check("take_over takes per-thread decisions", r.data.ok && r.data.queued, r);
	const to = actionDocs().find((a) => a.itemId === "pr-14" && a.action === "take_over");
	t.check("the take_over doc carries the decisions", to?.params?.mode === "push" && to.params.decisions?.[0]?.decision === "dismiss", to);
	r = await api("/api/action", { itemId: "pr-14", routeId: "r1", draftHash: await hash("pr-14", "r1"), input: { decisions: [{ threadId: "PRRT_9", decision: "fix" }] } });
	t.check("take_over decisions are checked against the threads", r.status === 409 || (r.data.ok === false), r);

	// Decision log entries from clicks
	await sleep(100);
	t.check("a take_over thread override is logged", logOf("thread_override").some((e) => e.itemId === "pr-14" && e.decision === "dismiss" && e.note === "Not needed" && e.thread.verdict === "valid"), log());
	r = await click("pr-12", "r2", { text: "Edited notes", input: { commentIds: ["c2"] } });
	t.check("a non-recommended review runs", r.data.ok, r);
	await sleep(100);
	t.check("chose_alternative is logged", logOf("chose_alternative").some((e) => e.itemId === "pr-12" && e.recommended.type === "reply" && e.chosen.type === "review"), log());
	t.check("edited_text is logged with draft and final", logOf("edited_text").some((e) => e.itemId === "pr-12" && e.draft === "Notes" && e.final === "Edited notes"), log());
	t.check("unchecked_comment is logged for the unchecked comment only", logOf("unchecked_comment").length === 1 && logOf("unchecked_comment")[0].comment.path === "src/a.ts", logOf("unchecked_comment"));
	t.check("every entry carries the item facts", log().every((e) => e.at && e.item && e.item.kind && Array.isArray(e.item.labels)), log());
	r = await click("pr-12", "r3", { text: "Keep it small", input: { decisions: [{ threadId: "PRRT_1", decision: "fix" }, { threadId: "PRRT_2", decision: "dismiss" }] } });
	t.check("address_review on a maintainer PR is queued", r.data.ok && r.data.queued, r);
	await sleep(100);
	t.check("an agent route's instruction is an agent_note", logOf("agent_note").some((e) => e.text === "Keep it small"), log());
	t.check("decisions that follow the verdicts are not logged", !logOf("thread_override").some((e) => e.itemId === "pr-12"), logOf("thread_override"));

	// Routes he does himself report to /api/decision
	const before = actionDocs().length;
	r = await api("/api/decision", { itemId: "issue-21", routeId: "r2", text: "Can you check again?" });
	t.check("/api/decision answers ok", r.data.ok, r);
	await sleep(50);
	t.check("/api/decision logs the alternative and the edit", logOf("chose_alternative").some((e) => e.itemId === "issue-21" && e.chosen.type === "reply") && logOf("edited_text").some((e) => e.itemId === "issue-21" && e.final === "Can you check again?"), log());
	t.check("/api/decision writes no action doc", actionDocs().length === before);
	r = await api("/api/decision", { itemId: "issue-21", routeId: "r9" });
	t.check("/api/decision with an unknown route is outdated", r.data.outdated === true, r);

	// Snooze, hide and Analyze again from the page
	await api("/api/db", { op: "update", path: "items/issue-22", data: { snoozedUntil: new Date(Date.now() + 3 * 86400000).toISOString() } });
	await api("/api/db", { op: "update", path: "items/issue-21", data: { hidden: true } });
	await api("/api/db", { op: "set", path: "actions/issue-22-1", data: { itemId: "issue-22", action: "reanalyze", text: "Look at the logs again", status: "queued", via: "queue", createdAt: new Date().toISOString() } });
	await sleep(100);
	t.check("snooze is logged with days", logOf("snoozed").some((e) => e.itemId === "issue-22" && e.days === 3), logOf("snoozed"));
	t.check("hide is logged as untilActivity", logOf("snoozed").some((e) => e.itemId === "issue-21" && e.untilActivity === true), logOf("snoozed"));
	t.check("Analyze again with a note is an agent_note", logOf("agent_note").some((e) => e.itemId === "issue-22" && e.text === "Look at the logs again"), logOf("agent_note"));

	// dismiss_route
	r = await api("/api/action", { action: "dismiss_route", itemId: "issue-21", routeId: "r1", text: "x".repeat(501) });
	t.check("a reason over 500 characters is refused", r.status === 400, r);
	r = await api("/api/action", { action: "dismiss_route", itemId: "issue-21", routeId: "r1", text: "Not fixed for him" });
	t.check("dismiss_route answers ok", r.data.ok && r.data.reanalyze === false, r);
	let item = JSON.parse(readFileSync(join(BOARD, "items", "issue-21.json"), "utf8"));
	t.check("the route is gone and the next one is recommended", item.routes.length === 1 && item.routes[0].id === "r2" && item.routes[0].recommended === true && item.hint === "Reply: ask", item);
	t.check("dismissedRoutes remembers it", item.dismissedRoutes?.[0]?.type === "close" && item.dismissedRoutes[0].reason === "Not fixed for him" && !!item.dismissedRoutes[0].at, item.dismissedRoutes);
	t.check("findings pointing to it lose the routeId", item.findings[0].routeId === undefined, item.findings);
	t.check("the dismissal is a done board action doc", actionDocs().some((a) => a.itemId === "issue-21" && a.action === "dismiss_route" && a.status === "done" && a.via === "board"), actionDocs());
	t.check("the dismissal is in the decision log", logOf("dismissed_route").some((e) => e.itemId === "issue-21" && e.wasRecommended === true && e.reason === "Not fixed for him"), log());
	r = await api("/api/action", { action: "dismiss_route", itemId: "issue-22", routeId: "r1" });
	item = JSON.parse(readFileSync(join(BOARD, "items", "issue-22.json"), "utf8"));
	t.check("dismissing the last route leaves no routes and no hint", r.data.reanalyze === true && item.routes.length === 0 && item.hint === undefined, item);
	t.check("then a reanalyze request is queued with the reason", actionDocs().some((a) => a.itemId === "issue-22" && a.action === "reanalyze" && a.status === "queued" && /close route "Close: done"/.test(a.text) && /none given/.test(a.text)), actionDocs().filter((a) => a.itemId === "issue-22"));
	r = await api("/api/action", { action: "dismiss_route", itemId: "issue-21", routeId: "r1" });
	t.check("dismissing a route that is gone is outdated", r.data.outdated === true, r);

	// Replace keeps dismissedRoutes, and the validator refuses the dismissed type
	const doc = { ...items["issue-21"], routes: [{ id: "r1", type: "reply", as: "me", title: "Reply: ask", text: "?", recommended: true }], hint: "Reply: ask", findings: [] };
	r = gary("put", "items", "issue-21", putFile("i21.json", doc));
	item = JSON.parse(readFileSync(join(BOARD, "items", "issue-21.json"), "utf8"));
	t.check("a replace keeps dismissedRoutes", r.status === 0 && item.dismissedRoutes?.length === 1, r.stdout + r.stderr);
	r = gary("put", "items", "issue-21", putFile("i21b.json", { ...doc, routes: [{ id: "r1", type: "close", as: "me", title: "Close: fixed", recommended: true }], hint: "Close: fixed" }));
	t.check("a doc that brings back a dismissed type is refused with the reason", r.status === 1 && /dismissed the close route/.test(r.stdout) && /Not fixed for him/.test(r.stdout), r.stdout);

	// Proposals on the board
	const st = await state();
	t.check("/api/state serves the open proposals", st.proposals.length === 3 && st.proposals.every((p) => p.data.status === "open"), st.proposals);
	r = await api("/api/action", { action: "accept_proposal", proposalId: "learn-2026-11-18-stale", text: "- Close config PRs after 45 days without reply." });
	t.check("accept_proposal answers ok and commits", r.data.ok && r.data.committed === true, r);
	const rules = readFileSync(join(profile, "rules", "classification.md"), "utf8");
	t.check("the edited rule lands under its heading", /## Stale PRs\n\nOld rule\.\n\n- Close config PRs after 45 days without reply\.\n\n## Labels/.test(rules), rules);
	t.check("the profile repo has one new commit for that file", git("log", "-1", "--format=%s").trim() === "Add rule: Close stale config PRs" && git("show", "--name-only", "--format=", "HEAD").trim() === "rules/classification.md", git("log", "--oneline"));
	const accepted = JSON.parse(readFileSync(join(BOARD, "proposals", "learn-2026-11-18-stale.json"), "utf8"));
	t.check("the proposal is accepted with the final text", accepted.status === "accepted" && !!accepted.decidedAt && /45 days/.test(accepted.text), accepted);
	r = await api("/api/action", { action: "accept_proposal", proposalId: "learn-2026-11-18-stale" });
	t.check("a decided proposal cannot be decided again", r.status === 409, r);
	r = await api("/api/action", { action: "accept_proposal", proposalId: "learn-2026-11-18-personal" });
	t.check("a personal proposal appends to personal.md", r.data.ok && r.data.committed === false && readFileSync(join(home, "personal.md"), "utf8") === "# Personal rules\n\nKeep replies short.\n", r);
	r = await api("/api/action", { action: "dismiss_proposal", proposalId: "learn-2026-11-18-drop", text: "We review those by hand" });
	const dropped = JSON.parse(readFileSync(join(BOARD, "proposals", "learn-2026-11-18-drop.json"), "utf8"));
	t.check("dismiss_proposal stores the reason", r.data.ok && dropped.status === "dismissed" && dropped.reason === "We review those by hand", dropped);
	await sleep(50);
	t.check("dismiss_proposal is in the decision log", logOf("dismissed_proposal").some((e) => e.proposal.id === "learn-2026-11-18-drop" && e.reason === "We review those by hand"), log());
	t.check("no open proposals are left on the board", (await state()).proposals.length === 0);
	r = await api("/api/action", { action: "accept_proposal", proposalId: "../x" });
	t.check("a bad proposal id is refused", r.status === 400, r);
} finally {
	server.kill("SIGTERM");
}

// A profile whose rules directory is a symlink elsewhere
removeDir(join(evil, "rules"));
mkdirSync(join(T, "elsewhere"));
symlinkSync(join(T, "elsewhere"), join(evil, "rules"));
const evilHome = makeHome(join(T, "evil"), { profile: evil });
mkdirSync(join(evilHome.home, "state", "board", "proposals"), { recursive: true });
writeFileSync(join(evilHome.home, "state", "board", "proposals", "learn-evil.json"), JSON.stringify(proposal("learn-evil")));
const port2 = await freePort();
const server2 = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--port", String(port2)], { env: evilHome.env, stdio: ["ignore", "inherit", "pipe"] });
let err2 = "";
server2.stderr.on("data", (d) => (err2 += d));
for (let i = 0; i < 50 && !err2.includes("Board on"); i++) await sleep(100);
try {
	const token2 = readFileSync(join(evilHome.home, "state", "server-token"), "utf8").trim();
	const res = await fetch(`http://127.0.0.1:${port2}/api/action`, { method: "POST", headers: { "X-Board-Token": token2, "Content-Type": "application/json" }, body: JSON.stringify({ action: "accept_proposal", proposalId: "learn-evil" }) });
	const body = await res.json();
	t.check("accept refuses a rules directory that leads elsewhere", body.ok === false && /leads elsewhere/.test(body.result), body);
	t.check("nothing was written there", readdirSync(join(T, "elsewhere")).length === 0);
} finally {
	server2.kill("SIGTERM");
}

// gary decisions and gary proposals
const all = JSON.parse(gary("decisions", "--json").stdout);
t.check("gary decisions --json prints every entry", all.length === log().length && all.length > 5, all.length);
const mid = all[Math.floor(all.length / 2)].at;
const later = JSON.parse(gary("decisions", "--since", mid, "--json").stdout);
t.check("--since is exclusive", later.every((e) => e.at > mid) && later.length === all.filter((e) => e.at > mid).length, { mid, n: later.length });
r = gary("decisions");
t.check("gary decisions prints a line per entry", r.status === 0 && new RegExp(`${all.length} entries`).test(r.stdout), r.stdout.slice(-200));
t.check("gary decisions refuses a bad --since", gary("decisions", "--since", "soon").status === 1);
const props = JSON.parse(gary("proposals", "--json").stdout);
t.check("gary proposals lists all, also decided ones", props.length === 3 && props.some((p) => p.status === "dismissed" && p.reason === "We review those by hand") && props.some((p) => p.status === "accepted"), props.map((p) => p.status));
r = gary("proposals");
t.check("gary proposals shows status and reason", /dismissed .*\(We review those by hand\)/.test(r.stdout), r.stdout);

await sleep(200);
removeDir(T);
t.done();
