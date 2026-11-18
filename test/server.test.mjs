// /api/action and /api/state of server/server.mjs on a temp home in dry-run mode, with the fake gh.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, freePort, makeHome, removeDir, tempDir } from "./lib.mjs";

const T = tempDir();
const { home, env } = makeHome(T);
const BOARD = join(home, "state", "board");
const PORT = await freePort();

const reviewedAt = "2026-11-17T14:00:00Z";
const later = "2026-11-18T09:00:00Z";
const items = {
	"pr-12": {
		kind: "pr", number: 12, title: "t", authorType: "maintainer", reviewedAt, reviewedSha: "944d5aca1b70af1d87ca805b08639f3e17b83dcd", hint: "Review: two inline comments",
		threads: [
			{ id: "PRRT_1", verdict: "valid" },
			{ id: "PRRT_2", verdict: "wrong" },
		],
		routes: [
			{ id: "r1", type: "review", title: "Review: two inline comments", as: "bot", recommended: true, text: "Two notes.",
				params: { event: "comment", comments: [
					{ id: "c1", path: "src/restore.ts", line: 40, text: "Restart the watchdog" },
					{ id: "c2", path: "src/restore.ts", startLine: 46, line: 48, text: "Destroy nodes first", diffHunk: "@@ -1,3 +1,3 @@\n-old\n+DIFFHUNK_MARKER" },
				] } },
			{ id: "r2", type: "address_review", title: "Address review: 2 threads", as: "agent", text: "" },
			{ id: "r3", type: "merge", title: "Merge: ready", as: "me", text: "" },
			{ id: "r4", type: "reply", title: "Reply: thanks", text: "Thanks" },
			{ id: "r5", type: "review", title: "Review: approve", as: "me", params: { event: "approve" } },
			{ id: "r6", type: "chore", title: "Chore: merge", as: "bot", params: { action: "merge" } },
			{ id: "r7", type: "take_over", title: "Take over: replace", as: "agent", params: { mode: "replace" } },
			{ id: "r8", type: "take_over", title: "Take over: push", as: "agent", params: { mode: "push" }, text: "Finish it" },
			{ id: "r9", type: "chore", title: "Chore: update branch", as: "bot", params: { action: "update_branch" } },
			{ id: "r10", type: "review", title: "Review: approve", as: "bot", params: { event: "approve" }, text: "" },
			{ id: "r11", type: "drive", title: "Drive: 2 rounds", as: "agent", params: { maxRounds: 2 } },
			{ id: "r12", type: "take_over", title: "Take over: default mode", as: "agent" },
			{ id: "r13", type: "chore", title: "Chore: Copilot review", as: "bot", params: { action: "request_review", reviewer: "copilot" } },
		],
	},
	"issue-21": {
		kind: "issue", number: 21, title: "t", reviewedAt, hint: "Follow-up: split the issue",
		routes: [
			{ id: "r1", type: "follow_up", title: "Follow-up: split the issue", as: "bot", recommended: true, params: { title: "Split part" }, text: "Body" },
			{ id: "r2", type: "move", title: "Move: to widgets-desktop", as: "bot", params: { to: "widgets-desktop" } },
			{ id: "r3", type: "move", title: "Move: to a discussion", as: "bot", params: { to: "discussion" } },
			{ id: "r4", type: "chore", title: "Chore: label", as: "bot", params: { action: "label", add: ["bug"] } },
			{ id: "r5", type: "request_logs", title: "Ask: debug log", as: "bot", text: "Please attach a log." },
			{ id: "r6", type: "close", title: "Close: done", as: "bot", params: { reason: "completed" } },
			{ id: "r7", type: "follow_up", title: "Follow-up: no actor", params: { title: "x" } },
			{ id: "r8", type: "follow_up", title: "Start fix: repro", as: "agent", text: "Use a mock node", params: { title: "ignored", finding: "f2" } },
			{ id: "r9", type: "reply", title: "Reply: as bot", as: "bot", text: "Hello" },
			{ id: "r10", type: "bogus", title: "Bogus", as: "bot" },
			{ id: "r11", type: "move", title: "Move: ask to reopen there", params: { to: "widgets-desktop" }, text: "Please open it in Widgets Desktop." },
			{ id: "r12", type: "move", title: "Move: to a discussion", params: { to: "discussion" } },
			{ id: "r13", type: "move", title: "Move: no text", params: { to: "widgets-desktop" } },
			{ id: "r14", type: "move", title: "Move: wrong actor", as: "me", params: { to: "widgets-desktop" } },
			{ id: "r15", type: "drive", title: "Drive: issue", as: "agent" },
		],
	},
	"issue-20": {
		kind: "issue", number: 20, title: "closed", reviewedAt, hint: "Reopen: wrongly closed",
		routes: [
			{ id: "r1", type: "reopen", title: "Reopen: wrongly closed", recommended: true, text: "Reopening." },
			{ id: "r2", type: "reopen", title: "Reopen: myself", as: "me" },
		],
	},
	"disc-34": {
		kind: "discussion", number: 34, title: "closed", reviewedAt, hint: "Reopen: x",
		routes: [{ id: "r1", type: "move", title: "Move: to an issue", params: { to: "issue" } }],
	},
	"pr-14": {
		kind: "pr", number: 14, title: "contributor", authorType: "contributor", reviewedAt, hint: "Drive: x",
		routes: [{ id: "r1", type: "drive", title: "Drive: x", as: "agent", params: { maxRounds: 4 } }, { id: "r2", type: "drive", title: "Drive: y", as: "agent" }],
	},
	"pr-13": {
		kind: "pr", number: 13, title: "taken over", authorType: "contributor", takenOver: true, reviewedAt, hint: "Drive: x",
		routes: [{ id: "r1", type: "drive", title: "Drive: x", as: "agent" }],
	},
	"issue-22": {
		kind: "issue", number: 22, title: "t", reviewedAt, hint: "Reply: hi",
		routes: [{ id: "r1", type: "reply", title: "Reply: hi", as: "bot", recommended: true, text: "Hi" }],
	},
	"issue-23": { kind: "issue", number: 24, title: "mismatch", reviewedAt, routes: [{ id: "r1", type: "reply", as: "bot", text: "x" }] },
};
for (const [id, data] of Object.entries(items)) writeFileSync(join(BOARD, "items", id + ".json"), JSON.stringify(data));
const stubFile = join(T, "stub.json");
writeFileSync(stubFile, JSON.stringify({
	"*": { state: "OPEN" },
	"issue-22": { state: "OPEN", comments: [{ author: { login: "someone", __typename: "User" }, at: later }] },
	"issue-20": { state: "CLOSED" },
}));

const child = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--port", String(PORT)], {
	env: { ...env, GARY_GUARD_STUB: stubFile },
	stdio: ["ignore", "inherit", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50 && !stderr.includes("Board on"); i++) await new Promise((r) => setTimeout(r, 100));
const TOKEN = readFileSync(join(home, "state", "server-token"), "utf8").trim();

async function api(path, body) {
	const res = await fetch(base + path, {
		method: body ? "POST" : "GET",
		headers: { "X-Board-Token": TOKEN, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, data: await res.json() };
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
	if (cond) pass++;
	else {
		fail++;
		console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 600));
	}
}

const state = await api("/api/state");
const served = Object.fromEntries(state.data.items.map((i) => [i.id, i.data]));
const hash = (item, route) => served[item].routes.find((r) => r.id === route).draftHash;
check("state serves routes with a draft hash", served["pr-12"].routes.every((r) => /^[0-9a-f]{16}$/.test(r.draftHash)), served["pr-12"].routes);
check("state serves no nextSteps", state.data.items.every((i) => i.data.nextSteps === undefined));

const click = (itemId, routeId, extra = {}) => api("/api/action", { itemId, routeId, draftHash: hash(itemId, routeId), ...extra });
const expect = async (name, itemId, routeId, extra, test) => {
	const r = await click(itemId, routeId, extra);
	check(name, test(r), r);
	return r;
};
const refused = (re) => (r) => r.status === 200 && r.data.ok === false && re.test(r.data.result);
const invocations = (r) => JSON.stringify(r.data.result?.invocations ?? []);

// Outdated and malformed clicks
await expect("unknown route is outdated", "pr-12", "r1", { routeId: "zz" }, (r) => r.data.outdated === true);
check("wrong draft hash is outdated", (await api("/api/action", { itemId: "pr-12", routeId: "r1", draftHash: "0000000000000000" })).data.outdated === true);
check("bad itemId is outdated", (await api("/api/action", { itemId: "../x", routeId: "r1" })).data.outdated === true);
check("item number mismatch is outdated", (await api("/api/action", { itemId: "issue-23", routeId: "r1", draftHash: hash("issue-23", "r1") })).data.outdated === true);

// Actor rules
await expect("merge as me is refused", "pr-12", "r3", {}, refused(/yours to do on GitHub/));
await expect("reply defaults to me and is refused", "pr-12", "r4", {}, refused(/yours to do on GitHub/));
await expect("review as me is prefill only", "pr-12", "r5", {}, refused(/yours to do on GitHub/));
await expect("close as bot is invalid", "issue-21", "r6", {}, refused(/invalid/));
await expect("follow_up without as is invalid", "issue-21", "r7", {}, refused(/invalid/));
await expect("unknown type is invalid", "issue-21", "r10", {}, refused(/invalid/));
await expect("chore merge is refused", "pr-12", "r6", {}, refused(/cannot run "merge"/));
await expect("move to a discussion with as bot is invalid", "issue-21", "r3", {}, refused(/invalid/));
await expect("take_over replace without callout is refused", "pr-12", "r7", {}, refused(/callout/));

// Input validation
await expect("review rejects unknown comment id", "pr-12", "r1", { input: { commentIds: ["c9"] } }, refused(/unknown comment/));
await expect("review rejects a repeated comment id", "pr-12", "r1", { input: { commentIds: ["c1", "c1"] } }, refused(/twice/));
await expect("review rejects unknown input keys", "pr-12", "r1", { input: { commentIds: [], extra: 1 } }, refused(/unknown field/));
await expect("review rejects non-array commentIds", "pr-12", "r1", { input: { commentIds: "c1" } }, refused(/must be an array/));
await expect("address_review rejects unknown thread", "pr-12", "r2", { input: { decisions: [{ threadId: "PRRT_x", decision: "fix" }] } }, refused(/unknown thread/));
await expect("address_review rejects bad decision", "pr-12", "r2", { input: { decisions: [{ threadId: "PRRT_1", decision: "maybe" }] } }, refused(/"fix" or "dismiss"/));
await expect("address_review rejects a long note", "pr-12", "r2", { input: { decisions: [{ threadId: "PRRT_1", decision: "fix", note: "x".repeat(1001) }] } }, refused(/at most 1000/));
await expect("address_review rejects empty decisions", "pr-12", "r2", { input: { decisions: [] } }, refused(/at least one/));
await expect("address_review rejects duplicate threads", "pr-12", "r2", { input: { decisions: [{ threadId: "PRRT_1", decision: "fix" }, { threadId: "PRRT_1", decision: "dismiss" }] } }, refused(/two decisions/));
await expect("address_review rejects unknown decision keys", "pr-12", "r2", { input: { decisions: [{ threadId: "PRRT_1", decision: "fix", path: "x" }] } }, refused(/unknown field/));
await expect("follow_up rejects an empty title", "issue-21", "r1", { input: { title: " " } }, refused(/input.title/));
await expect("chore rejects any input", "issue-21", "r4", { input: { add: ["x"] } }, refused(/unknown field/));
check("text over the limit is rejected", (await click("issue-21", "r9", { text: "x".repeat(65537) })).status === 400);

// Bot routes in dry-run
await expect("review posts only the checked comment", "pr-12", "r1", { input: { commentIds: ["c2"] } }, (r) =>
	r.data.ok && invocations(r).includes("Destroy nodes first") && !invocations(r).includes("DIFFHUNK_MARKER") && invocations(r).includes('"startLine":46') && !invocations(r).includes("Restart the watchdog") && invocations(r).includes('"sha":"944d5aca'));
await expect("a repeated click gets 409", "pr-12", "r1", { input: { commentIds: ["c2"] } }, (r) => r.status === 409 && r.data.duplicate === true);
await expect("approve review runs", "pr-12", "r10", {}, (r) => r.data.ok && invocations(r).includes("APPROVE"));
await expect("update_branch chore runs", "pr-12", "r9", {}, (r) => r.data.ok && invocations(r).includes("updatePullRequestBranch"));
await expect("follow_up as bot files an issue and links it", "issue-21", "r1", { input: { title: "Edited title" } }, (r) =>
	r.data.ok && invocations(r).includes("createIssue") && invocations(r).includes("Edited title") && invocations(r).includes("Follow-up: #<new issue>"));
await expect("move with mode transfer transfers", "issue-21", "r2", { input: { mode: "transfer" } }, (r) => r.data.ok && invocations(r).includes("transferIssue"));
await expect("label chore runs", "issue-21", "r4", {}, (r) => r.data.ok && invocations(r).includes("addLabelsToLabelable"));
await expect("request_logs posts the text", "issue-21", "r5", {}, (r) => r.data.ok && invocations(r).includes("Please attach a log."));
await expect("reply as bot posts the edited text", "issue-21", "r9", { text: "Edited hello" }, (r) => r.data.ok && invocations(r).includes("Edited hello"));

// reopen, move, drive, diffHunk
await expect("reopen defaults to bot and posts the text first", "issue-20", "r1", {}, (r) => r.data.ok && invocations(r).includes("Reopening.") && invocations(r).includes("reopenIssue"));
await expect("reopen as me is refused", "issue-20", "r2", {}, refused(/yours to do on GitHub/));
await expect("move without mode is refused", "issue-21", "r11", {}, refused(/input.mode/));
await expect("move with a bad mode is refused", "issue-21", "r11", { input: { mode: "delete" } }, refused(/input.mode/));
await expect("move close needs a text", "issue-21", "r13", { input: { mode: "close" } }, refused(/needs a text/));
await expect("move close posts the text and closes as not planned", "issue-21", "r11", { input: { mode: "close" } }, (r) =>
	r.data.ok && invocations(r).includes("Please open it in Widgets Desktop.") && invocations(r).includes("NOT_PLANNED"));
await expect("move to a discussion is the maintainer's", "issue-21", "r12", {}, refused(/yours to do on GitHub/));
await expect("move to an issue is the maintainer's", "disc-34", "r1", {}, refused(/yours to do on GitHub/));
await expect("move with as me to a repo is invalid", "issue-21", "r14", {}, refused(/invalid/));
await expect("drive on an issue is refused", "issue-21", "r15", {}, refused(/only on PRs/));
await expect("drive on a contributor PR is refused", "pr-14", "r2", {}, refused(/taken-over PRs/));
await expect("drive with maxRounds 4 is refused", "pr-14", "r1", {}, refused(/taken-over PRs|maxRounds/));
await expect("drive on a taken-over PR is queued with 3 rounds", "pr-13", "r1", {}, (r) => r.data.ok && r.data.queued);
await expect("drive on a maintainer PR is queued", "pr-12", "r11", {}, (r) => r.data.ok && r.data.queued);
await expect("take_over defaults to push", "pr-12", "r12", {}, (r) => r.data.ok && r.data.queued);
check("route comments keep diffHunk in the served route", served["pr-12"].routes.find((r) => r.id === "r1").params.comments[1].diffHunk.includes("DIFFHUNK_MARKER"));

await expect("a chore cannot request a Copilot review", "pr-12", "r13", {}, refused(/cannot run "request_review"/));

// Staleness guard
await expect("a new human comment refuses the click", "issue-22", "r1", {}, (r) => r.data.ok === false && r.data.stale === true && r.data.forceable === true);
await expect("force runs it anyway", "issue-22", "r1", { force: true }, (r) => r.data.ok === true);

// Agent routes
await expect("address_review is queued", "pr-12", "r2", { input: { decisions: [{ threadId: "PRRT_1", decision: "fix", note: " fix it " }, { threadId: "PRRT_2", decision: "dismiss" }] }, text: "Run note" }, (r) => r.data.ok && r.data.queued);
await expect("take_over push is queued", "pr-12", "r8", {}, (r) => r.data.ok && r.data.queued);
await expect("follow_up as agent is queued as start_fix", "issue-21", "r8", {}, (r) => r.data.ok && r.data.queued);
await expect("a repeated agent click gets 409", "issue-21", "r8", {}, (r) => r.status === 409);

// Action log
await new Promise((r) => setTimeout(r, 300));
const docs = readdirSync(join(BOARD, "actions")).map((n) => JSON.parse(readFileSync(join(BOARD, "actions", n), "utf8")));
const byRoute = (itemId, routeId) => docs.filter((d) => d.itemId === itemId && d.routeId === routeId);
const ar = byRoute("pr-12", "r2")[0];
check("address_review doc is queued with decisions", ar?.status === "queued" && ar.action === "address_review" && ar.params.decisions.length === 2 && ar.params.decisions[0].note === "fix it" && ar.text === "Run note", ar);
const sf = byRoute("issue-21", "r8")[0];
check("start_fix doc carries text and finding only", sf?.action === "start_fix" && sf.text === "Use a mock node" && JSON.stringify(sf.params) === '{"finding":"f2"}', sf);
check("drive doc", byRoute("pr-13", "r1")[0]?.params?.maxRounds === 3 && byRoute("pr-12", "r11")[0]?.params?.maxRounds === 2, docs.filter((d) => d.action === "drive"));
check("take_over default doc", byRoute("pr-12", "r12")[0]?.params?.mode === "push", byRoute("pr-12", "r12"));
check("take_over doc carries the text", byRoute("pr-12", "r8")[0]?.text === "Finish it", byRoute("pr-12", "r8"));
check("take_over doc", byRoute("pr-12", "r8")[0]?.params?.mode === "push", byRoute("pr-12", "r8"));
check("bot route doc is done via server", byRoute("issue-21", "r2")[0]?.status === "done" && byRoute("issue-21", "r2")[0]?.via === "server", byRoute("issue-21", "r2"));
check("edited flag", byRoute("issue-21", "r9")[0]?.edited === true && byRoute("issue-21", "r5")[0]?.edited === false, docs);
check("refused routes are not logged", byRoute("pr-12", "r3").length === 0 && byRoute("pr-12", "r4").length === 0 && byRoute("issue-21", "r3").length === 0);
check("each click logged once", byRoute("pr-12", "r1").length === 1, byRoute("pr-12", "r1"));

const after = Object.fromEntries((await api("/api/state")).data.items.map((i) => [i.id, i.data]));
const r1 = after["pr-12"].routes.find((r) => r.id === "r1");
check("state marks a ran route as done", r1.done?.status === "done", r1);
check("state marks a queued route", after["pr-12"].routes.find((r) => r.id === "r2").done?.status === "queued");

child.kill("SIGTERM");
removeDir(T);
console.log(`server: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
