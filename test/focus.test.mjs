// Focus: the focus record and `gary focus`, the hold on workers, rounds, pushes, item writes and the queue, the
// paused and ended transitions, the briefing, and what the board server serves and accepts. Runs offline against the fake gh.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { BOT } from "./fixtures/github.mjs";

const t = runner("focus");
const T = tempDir();
const port = await freePort();
const { home, root, env: baseEnv } = makeHome(T, { port });
const OVERRIDES = join(T, "overrides.json");
writeFileSync(OVERRIDES, "{}");
const WRITES = join(T, "gh-writes.jsonl");
const env = { ...baseEnv, FAKE_GH_OVERRIDES: OVERRIDES, FAKE_GH_WRITES: WRITES };
process.env.GARY_HOME = root;
const state = join(home, "state");
const actionsDir = join(state, "board", "actions");
const itemsDir = join(state, "board", "items");
const focusDir = join(state, "focus");
const gary = (...args) => spawnSync(process.execPath, [GARY, ...args], { env, encoding: "utf8" });
const json = (r) => {
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { unparsed: r.stdout + r.stderr };
	}
};
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const record = (id) => (existsSync(join(focusDir, id + ".json")) ? read(join(focusDir, id + ".json")) : null);
const actions = () => readdirSync(actionsDir).filter((n) => n.endsWith(".json")).map((n) => ({ id: n.slice(0, -5), ...read(join(actionsDir, n)) }));
const clearActions = () => {
	for (const n of readdirSync(actionsDir)) rmSync(join(actionsDir, n));
};
const lines = (r) => r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const file = (name, data) => {
	const f = join(T, name);
	writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data));
	return f;
};
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const writeRecord = (id, r) => {
	mkdirSync(focusDir, { recursive: true });
	writeFileSync(join(focusDir, id + ".json"), JSON.stringify(r));
};
const queue = (id, doc) => writeFileSync(join(actionsDir, id + ".json"), JSON.stringify({ status: "queued", via: "queue", createdAt: new Date().toISOString(), finishedAt: null, result: "", text: "", params: {}, ...doc }));

const URL = "https://github.com/acme/widgets";
const item = (kind, number, extra = {}) => ({
	kind, repo: "acme/widgets", number, title: `${kind} ${number}`, url: `${URL}/${kind === "pr" ? "pull" : "issues"}/${number}`, author: "hubot", authorType: "contributor",
	category: "land", priority: 1, effortMinutes: 5, reviewDepth: "full", state: "The fix waits for your review.", story: "Hubot fixed the LED.", hint: "Review",
	findings: [{ id: "f1", severity: "major", text: "The timeout is never cleared.", ref: "src/led.ts:12" }],
	routes: [{ id: "r1", type: "review", as: "me", title: "Review: ask for the cleared timeout", text: "Please clear the timeout.", recommended: true }, { id: "r2", type: "revise", as: "agent", title: "Change: clear the timeout", text: "Clear it." }],
	...extra,
});
writeFileSync(join(itemsDir, "pr-12.json"), JSON.stringify(item("pr", 12)));
writeFileSync(join(itemsDir, "issue-22.json"), JSON.stringify(item("issue", 22, { routes: [{ id: "r1", type: "follow_up", as: "agent", title: "Start fix: watchdog", text: "Fix it." }] })));

const lib = await import("../scripts/lib/focus.mjs");
const brief = await import("../scripts/lib/focus-brief.mjs");

// ---------- the record ----------
queue("pr-12-focus", { itemId: "pr-12", action: "focus" });
let r = gary("focus", "start", "pr-12", "--harness", "t3code", "--session", "thread-1", "--link", "t3-thread://v2/env/thread-1", "--title", "Focus: PR 12", "--request", "pr-12-focus");
let rec = record("pr-12");
t.check("start writes an active record with the session, its link and the times", r.status === 0 && rec?.status === "active" && rec.harness === "t3code" && rec.session.id === "thread-1" && rec.session.link === "t3-thread://v2/env/thread-1" && rec.how === "started" && rec.startedAt === rec.lastActivity && rec.requestId === "pr-12-focus", [r.stdout, rec]);
const req = read(join(actionsDir, "pr-12-focus.json"));
t.check("start settles the focus request as done and names the session", req.status === "done" && /Focus: PR 12/.test(req.result) && typeof req.finishedAt === "string", req);
r = gary("focus", "start", "pr-12", "--harness", "t3code", "--session", "thread-1");
t.check("the same session again keeps the start and the link", r.status === 0 && record("pr-12").startedAt === rec.startedAt && record("pr-12").session.link === rec.session.link, r.stdout);
r = gary("focus", "start", "pr-12", "--harness", "t3code", "--session", "thread-2");
t.check("another session while one holds the item is refused with exit 3", r.status === 3 && /already in focus/.test(json(r).result) && record("pr-12").session.id === "thread-1", r.stdout);
r = gary("focus", "start", "issue-22", "--harness", "t3code", "--session", "s", "--attach");
t.check("attach needs the verified match", r.status === 1 && /--match/.test(json(r).result), r.stdout);
r = gary("focus", "start", "issue-22", "--harness", "t3code", "--session", "s", "--link", "javascript:alert(1)");
t.check("a link outside https, t3-thread and claude is refused", r.status === 1 && /--link/.test(json(r).result) && !record("issue-22"), r.stdout);
queue("issue-22-focus", { itemId: "issue-22", action: "focus" });
r = gary("focus", "fail", "issue-22", "--request", "issue-22-focus", "--reason", "This master runs in Claude Code and cannot start a session.");
t.check("fail marks the focus request failed with the reason", r.status === 0 && read(join(actionsDir, "issue-22-focus.json")).status === "failed" && /cannot start/.test(read(join(actionsDir, "issue-22-focus.json")).result) && !record("issue-22"), r.stdout);
r = gary("focus", "list", "--json");
t.check("list prints the records", r.status === 0 && json(r).records?.["pr-12"]?.status === "active", r.stdout);

// ---------- the hold ----------
r = gary("claim", "pr-12", "review", "--run", "run-1");
t.check("a review claim is refused while focus holds the item", r.status === 3 && /in focus in Focus: PR 12/.test(json(r).error) && json(r).focus?.status === "active", r.stdout);
r = gary("claim", "pr-12", "push", "--run", "run-1");
t.check("a push claim is refused too", r.status === 3, r.stdout);
r = gary("claim", "issue-22", "fix", "--run", "run-1");
t.check("an item without focus is claimed as usual", r.status === 0, r.stdout);
gary("release", "issue-22", "fix", "--run", "run-1");

const base = item("pr", 12);
r = gary("put", "items", "pr-12", file("full.json", { ...base, state: "Something new." }));
t.check("a full item write is refused with exit 3", r.status === 3 && json(r).refused === true && read(join(itemsDir, "pr-12.json")).state === base.state, r.stdout);
r = gary("put", "--merge", "items", "pr-12", file("facts.json", { ci: "failing", labels: ["bug"], priority: 3 }));
t.check("a merge of facts from GitHub goes through", r.status === 0 && read(join(itemsDir, "pr-12.json")).ci === "failing" && read(join(itemsDir, "pr-12.json")).priority === 3, r.stdout + r.stderr);
r = gary("put", "--merge", "items", "pr-12", file("routes.json", { state: "New analysis." }));
t.check("a merge of the analysis is refused and names the field", r.status === 3 && /state is none/.test(json(r).error), r.stdout);

r = gary("action", "--autonomous", file("label.json", { itemId: "pr-12", action: "label", params: { add: ["bug"] } }));
t.check("an autonomous label is refused with exit 3", r.status === 3 && json(r).refused === true, r.stdout);

r = gary("push-check", "--pr", "12");
t.check("push-check refuses every other session", r.status === 3 && /in focus/.test(json(r).refused), r.stdout);
r = gary("push-check", "--pr", "12", "--focus-session", "thread-1");
t.check("push-check lets the focus session through to the usual checks", json(r).focus === undefined && json(r).pr === 12, r.stdout + r.stderr);

// pr-watch round and review on a bot PR in focus
writeFileSync(join(itemsDir, "pr-19.json"), JSON.stringify({ ...item("pr", 19), author: BOT, authorType: "bot" }));
writeFileSync(join(state, "snapshot.json"), JSON.stringify({ items: { "pr-19": { kind: "pr", author: BOT, headSha: "9".repeat(40), feedback: { ourLastCommitAt: ago(600), lastMeAt: ago(60), lastMeKind: "review" } } } }));
gary("focus", "start", "pr-19", "--harness", "t3code", "--session", "thread-19");
r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", ago(60));
const held = existsSync(join(state, "drive", "pr-19.json")) ? read(join(state, "drive", "pr-19.json")).held : null;
t.check("round refuses his feedback with exit 3 and records it as held by the focus", r.status === 3 && /in focus/.test(json(r).result) && held?.focus === true && held.session === "thread-19" && held.by === "me", [r.stdout, held]);
r = gary("pr-watch", "review", "--pr", "19", "--sha", "9".repeat(40), "--action", "x");
t.check("review refuses a review bot round with exit 3", r.status === 3 && /in focus/.test(json(r).result), r.stdout);

// ---------- the queue ----------
clearActions();
queue("pr-12-reanalyze", { itemId: "pr-12", action: "reanalyze", createdAt: ago(3) });
queue("pr-12-focus2", { itemId: "pr-12", action: "focus", createdAt: ago(2) });
queue("issue-22-start", { itemId: "issue-22", action: "start_fix", createdAt: ago(1) });
r = gary("watch-queue", "--once");
let printed = lines(r).filter((l) => !l.event).map((l) => l.id);
t.check("the queue holds back requests on an item in focus and prints focus requests and other items", JSON.stringify(printed) === JSON.stringify(["pr-12-focus2", "issue-22-start"]), r.stdout + r.stderr);
t.check("a focus with recent activity gets no check line", !lines(r).some((l) => l.event === "check"), r.stdout);
writeRecord("pr-12", { ...record("pr-12"), lastActivity: ago(31) });
r = gary("watch-queue", "--once");
const check = lines(r).find((l) => l.event === "check");
t.check("after 30 quiet minutes the master gets a check line with the harness and the session", check?.itemId === "pr-12" && check.action === "focus" && check.harness === "t3code" && check.session === "thread-1" && check.status === "active", r.stdout);

// ---------- paused and ended ----------
r = gary("focus", "check", "pr-12");
t.check("a check without new activity after 30 quiet minutes pauses the focus", r.status === 0 && json(r).status === "paused" && json(r).changed === true && typeof record("pr-12").pausedAt === "string", r.stdout);
r = gary("claim", "pr-12", "review", "--run", "run-1");
t.check("a paused focus still holds the item, and the refusal says how to end it", r.status === 3 && /paused/.test(json(r).error), r.stdout);
r = gary("watch-queue", "--once");
t.check("a paused focus gets a check line too, so an archived session is seen", lines(r).some((l) => l.event === "check" && l.status === "paused"), r.stdout);
r = gary("focus", "check", "pr-12", "--activity", new Date().toISOString());
t.check("new activity after the pause makes the focus active again", json(r).status === "active" && !("pausedAt" in record("pr-12")), r.stdout);
r = gary("focus", "check", "pr-12", "--activity", "yesterday");
t.check("check refuses an activity that is no time", r.status === 1, r.stdout);

clearActions();
r = gary("focus", "check", "pr-12", "--archived");
rec = record("pr-12");
let next = actions().find((a) => a.id === json(r).actionId);
t.check("an archived session ends the focus", json(r).status === "ended" && rec.endedBy === "archived" && typeof rec.endedAt === "string", [r.stdout, rec]);
t.check("the end queues a fresh analysis with a note that names no summary", next?.action === "reanalyze" && next.status === "queued" && next.params.by === "focus" && next.params.focus.endedBy === "archived" && /archived/.test(next.text) && /no closing summary/.test(next.text), next);
r = gary("claim", "pr-12", "review", "--run", "run-1");
t.check("after the end the item can be claimed again", r.status === 0, r.stdout);
gary("release", "pr-12", "review", "--run", "run-1");
r = gary("watch-queue", "--once");
t.check("the queued analysis prints once the focus ended", lines(r).some((l) => l.id === next.id && l.action === "reanalyze"), r.stdout);

// done through the master's message file
clearActions();
gary("focus", "start", "pr-12", "--harness", "t3code", "--session", "thread-3");
const summary = "He asked for the cleared timeout in a review. The contributor agreed. Left open: the test for the restore path.";
const message = ["Some text before.", "Gary focus done", "instance: widgets", "item: pr-12", "session: thread-3", "summary:", summary].join("\n");
r = gary("focus", "done", "--message-file", file("wrong.txt", message.replace("session: thread-3", "session: thread-9")));
t.check("done refuses a message from another session", r.status === 1 && /not in thread-9/.test(json(r).result) && record("pr-12").status === "active", r.stdout);
r = gary("focus", "done", "--message-file", file("done.txt", message));
rec = record("pr-12");
next = actions().find((a) => a.id === json(r).actionId);
t.check("done ends the focus with the closing summary", r.status === 0 && rec.status === "ended" && rec.endedBy === "done" && rec.summary === summary, [r.stdout, rec]);
t.check("the fresh analysis gets the summary as its note", next?.action === "reanalyze" && next.text.includes(summary) && /reported that the maintainer is done/.test(next.text), next);
r = gary("focus", "done", "pr-12", "--session", "thread-3", "--summary-file", file("s.txt", "again"));
t.check("done on an item out of focus is refused with exit 3", r.status === 3, r.stdout);
r = gary("focus", "end", "pr-12");
t.check("end on an item out of focus is refused with exit 3", r.status === 3, r.stdout);

// ---------- transitions as pure functions ----------
const NOW = Date.parse("2026-11-20T12:00:00Z");
const active = { itemId: "pr-1", status: "active", startedAt: "2026-11-20T10:00:00Z", lastActivity: "2026-11-20T11:40:00Z", session: { id: "s" } };
let c = lib.checkedRecord(active, { now: NOW });
t.check("20 quiet minutes keep the focus active", c.record.status === "active" && !c.ended);
c = lib.checkedRecord(active, { activityAt: "2026-11-20T11:25:00Z", now: NOW + 10 * 60000 });
t.check("an older activity never moves the last activity back", c.record.status === "paused" && c.record.lastActivity === active.lastActivity, c.record);
c = lib.checkedRecord({ ...active, status: "paused", pausedAt: "2026-11-20T11:50:00Z" }, { activityAt: "2026-11-20T11:45:00Z", now: NOW });
t.check("activity from before the pause keeps it paused", c.record.status === "paused");
c = lib.checkedRecord({ ...active, status: "ended" }, { now: NOW });
t.check("an ended record does not change", c.changed === false && c.record.status === "ended");
t.check("checkDue asks for a look after 30 quiet minutes, and every 30 minutes while paused", lib.checkDue(active, NOW) === null && lib.checkDue(active, NOW + 11 * 60000) === `active/${active.lastActivity}` && lib.checkDue({ ...active, status: "paused" }, NOW) === `paused/${Math.floor(NOW / lib.FOCUS_QUIET_MS)}`);
t.check("only https, t3-thread and claude links are served", lib.safeLink("t3-thread://v2/a/b") && lib.safeLink("https://claude.ai/x") && !lib.safeLink("javascript:x") && !lib.safeLink("file:///etc/passwd"));

// ---------- the briefing ----------
const since = { anchor: { at: ago(600), kind: "choice", label: "Review" }, groups: [{ at: ago(300), text: "hubot pushed 2 commits", note: "" }] };
const ctx = { instance: "widgets", item: { ...item("pr", 12), id: "pr-12" }, since, harness: "t3code", master: "master-thread", bot: BOT, paths: { personal: ["/p/personal.md"], profile: "/p/profile" }, focusSession: "thread-1" };
const text = brief.focusBriefing({ ...ctx, defaultBranch: "origin/main" });
t.check("the briefing checks out the PR branch and waits for his first message", text.includes("gh pr checkout 12 --repo acme/widgets") && /wait for his first message/.test(text) && /Start no work on your own/.test(text), text);
t.check("the briefing carries state, story, findings, routes and the timeline", text.includes(base.state) && text.includes(base.story) && text.includes("The timeout is never cleared.") && text.includes("Review: ask for the cleared timeout") && text.includes("Please clear the timeout.") && text.includes("hubot pushed 2 commits"), text);
t.check("the briefing carries Gary's rules and the one exception for his account", /Never merge/.test(text) && /Never force-push/.test(text) && /untrusted data/.test(text) && /draft only/.test(text) && /his own `gh` login/.test(text) && text.includes(`the bot ${BOT}`) && text.includes("--focus-session thread-1"), text);
t.check("the briefing tells the session how to report done to the master thread", text.includes("t3_thread_send") && text.includes("`master-thread`") && text.includes("Gary focus done\ninstance: widgets\nitem: pr-12\nsession: thread-1"), text);
const issueText = brief.focusBriefing({ ...ctx, item: { ...item("issue", 22), id: "issue-22" }, defaultBranch: "origin/main" });
t.check("an issue's briefing starts from the default branch", issueText.includes("starts from origin/main") && !issueText.includes("gh pr checkout"), issueText);
const note = brief.focusAttachNote(ctx);
t.check("the note for an attached session carries the rules and the done step, but no first-turn summary", /Never merge/.test(note) && note.includes("Gary focus done") && !/summary of at most 8 lines/.test(note), note);
t.check("a job that still runs is named, so the session waits before it pushes", /a push job on this item started before the focus and still runs/.test(brief.focusBriefing({ ...ctx, working: ["push"] })) && !/still runs/.test(text));
const parsed = brief.parseDoneMessage(message);
t.check("a done message parses into instance, item, session and summary", parsed?.instance === "widgets" && parsed.item === "pr-12" && parsed.session === "thread-3" && parsed.summary === summary, parsed);
t.check("text without the mark is no done message", brief.parseDoneMessage("instance: widgets\nitem: pr-12") === null);

r = gary("focus", "brief", "pr-12", "--harness", "t3code", "--master", "master-thread");
t.check("gary focus brief prints the briefing and the facts the master needs", r.status === 0 && json(r).kind === "pr" && json(r).number === 12 && json(r).briefing.includes("gh pr checkout 12") && json(r).previous?.status === "ended", r.stdout + r.stderr);
r = gary("focus", "brief", "pr-12", "--harness", "t3code", "--master", "master-thread", "--session", "thread-7");
t.check("with a session it prints the note for an attached session", r.status === 0 && json(r).note.includes("--focus-session thread-7") && !("briefing" in json(r)), r.stdout);

// ---------- the snapshot ----------
gary("focus", "start", "pr-12", "--harness", "t3code", "--session", "thread-4");
r = gary("snapshot");
const snap = json(r);
t.check("the snapshot lists a changed item in focus apart from changed", r.status === 0 && snap.focus?.some((c) => c.id === "pr-12") && !snap.changed.some((c) => c.id === "pr-12") && snap.changed.length > 0, (r.stdout + r.stderr).slice(0, 400));

// ---------- the board server ----------
clearActions();
const child = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
try {
	for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await sleep(100);
	const token = readFileSync(join(root, "state", "server-token"), "utf8").trim();
	const headers = { "X-Board-Token": token, "Content-Type": "application/json" };
	const items = async () => (await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers })).json()).items ?? [];
	const served = async (id) => (await items()).find((i) => i.id === id);
	const post = async (body) => (await fetch(`http://127.0.0.1:${port}/api/action`, { method: "POST", headers, body: JSON.stringify({ instance: "widgets", ...body }) })).json();

	let f = (await served("pr-12"))?.focus;
	t.check("the server serves the held focus with the session and its link", f?.status === "active" && f.session.id === "thread-4" && f.harness === "t3code" && f.how === "started" && typeof f.startedAt === "string", f ?? stderr);
	writeRecord("pr-12", { ...record("pr-12"), session: { id: "thread-4", link: "javascript:alert(1)", title: "x" } });
	f = (await served("pr-12"))?.focus;
	t.check("a link of another scheme is served as null", f?.session.link === null, f);

	let a = await post({ itemId: "pr-12", action: "reanalyze", text: "look again" });
	t.check("Analyze again is refused while the item is in focus", a.ok === false && a.focus === true && !actions().some((x) => x.action === "reanalyze"), a);
	const pr12 = await served("pr-12");
	a = await post({ itemId: "pr-12", routeId: "r2", draftHash: pr12.routes.find((x) => x.id === "r2").draftHash });
	t.check("an agent route is refused while the item is in focus", a.ok === false && a.focus === true && actions().length === 0, a);
	const db = await (await fetch(`http://127.0.0.1:${port}/api/db`, { method: "POST", headers, body: JSON.stringify({ instance: "widgets", op: "set", path: "actions/pr-12-x", data: { itemId: "pr-12", action: "full_review", status: "queued", via: "queue", createdAt: new Date().toISOString(), result: "" } }) })).json();
	t.check("a page write of an agent request on an item in focus is refused", db.focus === true && !existsSync(join(actionsDir, "pr-12-x.json")), db);
	a = await post({ itemId: "pr-12", action: "focus" });
	t.check("Focus on an item already in focus is refused", a.ok === false && a.focus === true, a);

	a = await post({ itemId: "issue-22", action: "focus" });
	const doc = actions().find((x) => x.itemId === "issue-22" && x.action === "focus");
	t.check("Focus queues one focus request for the master", a.ok === true && a.queued === true && doc?.status === "queued" && doc.via === "queue", [a, doc]);
	t.check("the item is served as requested until the master handles it", (await served("issue-22"))?.focus?.status === "requested");
	a = await post({ itemId: "issue-22", action: "focus" });
	t.check("a second Focus while one is queued is refused", a.ok === false && actions().filter((x) => x.action === "focus").length === 1, a);
	gary("focus", "fail", "issue-22", "--request", doc.id, "--reason", "No way to start a session here.");
	f = (await served("issue-22"))?.focus;
	t.check("a failed focus request is served with its reason", f?.status === "failed" && f.reason === "No way to start a session here.", f);

	gary("focus", "check", "pr-12", "--activity", ago(40));
	writeRecord("pr-12", { ...record("pr-12"), lastActivity: ago(40) });
	gary("focus", "check", "pr-12");
	f = (await served("pr-12"))?.focus;
	t.check("a paused focus is served with the time it paused", f?.status === "paused" && typeof f.pausedAt === "string", f);
	a = await post({ itemId: "pr-12", action: "end_focus" });
	rec = record("pr-12");
	next = actions().find((x) => x.id === a.actionId);
	t.check("End focus ends it like done, without a summary, and queues the analysis", a.ok === true && rec.status === "ended" && rec.endedBy === "end" && rec.summary === null && next?.action === "reanalyze" && /ended the focus on the board/.test(next.text), [a, rec, next]);
	t.check("an ended focus is not served", !("focus" in (await served("pr-12"))));
	a = await post({ itemId: "pr-12", action: "end_focus" });
	t.check("End focus on an item out of focus says so", a.ok === false && /not in focus/.test(a.result), a);
} finally {
	child.kill();
}

t.check("no test wrote to GitHub", !existsSync(WRITES) || readFileSync(WRITES, "utf8").trim() === "");
removeDir(T);
t.done();
