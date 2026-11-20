// /api/action and /api/state of server/server.mjs on a temp root in dry-run mode, with the fake gh.
// The second half runs two instances in the one server and adds a third while it runs.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PROFILE, ROOT, freePort, makeHome, removeDir, tempDir } from "./lib.mjs";
import { commentBody, planRoute } from "../server/server.mjs";

const T = tempDir();
const PORT = await freePort();
const { home, root, env } = makeHome(T, { port: PORT });
const BOARD = join(home, "state", "board");
const REPO = "acme/widgets";

const reviewedAt = "2026-11-17T14:00:00Z";
const later = "2026-11-18T09:00:00Z";
const items = {
	"pr-12": {
		kind: "pr", repo: REPO, number: 12, title: "t", authorType: "maintainer", reviewedAt, reviewedSha: "944d5aca1b70af1d87ca805b08639f3e17b83dcd", hint: "Review: two inline comments",
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
			{ id: "r14", type: "format", title: "Format: no autofix check", as: "agent" },
			{ id: "r15", type: "chore", title: "Chore: ready", as: "bot", params: { action: "ready" } },
			{ id: "r16", type: "reply", title: "Reply: while it works", as: "bot", text: "Working on it" },
			{ id: "r17", type: "review", title: "Review: approve later", as: "bot", params: { event: "approve" }, text: "" },
			{ id: "r18", type: "revise", title: "Change: drop the file", as: "agent", text: "Drop the 0x00c8 file" },
			{ id: "r19", type: "revise", title: "Change: no text", as: "agent" },
			{ id: "r20", type: "review", title: "Review: comment while watched", as: "bot", params: { event: "comment" }, text: "WATCHED_REVIEW" },
		],
	},
	"issue-21": {
		kind: "issue", repo: REPO, number: 21, title: "t", reviewedAt, hint: "Follow-up: split the issue",
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
		kind: "issue", repo: REPO, number: 20, title: "closed", reviewedAt, hint: "Reopen: wrongly closed",
		routes: [
			{ id: "r1", type: "reopen", title: "Reopen: wrongly closed", recommended: true, text: "Reopening." },
			{ id: "r2", type: "reopen", title: "Reopen: myself", as: "me" },
		],
	},
	"disc-34": {
		kind: "discussion", repo: REPO, number: 34, title: "closed", reviewedAt, hint: "Reopen: x",
		routes: [{ id: "r1", type: "move", title: "Move: to an issue", params: { to: "issue" } }],
	},
	"pr-14": {
		kind: "pr", repo: REPO, number: 14, title: "contributor", authorType: "contributor", reviewedAt, hint: "Drive: x",
		reviewedSha: "c".repeat(40), autofix: { changes: true, files: 2, lines: 14, tools: ["eslint", "prettier"] },
		routes: [
			{ id: "r1", type: "drive", title: "Drive: x", as: "agent", params: { maxRounds: 4 } },
			{ id: "r2", type: "drive", title: "Drive: y", as: "agent" },
			{ id: "r3", type: "format", title: "Format: run the autofix", as: "agent" },
		],
	},
	"pr-15": {
		kind: "pr", repo: REPO, number: 15, title: "clean contributor PR", authorType: "contributor", reviewedAt, reviewedSha: "d".repeat(40), hint: "Format: x",
		autofix: { changes: false, files: 0, lines: 0, tools: ["prettier"] },
		routes: [{ id: "r1", type: "format", title: "Format: x", as: "agent" }],
	},
	"pr-16": {
		kind: "pr", repo: REPO, number: 16, title: "contributor, not taken over", authorType: "contributor", reviewedAt, hint: "Take over: push",
		routes: [
			{ id: "r1", type: "take_over", title: "Take over: replace", as: "agent", params: { mode: "replace" } },
			{ id: "r2", type: "take_over", title: "Take over: push", as: "agent", params: { mode: "push" }, text: "Finish it", recommended: true },
			{ id: "r3", type: "take_over", title: "Take over: default mode", as: "agent" },
			{ id: "r4", type: "revise", title: "Change: the name", as: "agent", text: "Rename it" },
		],
	},
	// A stored take_over on the bot's own PR
	"pr-17": {
		kind: "pr", repo: REPO, number: 17, title: "bot fix PR", authorType: "bot", author: "widgets-bot", reviewedAt, hint: "Take over: drop the 0x00c8 file",
		routes: [{ id: "r1", type: "take_over", title: "Take over: drop the 0x00c8 file", as: "agent", params: { mode: "push" }, text: "Drop the 0x00c8 file", recommended: true }],
	},
	"pr-13": {
		kind: "pr", repo: REPO, number: 13, title: "taken over", authorType: "contributor", takenOver: true, reviewedAt, hint: "Drive: x",
		routes: [{ id: "r1", type: "drive", title: "Drive: x", as: "agent" }],
	},
	"issue-22": {
		kind: "issue", repo: REPO, number: 22, title: "t", reviewedAt, hint: "Reply: hi",
		routes: [{ id: "r1", type: "reply", title: "Reply: hi", as: "bot", recommended: true, text: "Hi" }],
	},
	"issue-23": { kind: "issue", repo: "acme/gadgets", number: 23, title: "foreign repo", reviewedAt, routes: [{ id: "r1", type: "reply", as: "bot", text: "x" }] },
	"issue-25": { kind: "issue", number: 25, title: "no repo", reviewedAt, routes: [{ id: "r1", type: "reply", as: "bot", text: "x" }] },
	"issue-40": {
		kind: "issue", repo: REPO, number: 21, title: "needs a log", reviewedAt, hint: "Reply: plain",
		routes: [
			{ id: "r1", type: "reply", title: "Reply: ask for a log", text: "Please attach a log.", params: { alsoLabel: { add: ["needs-info"] } } },
			{ id: "r2", type: "request_logs", title: "Ask: log, as bot", as: "bot", text: "BOT_ASKS_LOG", params: { alsoLabel: { add: ["needs-info"], remove: ["bug"] } } },
			{ id: "r3", type: "request_logs", title: "Ask: log, no label", as: "bot", text: "BOT_ASKS_NO_LABEL", params: { alsoLabel: { add: ["needs-info"] } } },
			{ id: "r4", type: "reply", title: "Reply: plain", as: "bot", recommended: true, text: "Plain" },
			{ id: "r5", type: "request_logs", title: "Ask: missing label", as: "bot", text: "BOT_ASKS_MISSING", params: { alsoLabel: { add: ["waiting-for-info"] } } },
			{ id: "r6", type: "request_logs", title: "Ask: bad input", as: "bot", text: "x", params: { alsoLabel: { add: ["needs-info"] } } },
			{ id: "r7", type: "reply", title: "Reply: no labels", as: "bot", text: "x" },
		],
	},
	"disc-31": {
		kind: "discussion", repo: REPO, number: 31, title: "answered", url: "https://github.com/acme/widgets/discussions/31", reviewedAt, hint: "Close: answered",
		routes: [{ id: "r1", type: "close", title: "Close: answered", recommended: true, text: "Thanks, closing.", params: { alsoAnswer: { commentId: "DC_c1", url: "https://github.com/acme/widgets/discussions/31#c1", gist: "Hold the button" } } }],
	},
	"pr-18": {
		kind: "pr", repo: REPO, number: 14, title: "review with a suggestion", authorType: "contributor", reviewedAt, hint: "Request changes: 2 fixes",
		routes: [{ id: "r1", type: "review", title: "Request changes: 2 fixes", as: "bot", recommended: true, text: "Two things.",
			params: { event: "request_changes", comments: [
				{ id: "c1", path: "src/a.ts", line: 4, text: "Check the length", original: "old", suggestion: "new" },
				{ id: "c2", path: "src/a.ts", line: 9, text: "Why this value?" },
			] } }],
	},
	"issue-64": {
		kind: "issue", repo: REPO, number: 64, title: "two prefills and a fix", reviewedAt, hint: "Reply: x",
		routes: [
			{ id: "r1", type: "reply", title: "Reply: x", recommended: true, text: "Drafted reply" },
			{ id: "r2", type: "close", title: "Close: x", text: "Closing." },
			{ id: "r3", type: "follow_up", as: "agent", title: "Start fix: x", text: "Fix it" },
		],
	},
	"issue-60": { kind: "issue", repo: REPO, number: 22, title: "refresh unchanged", reviewedAt, hint: "Reply: x", routes: [{ id: "r1", type: "reply", title: "Reply: x", recommended: true, text: "x" }] },
	"issue-61": { kind: "issue", repo: REPO, number: 23, title: "refresh closed", reviewedAt, hint: "Close: x", routes: [{ id: "r1", type: "close", title: "Close: x", recommended: true, text: "x" }] },
	"disc-62": { kind: "discussion", repo: REPO, number: 35, title: "refresh commented", reviewedAt, hint: "Reply: x", routes: [{ id: "r1", type: "reply", title: "Reply: x", recommended: true, text: "x" }] },
	"pr-63": { kind: "pr", repo: REPO, number: 18, title: "refresh merged", authorType: "maintainer", reviewedAt, ci: "pending", mergeable: "unknown", hint: "Merge: x", routes: [{ id: "r1", type: "merge", title: "Merge: x", as: "me", recommended: true }] },
	...Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`issue-${70 + k}`, { kind: "issue", repo: REPO, number: 22, title: "budget", reviewedAt, routes: [] }])),
	"issue-41": { kind: "issue", repo: REPO, number: 20, title: "closed", reviewedAt, hint: "Reply: x", routes: [{ id: "r1", type: "reply", title: "Reply: x", recommended: true, text: "x", params: { alsoLabel: { add: ["needs-info"] } } }] },
};
for (const [id, data] of Object.entries(items)) writeFileSync(join(BOARD, "items", id + ".json"), JSON.stringify(data));
writeFileSync(join(BOARD, "items", "issue-30.json"), JSON.stringify({ kind: "issue", repo: REPO, number: 21, title: "t", reviewedAt, hint: "Reply: hi", routes: [{ id: "r1", type: "reply", title: "Reply: hi", as: "bot", recommended: true, text: "Hi from widgets" }] }));

// A second instance in the same root, for the repo acme/gadgets
function profileFor(name, repo) {
	const dir = join(T, `profile-${name}`);
	cpSync(PROFILE, dir, { recursive: true });
	writeFileSync(join(dir, "profile.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8")), name, repo }));
	return dir;
}
const gadgets = makeHome(T, { profile: profileFor("gadgets", "acme/gadgets") }, "gadgets");
const GBOARD = join(gadgets.home, "state", "board");
const gadgetItems = {
	"pr-12": { kind: "pr", repo: "acme/gadgets", number: 12, title: "gadgets PR", authorType: "maintainer", reviewedAt, hint: "Reply: gadgets", routes: [{ id: "r1", type: "reply", title: "Reply: gadgets", as: "bot", recommended: true, text: "Hi from gadgets" }] },
	"issue-90": { kind: "issue", repo: "acme/gadgets", number: 90, title: "only in gadgets", reviewedAt, hint: "Reply: x", routes: [{ id: "r1", type: "reply", title: "Reply: x", as: "bot", recommended: true, text: "x" }, { id: "r2", type: "request_logs", title: "Ask: log", as: "bot", text: "Log?" }] },
	"issue-91": { kind: "issue", repo: REPO, number: 91, title: "widgets repo in gadgets", reviewedAt, hint: "Reply: x", routes: [{ id: "r1", type: "reply", title: "Reply: x", as: "bot", recommended: true, text: "x" }] },
	"issue-92": { kind: "issue", repo: "acme/gadgets", number: 22, title: "label in gadgets", reviewedAt, hint: "Reply: x", routes: [{ id: "r1", type: "reply", title: "Reply: x", recommended: true, text: "x", params: { alsoLabel: { add: ["needs-info"] } } }] },
	"disc-95": {
		kind: "discussion", repo: "acme/gadgets", number: 31, title: "gadgets answer", reviewedAt, hint: "Close: x",
		routes: [{ id: "r1", type: "close", title: "Close: x", recommended: true, text: "x", params: { alsoAnswer: { commentId: "DC_c1", url: "x#c1", gist: "x" } } }],
	},
	"issue-93": { kind: "issue", repo: "acme/gadgets", number: 21, title: "own login", reviewedAt, hint: "Reply: x", routes: [{ id: "r1", type: "reply", title: "Reply: x", recommended: true, text: "x", params: { alsoLabel: { remove: ["bug"] } } }] },
};
for (const [id, data] of Object.entries(gadgetItems)) writeFileSync(join(GBOARD, "items", id + ".json"), JSON.stringify(data));
writeFileSync(join(GBOARD, "meta.json"), JSON.stringify({ lastRunSummary: "gadgets run" }));
const stubFile = join(T, "stub.json");
writeFileSync(stubFile, JSON.stringify({
	"*": { state: "OPEN" },
	"issue-22": { state: "OPEN", comments: [{ author: { login: "someone", __typename: "User" }, at: later }] },
	"issue-20": { state: "CLOSED" },
	"acme/widgets#20": { state: "CLOSED" },
}));
const ghLog = join(T, "gh.log");
const ghOverrides = join(T, "gh-overrides.json");
writeFileSync(ghOverrides, "{}");

const child = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--port", String(PORT)], {
	env: { ...env, GARY_GUARD_STUB: stubFile, FAKE_GH_LOG: ghLog, FAKE_GH_OVERRIDES: ghOverrides },
	stdio: ["ignore", "inherit", "pipe"],
});
process.on("exit", () => child.kill("SIGTERM"));
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await new Promise((r) => setTimeout(r, 100));
const TOKEN = readFileSync(join(root, "state", "server-token"), "utf8").trim();

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
const served = Object.fromEntries(state.data.items.filter((i) => i.instance === "widgets").map((i) => [i.id, i]));
const hash = (item, route) => served[item].routes.find((r) => r.id === route).draftHash;
check("state serves routes with a draft hash", served["pr-12"].routes.every((r) => /^[0-9a-f]{16}$/.test(r.draftHash)), served["pr-12"].routes);
check("state serves no nextSteps", state.data.items.every((i) => i.nextSteps === undefined));

const click = (itemId, routeId, extra = {}) => api("/api/action", { instance: "widgets", itemId, routeId, draftHash: hash(itemId, routeId), ...extra });
const expect = async (name, itemId, routeId, extra, test) => {
	const r = await click(itemId, routeId, extra);
	check(name, test(r), r);
	return r;
};
const refused = (re) => (r) => r.status === 200 && r.data.ok === false && re.test(r.data.result);
const invocations = (r) => JSON.stringify(r.data.result?.invocations ?? []);

// Outdated and malformed clicks
await expect("unknown route is outdated", "pr-12", "r1", { routeId: "zz" }, (r) => r.data.outdated === true);
check("wrong draft hash is outdated", (await api("/api/action", { instance: "widgets", itemId: "pr-12", routeId: "r1", draftHash: "0000000000000000" })).data.outdated === true);
check("bad itemId is outdated", (await api("/api/action", { instance: "widgets", itemId: "../x", routeId: "r1" })).data.outdated === true);
await expect("an item of a repo outside the instance is refused", "issue-23", "r1", {}, refused(/acme\/gadgets is not a repository of instance widgets/));
await expect("an item without a repo is refused", "issue-25", "r1", {}, refused(/names no repository/));
for (const instance of [undefined, "nope", "../widgets", "Widgets", 7]) {
	const r = await api("/api/action", { instance, itemId: "pr-12", routeId: "r1", draftHash: hash("pr-12", "r1") });
	check(`instance ${JSON.stringify(instance)} is refused`, r.status === 400 && r.data.ok === false && /Unknown instance/.test(r.data.result), r);
}

// Actor rules
await expect("merge as me is refused", "pr-12", "r3", {}, refused(/yours to do on GitHub/));
await expect("reply defaults to me and is refused", "pr-12", "r4", {}, refused(/yours to do on GitHub/));
await expect("review as me is prefill only", "pr-12", "r5", {}, refused(/yours to do on GitHub/));
await expect("close as bot is invalid", "issue-21", "r6", {}, refused(/invalid/));
await expect("follow_up without as is invalid", "issue-21", "r7", {}, refused(/invalid/));
await expect("unknown type is invalid", "issue-21", "r10", {}, refused(/invalid/));
await expect("chore merge is refused", "pr-12", "r6", {}, refused(/cannot run "merge"/));
await expect("move to a discussion with as bot is invalid", "issue-21", "r3", {}, refused(/invalid/));
await expect("take_over replace without callout is refused", "pr-16", "r1", {}, refused(/callout/));
await expect("take_over on a PR we control is refused", "pr-12", "r7", {}, refused(/Use revise on this PR/));
await expect("revise on a contributor PR that is not taken over is refused", "pr-16", "r4", {}, refused(/Use take_over on a contributor PR/));
await expect("revise without text is refused", "pr-12", "r19", {}, refused(/needs a text/));
await expect("revise with blank instructions is refused", "pr-12", "r18", { text: "  " }, refused(/needs a text/));
await expect("revise takes no input", "pr-12", "r18", { input: { decisions: [] } }, refused(/unknown field/));

// A stored take_over on a PR we control is served and run as revise
const storedItem = (id) => JSON.parse(readFileSync(join(BOARD, "items", id + ".json"), "utf8"));
check("a stored take_over on a bot PR is served as revise", served["pr-17"].routes[0].type === "revise" && served["pr-17"].routes[0].title === "Change: drop the 0x00c8 file" && served["pr-17"].routes[0].actor === "agent", served["pr-17"].routes[0]);
check("the served hint follows the served title", served["pr-17"].hint === "Change: drop the 0x00c8 file", served["pr-17"].hint);
check("a stored take_over push on a maintainer PR is served as revise", served["pr-12"].routes.find((r) => r.id === "r8").type === "revise" && served["pr-12"].routes.find((r) => r.id === "r12").type === "revise");
check("a stored replacement stays take_over", served["pr-12"].routes.find((r) => r.id === "r7").type === "take_over");
check("take_over on a contributor PR is served as it is", served["pr-16"].routes.slice(0, 3).every((r) => r.type === "take_over") && served["pr-16"].hint === "Take over: push", served["pr-16"].routes);
await expect("the served revise is queued", "pr-17", "r1", {}, (r) => r.data.ok && r.data.queued);
check("the stored item keeps its take_over route", storedItem("pr-17").routes[0].type === "take_over" && storedItem("pr-17").hint === "Take over: drop the 0x00c8 file", storedItem("pr-17").routes);
check("the click is recorded as revise", storedItem("pr-17").handled?.routeType === "revise", storedItem("pr-17").handled);
await expect("a mapped take_over without text is refused as a revise", "pr-12", "r12", {}, refused(/needs a text/));

// Input validation
await expect("review rejects unknown comment id", "pr-12", "r1", { input: { commentIds: ["c9"] } }, refused(/unknown comment/));
await expect("review rejects an unknown event", "pr-18", "r1", { input: { event: "dismiss" } }, refused(/input.event must be one of approve, request_changes, comment/));
await expect("an approval with a checked suggestion is refused", "pr-18", "r1", { input: { event: "approve" } }, refused(/An approval cannot carry suggestions/));
// Edited inline comments
{
	const { commentProse, editedCommentBody } = await import("../scripts/lib/routes.mjs");
	const inside = { text: "Use the constant.\n```suggestion\nconst a = MAX;\n```" };
	check("a suggestion inside the text is no part of the comment's words", commentProse(inside) === "Use the constant." && commentProse({ text: " Plain. " }) === "Plain." && commentProse({ text: "With field", suggestion: "x" }) === "With field");
	check("an edit keeps a suggestion that sits inside the text", editedCommentBody(inside, "Please use the constant.") === "Please use the constant.\n\n```suggestion\nconst a = MAX;\n```" && editedCommentBody({ text: "Old" }, "New") === "New");
}
await expect("an edited comment must be one of the route", "pr-18", "r1", { input: { commentTexts: { c9: "x" } } }, refused(/commentTexts names an unknown comment/));
await expect("an edited comment needs a text", "pr-18", "r1", { input: { commentTexts: { c1: "  " } } }, refused(/An edited comment needs a text/));
await expect("an edited comment must be a string", "pr-18", "r1", { input: { commentTexts: { c1: 5 } } }, refused(/An edited comment needs a text/));
await expect("commentTexts must be a map", "pr-18", "r1", { input: { commentTexts: ["x"] } }, refused(/must map comment ids to texts/));
await expect("an edited comment has a length cap", "pr-18", "r1", { input: { commentTexts: { c1: "x".repeat(65537) } } }, refused(/at most 65536 characters/));
await expect("an edited comment cannot bring its own suggestion", "pr-18", "r1", { input: { commentTexts: { c1: "Use this:\n```suggestion\nevil\n```" } } }, refused(/cannot hold a suggestion block/));
await expect("an edited comment with a bot command is refused", "pr-18", "r1", { input: { event: "comment", commentTexts: { c2: "Fine. @widgets-bot automerge" } } }, (r) => r.data.ok === false && /bot command/.test(JSON.stringify(r.data)));
await expect("only a review takes commentTexts", "issue-21", "r9", { input: { commentTexts: { c1: "x" } } }, refused(/unknown field/));
await expect("an edited comment goes out with its suggestion unchanged", "pr-18", "r1", { input: { event: "comment", commentIds: ["c1"], commentTexts: { c1: " Please check the length here. ", c2: "Dropped with its checkbox" } } }, (r) =>
	r.data.ok === true && invocations(r).includes("Please check the length here.\\n\\n```suggestion\\nnew\\n```") && !invocations(r).includes("Check the length") && !invocations(r).includes("Dropped with its checkbox") && !invocations(r).includes("Why this value?"));
await expect("follow_up rejects an askReporter that is no boolean", "issue-21", "r8", { input: { askReporter: "yes" } }, refused(/input.askReporter must be true or false/));
await expect("only the agent's fix card takes askReporter", "issue-21", "r1", { input: { askReporter: true } }, refused(/unknown field "askReporter"/));
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
await expect("format without an autofix check is refused", "pr-12", "r14", {}, refused(/autofix check to have found changes/));
await expect("drive on a maintainer PR is queued", "pr-12", "r11", {}, (r) => r.data.ok && r.data.queued);
await expect("format when the autofix changes nothing is refused", "pr-15", "r1", {}, refused(/autofix check to have found changes/));
await expect("format takes no input", "pr-14", "r3", { input: { files: ["a"] } }, refused(/unknown field/));
await expect("format on a contributor PR that is not taken over is queued", "pr-14", "r3", {}, (r) => r.data.ok && r.data.queued);
// One push job per item at a time. finishQueued stands in for a worker that finished its request
const finishQueued = () => {
	for (const n of readdirSync(join(BOARD, "actions"))) {
		const f = join(BOARD, "actions", n);
		const d = JSON.parse(readFileSync(f, "utf8"));
		if (d.status === "queued") writeFileSync(f, JSON.stringify({ ...d, status: "done", finishedAt: new Date().toISOString() }));
	}
};
await expect("a second push job on an item with a queued one gets 409", "pr-12", "r12", {}, (r) => r.status === 409 && r.data.working === true && r.data.result === "The agent is changing this PR. Decide after it is done.");
await expect("a review is blocked while the agent pushes to the PR", "pr-12", "r17", {}, (r) => r.status === 409 && r.data.result === "The agent is changing this PR. Decide after it is done.");
await expect("a ready chore is blocked too", "pr-12", "r15", {}, (r) => r.status === 409 && /changing this PR/.test(r.data.result));
await expect("a reply stays allowed", "pr-12", "r16", {}, (r) => r.data.ok === true);
await expect("revise is blocked like the other pushing routes", "pr-12", "r18", {}, (r) => r.status === 409 && /changing this PR/.test(r.data.result));
let st = (await api("/api/state")).data.items.find((i) => i.instance === "widgets" && i.id === "pr-12");
check("the item is served as working while a push job is queued", st.working?.kind === "push" && st.working.action === "drive" && typeof st.working.since === "string", st.working);
finishQueued();
// A drive that waits for a review bot between rounds still pushes
mkdirSync(join(home, "state", "drive"), { recursive: true });
writeFileSync(join(home, "state", "drive", "pr-12.json"), JSON.stringify({ reviewRequestedAt: new Date().toISOString(), repo: REPO, number: 12 }));
st = (await api("/api/state")).data.items.find((i) => i.instance === "widgets" && i.id === "pr-12");
check("a waiting drive is served as push work", st.working?.kind === "push" && st.working.action === "drive", st.working);
await expect("a waiting drive blocks a review", "pr-12", "r17", {}, (r) => r.status === 409 && /changing this PR/.test(r.data.result));
rmSync(join(home, "state", "drive", "pr-12.json"));
st = (await api("/api/state")).data.items.find((i) => i.instance === "widgets" && i.id === "pr-12");
check("a finished job leaves the item without working", st.working === undefined, st.working);
// A watched PR that only waits for his feedback blocks none of his clicks
writeFileSync(join(home, "state", "drive", "pr-12.json"), JSON.stringify({ repo: REPO, number: 12, by: "watch", watch: true, stage: "watch", copilotRounds: 1, rounds: [], seenAt: {} }));
st = (await api("/api/state")).data.items.find((i) => i.instance === "widgets" && i.id === "pr-12");
check("a watch is no push work", st.working === undefined, st.working);
await expect("a watch does not block his merge click", "pr-12", "r3", {}, refused(/yours to do on GitHub/));
await expect("a watch does not block a review", "pr-12", "r20", {}, (r) => r.data.ok === true && invocations(r).includes("WATCHED_REVIEW"));
rmSync(join(home, "state", "drive", "pr-12.json"));
await expect("take_over defaults to push", "pr-16", "r3", {}, (r) => r.data.ok && r.data.queued);
await expect("revise is queued", "pr-12", "r18", {}, (r) => r.data.ok && r.data.queued);
st = (await api("/api/state")).data.items.find((i) => i.instance === "widgets" && i.id === "pr-12");
check("a queued revise is served as push work", st.working?.kind === "push" && st.working.action === "revise", st.working);
await expect("a queued revise blocks a review", "pr-12", "r17", {}, (r) => r.status === 409 && r.data.result === "The agent is changing this PR. Decide after it is done.");
await expect("a queued revise blocks a ready chore", "pr-12", "r15", {}, (r) => r.status === 409 && /changing this PR/.test(r.data.result));
await expect("a queued revise blocks address_review", "pr-12", "r2", { input: { decisions: [{ threadId: "PRRT_1", decision: "fix" }] } }, (r) => r.status === 409 && /changing this PR/.test(r.data.result));
await expect("a reply is not blocked while a revise runs", "pr-12", "r4", {}, refused(/yours to do on GitHub/));
finishQueued();
// A push claim without a queued request blocks a revise too
mkdirSync(join(home, "state", "claims"), { recursive: true });
writeFileSync(join(home, "state", "claims", "pr-12.push.json"), JSON.stringify({ run: "run-revise", at: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }));
await expect("a push claim blocks a revise", "pr-12", "r12", { text: "Do it" }, (r) => r.status === 409 && r.data.working === true);
rmSync(join(home, "state", "claims", "pr-12.push.json"));
await expect("a mapped take_over with typed instructions is queued as revise", "pr-12", "r12", { text: "Do it" }, (r) => r.data.ok && r.data.queued);
check("route comments keep diffHunk in the served route", served["pr-12"].routes.find((r) => r.id === "r1").params.comments[1].diffHunk.includes("DIFFHUNK_MARKER"));

await expect("a chore cannot request a Copilot review", "pr-12", "r13", {}, refused(/cannot run "request_review"/));

// Staleness guard
await expect("a new human comment refuses the click", "issue-22", "r1", {}, (r) => r.data.ok === false && r.data.stale === true && r.data.forceable === true);
await expect("force runs it anyway", "issue-22", "r1", { force: true }, (r) => r.data.ok === true);

// Agent routes
finishQueued();
await expect("take_over push is queued", "pr-16", "r2", {}, (r) => r.data.ok && r.data.queued);
await expect("a mapped take_over push is queued", "pr-12", "r8", {}, (r) => r.data.ok && r.data.queued);
finishQueued();
await expect("address_review is queued", "pr-12", "r2", { input: { decisions: [{ threadId: "PRRT_1", decision: "fix", note: " fix it " }, { threadId: "PRRT_2", decision: "dismiss" }] }, text: "Run note" }, (r) => r.data.ok && r.data.queued);
// A claim of the matching kind blocks a click, a claim of another kind does not
mkdirSync(join(home, "state", "claims"), { recursive: true });
writeFileSync(join(home, "state", "claims", "issue-21.fix.json"), JSON.stringify({ run: "run-hourly", at: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }));
writeFileSync(join(home, "state", "claims", "disc-34.review.json"), JSON.stringify({ run: "run-old", at: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T01:00:00Z" }));
await sleep(300);
await expect("a fix claim of the hourly run blocks Start fix", "issue-21", "r8", {}, (r) => r.status === 409 && r.data.fixRunning === true && /already running, started by the routine/.test(r.data.result));
st = (await api("/api/state")).data.items.filter((i) => i.instance === "widgets");
check("an issue with a running fix is served with item.fix", st.find((i) => i.id === "issue-21").fix?.state === "working" && st.find((i) => i.id === "issue-21").fix.startedBy === "routine" && st.find((i) => i.id === "issue-21").fix.parked === true && JSON.stringify(st.find((i) => i.id === "issue-21").fix.limit) === '{"pending":1,"max":10}' && st.find((i) => i.id === "issue-22").fix === undefined, st.find((i) => i.id === "issue-21").fix);
check("a claim is served as working with its kind and start", st.find((i) => i.id === "issue-21").working?.kind === "fix" && st.find((i) => i.id === "disc-34").working === undefined, st.find((i) => i.id === "issue-21").working);
rmSync(join(home, "state", "claims", "issue-21.fix.json"));
await expect("follow_up as agent is queued as start_fix", "issue-21", "r8", { input: { askReporter: true } }, (r) => r.data.ok && r.data.queued);
await expect("a repeated agent click gets 409", "issue-21", "r8", {}, (r) => r.status === 409);

// alsoLabel: the label button next to a prefill reply, and labels right after a bot post
let r;
const labelClick = (instance, itemId, routeId, extra = {}) => api("/api/action", { instance, itemId, routeId, input: { part: "label" }, ...extra });
check("a prefill route with alsoLabel is served as me without labelDone", served["issue-40"].routes[0].actor === "me" && served["issue-40"].routes[0].labelDone === undefined, served["issue-40"].routes[0]);
r = await click("issue-40", "r1");
check("the reply text of a prefill route still stays the maintainer's", refused(/yours to do on GitHub/)(r), r);
r = await labelClick("widgets", "issue-40", "r1", { input: { part: "label", alsoLabel: true } });
check("the label button takes only input.part", r.data.ok === false && /only input.part/.test(r.data.result), r);
r = await labelClick("widgets", "issue-40", "r1", { input: { part: "label", add: ["bug"] } });
check("the label button takes no labels from the client", r.data.ok === false && /unknown field "add"/.test(r.data.result), r);
r = await labelClick("widgets", "issue-40", "r1", { input: { part: "text" } });
check("input.part must name a button", r.data.ok === false && /input.part must be one of label, answer/.test(r.data.result), r);
r = await labelClick("widgets", "issue-40", "r1", { text: "x" });
check("the label button sends no text", r.status === 400, r);
r = await labelClick("widgets", "issue-40", "r4");
check("a route without alsoLabel has no label button", r.data.ok === false && /sets no labels/.test(r.data.result), r);
r = await labelClick("widgets", "issue-41", "r1");
check("the label button refuses a closed thread", r.data.ok === false && r.data.stale === true && /closed/.test(r.data.result), r);
r = await labelClick("widgets", "issue-40", "r1");
check("the label button sets exactly the route's labels as the bot", r.data.ok === true && invocations(r).includes("addLabelsToLabelable") && invocations(r).includes("LA_info") && !invocations(r).includes("removeLabelsFromLabelable") && !invocations(r).includes("addComment"), r);
r = await labelClick("widgets", "issue-40", "r1");
check("a repeat of the label button gets 409", r.status === 409 && r.data.duplicate === true, r);
r = await click("issue-40", "r2");
check("a bot post with alsoLabel sets the labels after the post", r.data.ok === true && /addComment[\s\S]*BOT_ASKS_LOG[\s\S]*addLabelsToLabelable[\s\S]*removeLabelsFromLabelable/.test(invocations(r)), r);
r = await click("issue-40", "r3", { input: { alsoLabel: false } });
check("an unticked label posts only the text", r.data.ok === true && invocations(r).includes("BOT_ASKS_NO_LABEL") && !invocations(r).includes("Labelable"), r);
r = await click("issue-40", "r5");
check("a label failure after a post keeps the post a success", r.data.ok === true && /^Posted\. The label could not be set: .*waiting-for-info/.test(r.data.warning ?? ""), r);
r = await click("issue-40", "r6", { input: { alsoLabel: "yes" } });
check("input.alsoLabel must be a boolean", refused(/input.alsoLabel must be true or false/)(r), r);
r = await click("issue-40", "r7", { input: { alsoLabel: false } });
check("input.alsoLabel needs a route with alsoLabel", refused(/unknown field "alsoLabel"/)(r), r);

// alsoAnswer: the answer button next to a prefill close of a discussion
r = await click("disc-31", "r1");
check("the close itself stays the maintainer's", refused(/yours to do on GitHub/)(r), r);
r = await labelClick("widgets", "disc-31", "r1");
check("a close route has no label button", r.data.ok === false && /sets no labels/.test(r.data.result), r);
r = await labelClick("widgets", "disc-31", "r1", { input: { part: "answer", commentId: "DC_x" } });
check("the answer button takes no comment id from the client", r.data.ok === false && /unknown field "commentId"/.test(r.data.result), r);
r = await labelClick("widgets", "issue-40", "r1", { input: { part: "answer" } });
check("a reply route has no answer button", r.data.ok === false && /marks no answer/.test(r.data.result), r);
r = await labelClick("widgets", "disc-31", "r1", { input: { part: "answer" } });
check("the answer button marks exactly the route's comment as the bot", r.data.ok === true && invocations(r).includes("markDiscussionCommentAsAnswer") && invocations(r).includes("DC_c1"), r);
r = await labelClick("widgets", "disc-31", "r1", { input: { part: "answer" } });
check("a repeat of the answer button gets 409", r.status === 409 && r.data.duplicate === true, r);

// Action log
await new Promise((r) => setTimeout(r, 300));
const docs = readdirSync(join(BOARD, "actions")).map((n) => JSON.parse(readFileSync(join(BOARD, "actions", n), "utf8")));
const byRoute = (itemId, routeId) => docs.filter((d) => d.itemId === itemId && d.routeId === routeId);
const ar = byRoute("pr-12", "r2")[0];
check("address_review doc is queued with decisions", ar?.status === "queued" && ar.action === "address_review" && ar.params.decisions.length === 2 && ar.params.decisions[0].note === "fix it" && ar.text === "Run note", ar);
const sf = byRoute("issue-21", "r8")[0];
check("start_fix doc carries text, finding and the switch he set", sf?.action === "start_fix" && sf.text === "Use a mock node" && JSON.stringify(sf.params) === '{"finding":"f2","askReporter":true}', sf);
const ev18 = byRoute("pr-18", "r1").find((a) => a.status === "done");
check("the review goes out with the event he picked", ev18?.status === "done" && ev18.params.event === "comment" && ev18.params.comments.length === 1, ev18);
check("a changed review event is logged for learning", readFileSync(join(home, "state", "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).some((e) => e.type === "changed_event" && e.itemId === "pr-18" && e.from === "request_changes" && e.to === "comment" && e.route.type === "review"));
check("drive doc", byRoute("pr-13", "r1")[0]?.params?.maxRounds === 3 && byRoute("pr-12", "r11")[0]?.params?.maxRounds === 2, docs.filter((d) => d.action === "drive"));
check("take_over default doc", byRoute("pr-16", "r3")[0]?.action === "take_over" && byRoute("pr-16", "r3")[0]?.params?.mode === "push", byRoute("pr-16", "r3"));
const rv = byRoute("pr-12", "r18")[0];
check("revise doc carries the instructions and no params", rv?.action === "revise" && rv.route === "revise" && rv.via === "queue" && rv.text === "Drop the 0x00c8 file" && JSON.stringify(rv.params) === "{}", rv);
check("a mapped take_over writes a revise doc", byRoute("pr-12", "r8")[0]?.action === "revise" && byRoute("pr-12", "r8")[0].text === "Finish it" && byRoute("pr-12", "r12")[0]?.action === "revise" && byRoute("pr-12", "r12")[0].text === "Do it" && byRoute("pr-17", "r1")[0]?.action === "revise", byRoute("pr-12", "r8"));
const labelDoc = byRoute("issue-40", "r1")[0];
check("the label button writes its own action doc", byRoute("issue-40", "r1").length === 1 && labelDoc.part === "label" && labelDoc.action === "label" && labelDoc.status === "done" && labelDoc.via === "server" && /^[0-9a-f]{16}$/.test(labelDoc.labelHash) && labelDoc.draftHash === undefined && JSON.stringify(labelDoc.params) === '{"add":["needs-info"]}', labelDoc);
check("a bot post doc records the labels too", byRoute("issue-40", "r2")[0]?.status === "done" && byRoute("issue-40", "r2")[0].label?.status === "done" && JSON.stringify(byRoute("issue-40", "r2")[0].label.params) === '{"add":["needs-info"],"remove":["bug"]}', byRoute("issue-40", "r2"));
check("a failed label is recorded next to the done post", byRoute("issue-40", "r5")[0]?.status === "done" && byRoute("issue-40", "r5")[0].label?.status === "failed" && /waiting-for-info/.test(byRoute("issue-40", "r5")[0].label.result), byRoute("issue-40", "r5"));
check("an unticked label records no label run", byRoute("issue-40", "r3")[0]?.status === "done" && byRoute("issue-40", "r3")[0].label === undefined, byRoute("issue-40", "r3"));
const wLog = readFileSync(join(home, "state", "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.itemId === "issue-40");
check("unticking the label logs skipped_label with the route and the labels", wLog.some((e) => e.type === "skipped_label" && e.route.type === "request_logs" && e.route.title === "Ask: log, no label" && JSON.stringify(e.labels) === '{"add":["needs-info"]}'), wLog);
check("the label button logs no decision", !wLog.some((e) => e.chosen?.title === "Reply: ask for a log" || e.route?.title === "Reply: ask for a log") && wLog.filter((e) => e.type === "skipped_label").length === 1, wLog);
const fmt = byRoute("pr-14", "r3")[0];
check("format doc is queued with the reviewed head", ["queued", "done"].includes(fmt?.status) && fmt.via === "queue" && fmt.action === "format" && JSON.stringify(fmt.params) === `{"reviewedSha":"${"c".repeat(40)}"}`, fmt);
check("format does not take the PR over", JSON.parse(readFileSync(join(BOARD, "items", "pr-14.json"), "utf8")).takenOver === undefined);
check("take_over doc carries the text", byRoute("pr-16", "r2")[0]?.text === "Finish it", byRoute("pr-16", "r2"));
check("take_over doc", byRoute("pr-16", "r2")[0]?.action === "take_over" && byRoute("pr-16", "r2")[0]?.params?.mode === "push", byRoute("pr-16", "r2"));
check("bot route doc is done via server", byRoute("issue-21", "r2")[0]?.status === "done" && byRoute("issue-21", "r2")[0]?.via === "server", byRoute("issue-21", "r2"));
check("edited flag", byRoute("issue-21", "r9")[0]?.edited === true && byRoute("issue-21", "r5")[0]?.edited === false, docs);
check("refused routes are not logged", byRoute("pr-12", "r3").length === 0 && byRoute("pr-12", "r4").length === 0 && byRoute("issue-21", "r3").length === 0);
check("each click logged once", byRoute("pr-12", "r1").length === 1, byRoute("pr-12", "r1"));

const after = Object.fromEntries((await api("/api/state")).data.items.filter((i) => i.instance === "widgets").map((i) => [i.id, i]));
const r1 = after["pr-12"].routes.find((r) => r.id === "r1");
check("state marks a ran route as done", r1.done?.status === "done", r1);
check("state marks a queued route", after["pr-12"].routes.find((r) => r.id === "r2").done?.status === "queued");
check("state serves answerDone", after["disc-31"].routes[0].answerDone?.status === "done" && after["disc-31"].routes[0].labelDone === undefined, after["disc-31"].routes[0]);
const answerDoc = byRoute("disc-31", "r1")[0];
check("the answer button writes its own action doc", answerDoc?.part === "answer" && answerDoc.action === "answer_discussion" && /^[0-9a-f]{16}$/.test(answerDoc.answerHash) && JSON.stringify(answerDoc.params) === '{"commentId":"DC_c1"}', answerDoc);
const labelled = after["issue-40"].routes[0];
check("state serves labelDone next to done", labelled.labelDone?.status === "done" && typeof labelled.labelDone.result === "string" && labelled.done === undefined, labelled);


// handled and the refresh
const itemNow = (id) => JSON.parse(readFileSync(join(BOARD, "items", id + ".json"), "utf8"));
check("a bot post sets handled to commented", itemNow("issue-40").handled?.routeId === "r5" && itemNow("issue-40").handled.routeType === "request_logs" && itemNow("issue-40").handled.verified === "commented", itemNow("issue-40").handled);
check("a queued agent job sets handled unchecked", itemNow("pr-12").handled?.routeType === "address_review" && itemNow("pr-12").handled.verified === null, itemNow("pr-12").handled);
check("the answer button sets handled", itemNow("disc-31").handled?.routeType === "close" && itemNow("disc-31").handled.verified === null, itemNow("disc-31").handled);
for (const id of ["issue-60", "issue-61", "disc-62", "pr-63"]) await api("/api/decision", { instance: "widgets", itemId: id, routeId: "r1" });
await sleep(100);
const h60 = itemNow("issue-60").handled;
check("a reported prefill sets handled with verified null", h60?.routeId === "r1" && h60.routeType === "reply" && h60.verified === null && Date.parse(h60.at) > Date.now() - 10000, h60);

// Every prefill button he used is kept per route and served on the route
const docsNow = () => readdirSync(join(BOARD, "actions")).map((n) => JSON.parse(readFileSync(join(BOARD, "actions", n), "utf8")));
const route64 = async (rid) => (await api("/api/state")).data.items.find((i) => i.instance === "widgets" && i.id === "issue-64").routes.find((x) => x.id === rid);
const openedStore = () => JSON.parse(readFileSync(join(home, "state", "opened.json"), "utf8"));
check("a route he did not use carries no opened mark", (await route64("r1")).opened === undefined);
await api("/api/decision", { instance: "widgets", itemId: "issue-64", routeId: "r1", text: "Edited reply" });
let o64 = await route64("r1");
check("a reported prefill is served as opened with its time", Date.parse(o64.opened?.at) > Date.now() - 10000 && Object.keys(o64.opened).join() === "at" && o64.done === undefined, o64);
check("the server keeps the copied text with the mark", openedStore()["issue-64"].r1.text === "Edited reply" && /^[0-9a-f]{16}$/.test(openedStore()["issue-64"].r1.draftHash), openedStore());
const firstAt = o64.opened.at;
await sleep(20);
await api("/api/decision", { instance: "widgets", itemId: "issue-64", routeId: "r2", text: "Closing." });
check("a second prefill on the item keeps the first mark", (await route64("r1")).opened?.at === firstAt && !!(await route64("r2")).opened, await route64("r1"));
await api("/api/action", { instance: "widgets", itemId: "issue-64", routeId: "r3", draftHash: (await route64("r3")).draftHash });
check("a fix started without the switch asks nobody", docsNow().find((a) => a.itemId === "issue-64" && a.action === "start_fix")?.params.askReporter === false);
check("an agent click on the item replaces handled and keeps the opened mark", itemNow("issue-64").handled?.routeId === "r3" && (await route64("r1")).opened?.at === firstAt && (await route64("r3")).opened === undefined, itemNow("issue-64").handled);
await api("/api/decision", { instance: "widgets", itemId: "issue-64", routeId: "r1", text: "Edited again" });
check("copying again moves the time", (await route64("r1")).opened.at > firstAt && openedStore()["issue-64"].r1.text === "Edited again");
writeFileSync(join(BOARD, "items", "issue-64.json"), JSON.stringify({ ...itemNow("issue-64"), routes: itemNow("issue-64").routes.map((x) => (x.id === "r1" ? { ...x, text: "Rewritten by the routine" } : x)) }));
await sleep(400);
check("a rewritten draft clears its mark, the other route keeps its own", (await route64("r1")).opened === undefined && !!(await route64("r2")).opened, await route64("r1"));
await api("/api/decision", { instance: "widgets", itemId: "issue-64", routeId: "r2", text: "Closing." });
check("the next click drops the stored mark of the old draft", openedStore()["issue-64"].r1 === undefined && !!openedStore()["issue-64"].r2, openedStore()["issue-64"]);
r = await api("/api/decision", { instance: "widgets", itemId: "issue-64", routeId: "r9" });
check("a decision for an unknown route stores nothing", r.data.outdated === true && openedStore()["issue-64"].r9 === undefined, r);

const soon = new Date(Date.now() + 60000).toISOString();
writeFileSync(ghOverrides, JSON.stringify({
	"issue-23": { state: "CLOSED" },
	"disc-35": { timelineComments: { totalCount: 1, nodes: [{ id: "DC_new", author: { login: "octocat", __typename: "User" }, createdAt: soon, body: "Done", url: "https://github.com/acme/widgets/discussions/35#discussioncomment-900" }] } },
	"pr-18": { state: "MERGED", mergeable: "CONFLICTING", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } },
}));
const refresh = (itemId, instance = "widgets") => api("/api/refresh", { instance, itemId });
r = await refresh("issue-60");
check("a refresh without a change says unchanged", r.status === 200 && r.data.ok && r.data.result.verified === "unchanged" && r.data.result.state === "open" && itemNow("issue-60").handled.verified === "unchanged" && itemNow("issue-60").live === undefined, r);
r = await refresh("issue-60");
check("a second refresh of the item within 20 s gets 429 with a retry hint", r.status === 429 && r.data.retryAfter > 0 && r.data.retryAfter <= 20, r);
r = await refresh("issue-61");
check("a thread closed after the click is verified closed and served live", r.data.ok && r.data.result.verified === "closed" && itemNow("issue-61").live?.state === "closed" && typeof itemNow("issue-61").live.checkedAt === "string", r);
r = await refresh("disc-62");
check("our comment after the click is verified commented", r.data.ok && r.data.result.verified === "commented" && itemNow("disc-62").lastEventUrl === "https://github.com/acme/widgets/discussions/35#discussioncomment-900", { r, item: itemNow("disc-62") });
r = await refresh("pr-63");
const p63 = itemNow("pr-63");
check("a merged PR is verified merged and its GitHub fields refreshed", r.data.ok && r.data.result.verified === "merged" && p63.live?.state === "merged" && p63.mergeable === "conflicting" && p63.ci === "failing" && p63.title === "refresh merged" && p63.routes.length === 1, p63);
const refreshedItems = (await api("/api/state")).data.items.filter((i) => i.instance === "widgets");
check("the state serves live and handled", refreshedItems.find((i) => i.id === "issue-61").live?.state === "closed" && refreshedItems.find((i) => i.id === "issue-60").handled?.verified === "unchanged");
r = await refresh("issue-70");
check("a refresh of an item without handled only refreshes the fields", r.data.ok && r.data.result.verified === undefined && itemNow("issue-70").handled === undefined, r);

// The timeline since his last choice comes from the snapshot's activity and his clicks
const snapFile = join(home, "state", "snapshot.json");
const hAt = Date.parse(itemNow("issue-60").handled.at);
const iso = (ms) => new Date(ms).toISOString();
writeFileSync(snapFile, JSON.stringify({ items: {
	"issue-60": { activity: { events: [
		{ at: iso(hAt - 60000), by: "hubot", side: "them", kind: "comment" },
		{ at: iso(hAt + 60000), by: "hubot", side: "them", kind: "comment", asks: true },
		{ at: iso(hAt + 120000), by: "hubot", side: "them", kind: "comment" },
	], openThreads: [], ci: [] } },
	"issue-70": { activity: { events: [{ at: iso(Date.now() - 3600000), by: "hubot", side: "them", kind: "comment" }], openThreads: [], ci: [] } },
} }));
const sinceOf = async (id) => (await api("/api/state")).data.items.find((i) => i.instance === "widgets" && i.id === id).since;
let since = await sinceOf("issue-60");
check("the timeline starts at his last choice and groups the comments after it", since?.anchor.kind === "choice" && since.anchor.label === "Reply" && since.groups.length === 1 && since.groups[0].text === "hubot wrote 2 comments" && since.groups[0].note === "asked you something, no answer yet", since);
check("an item he never chose on or opened has no timeline", (await sinceOf("issue-70")) === undefined);
const seen = iso(Date.now() - 60000);
r = await api("/api/db", { op: "update", path: "items/widgets/issue-70", data: { seenAt: seen } });
since = await sinceOf("issue-70");
check("the open time the page stores becomes the anchor", r.status === 200 && since?.anchor.kind === "opened" && since.anchor.at === seen && since.groups.length === 0, since);
rmSync(snapFile, { force: true });
const before = readFileSync(ghLog, "utf8").length;
let last;
for (let k = 71; k < 100 && (!last || last.status !== 429); k++) last = await refresh(`issue-${k}`);
check("more than 30 refreshes a minute get 429", last.status === 429 && last.data.retryAfter > 0 && last.data.retryAfter <= 60, last);
check("a refresh never writes to GitHub", !readFileSync(ghLog, "utf8").slice(before).includes("mutation"));
r = await refresh("issue-60", "nope");
check("a refresh needs a served instance", r.status === 400, r);
writeFileSync(ghOverrides, "{}");

// Suggestions in inline review comments
check("a suggestion follows the text after a blank line", commentBody({ text: "Use const", suggestion: "const a = 1;" }) === "Use const\n\n```suggestion\nconst a = 1;\n```", commentBody({ text: "Use const", suggestion: "const a = 1;" }));
const fenced = commentBody({ text: "x", suggestion: "```js\ny\n```" });
check("a suggestion with a fence line gets a longer fence", fenced === "x\n\n````suggestion\n```js\ny\n```\n````", fenced);
check("a longer backtick run gets a fence one longer", commentBody({ text: "x", suggestion: "`````\n" }).startsWith("x\n\n``````suggestion\n"));
check("an old doc with the fence in its text is sent unchanged", commentBody({ text: "Old\n```suggestion\ny\n```" }) === "Old\n```suggestion\ny\n```");
const suggested = planRoute(
	{ id: "r1", type: "review", as: "bot", params: { event: "comment", comments: [{ id: "c1", path: "a.ts", line: 3, text: "Rename", original: "let a = 1;", suggestion: "const a = 1;", diffHunk: "@@ -1 +1 @@" }] } },
	{ kind: "pr", number: 12 },
	{},
	"Body",
);
const sent = suggested.steps[0].params.comments[0];
const formatItem = { kind: "pr", number: 9, authorType: "contributor", reviewedSha: "a".repeat(40), autofix: { changes: true, files: 1, lines: 2, tools: ["prettier"] } };
const formatRoute = { id: "r1", type: "format", as: "agent" };
let formatError = "";
try {
	planRoute(formatRoute, formatItem, {}, "", "none");
} catch (e) {
	formatError = e.message;
}
check("format needs a bot or own-token pushes", /needs a bot account, or allowOwnTokenPushes/.test(formatError), formatError);
check("format runs in own mode on a contributor PR", planRoute(formatRoute, formatItem, {}, "", "own").action === "format");
formatError = "";
try {
	planRoute(formatRoute, { ...formatItem, reviewedSha: undefined }, {}, "", "bot");
} catch (e) {
	formatError = e.message;
}
check("format needs the reviewed head", /needs the item's reviewedSha/.test(formatError), formatError);
check("original, suggestion and diffHunk are never sent", JSON.stringify(Object.keys(sent).sort()) === '["line","path","text"]' && sent.text === "Rename\n\n```suggestion\nconst a = 1;\n```", sent);

// Two instances in one server
async function openEvents() {
	const ctrl = new AbortController();
	const res = await fetch(`${base}/api/events?token=${TOKEN}`, { signal: ctrl.signal });
	const events = [];
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	(async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let at;
				while ((at = buf.indexOf("\n\n")) >= 0) {
					const chunk = buf.slice(0, at);
					buf = buf.slice(at + 2);
					const event = /^event: (.+)$/m.exec(chunk)?.[1];
					const data = /^data: (.+)$/m.exec(chunk)?.[1];
					if (event && data) events.push({ event, data: JSON.parse(data) });
				}
			}
		} catch {
			// Aborted by close()
		}
	})();
	const waitFor = async (test, ms = 3000) => {
		for (let t = 0; t < ms; t += 50) {
			const e = events.find(test);
			if (e) return e;
			await sleep(50);
		}
		return null;
	};
	return { events, waitFor, close: () => ctrl.abort() };
}

const health = await (await fetch(base + "/api/health")).json();
check("health lists both instances", health.ok === true && health.name === "gary" && JSON.stringify(health.instances) === '["gadgets","widgets"]', health);
let multi = (await api("/api/state")).data;
const entry = (name) => multi.board.instances.find((i) => i.name === name);
check("board lists one entry per instance", multi.board.instances.length === 2 && entry("gadgets").title === "gadgets" && entry("widgets").title === "widgets" && entry("gadgets").repos[0] === "acme/gadgets" && entry("gadgets").repoUrl === "https://github.com/acme/gadgets" && entry("widgets").kind === "maintainer", multi.board);
check("board carries me and dryRun once", multi.board.me?.login === "octocat" && multi.board.dryRun === true && multi.board.paused === undefined && multi.board.repo === undefined, multi.board);
check("an instance entry carries accounts and profile facts", entry("gadgets").bot?.login === "widgets-bot" && entry("gadgets").accountMode === "bot" && entry("gadgets").paused === false && entry("gadgets").relatedRepos.includes("widgets-desktop") && entry("gadgets").reviewBots.includes("copilot") && !!entry("gadgets").botCommands.escalate, entry("gadgets"));
const itemOf = (name, id) => multi.items.find((i) => i.instance === name && i.id === id);
check("items of both instances are served with instance, id, ref and repo", itemOf("gadgets", "pr-12")?.ref === "acme/gadgets#12" && itemOf("widgets", "pr-12")?.ref === "acme/widgets#12" && itemOf("gadgets", "pr-12").repo === "acme/gadgets" && itemOf("gadgets", "pr-12").title === "gadgets PR", multi.items.map((i) => [i.instance, i.id, i.ref]));
check("an item without a repo is served with ref null", itemOf("widgets", "issue-25")?.ref === null && itemOf("widgets", "issue-25").repo === null);
check("state has no actions and meta", multi.actions === undefined && multi.meta === undefined && Object.keys(multi).sort().join() === "board,items,proposals");

const gHash = (id, routeId) => itemOf("gadgets", id).routes.find((r) => r.id === routeId).draftHash;
r = await api("/api/action", { instance: "widgets", itemId: "issue-90", routeId: "r1", draftHash: gHash("issue-90", "r1") });
check("an item id of gadgets is outdated on widgets", r.data.ok === false && r.data.outdated === true, r);
r = await api("/api/action", { instance: "widgets", itemId: "pr-12", routeId: "r4", draftHash: gHash("pr-12", "r1") });
check("a draft hash of gadgets' pr-12 does not run widgets' pr-12", r.data.ok === false && r.data.outdated === true, r);
r = await api("/api/action", { instance: "gadgets", itemId: "issue-91", routeId: "r1", draftHash: gHash("issue-91", "r1") });
check("a widgets repo item stored in gadgets is refused", r.data.ok === false && /acme\/widgets is not a repository of instance gadgets/.test(r.data.result), r);

const sse = await openEvents();
check("the event stream opens with the full board", !!(await sse.waitFor((e) => e.event === "board" && e.data.board?.instances?.length === 2)), sse.events.map((e) => e.event));
for (const event of ["items", "actions", "proposals", "meta"]) {
	const got = (name) => sse.events.some((e) => e.event === event && e.data.instance === name);
	await sse.waitFor((e) => e.event === event && e.data.instance === "widgets");
	check(`the stream sends ${event} of each instance`, got("widgets") && got("gadgets"), sse.events.filter((e) => e.event === event).map((e) => e.data.instance));
}
check("meta events carry the instance's meta", sse.events.some((e) => e.event === "meta" && e.data.instance === "gadgets" && e.data.data?.lastRunSummary === "gadgets run"));
check("item events carry instance and ref per doc", sse.events.some((e) => e.event === "items" && e.data.instance === "gadgets" && e.data.docs.some((d) => d.instance === "gadgets" && d.ref === "acme/gadgets#90")));

// Pause one instance
sse.events.length = 0;
writeFileSync(join(gadgets.home, "state", "control.json"), JSON.stringify({ paused: true }));
const paused = await sse.waitFor((e) => e.event === "board" && e.data.instance === "gadgets");
check("pausing gadgets sends a board event that names it", paused?.data.board.instances.find((i) => i.name === "gadgets").paused === true && paused.data.board.instances.find((i) => i.name === "widgets").paused === false, paused);
multi = (await api("/api/state")).data;
check("only gadgets shows paused", entry("gadgets").paused === true && entry("widgets").paused === false);
r = await api("/api/action", { instance: "gadgets", itemId: "pr-12", routeId: "r1", draftHash: gHash("pr-12", "r1") });
check("a gadgets bot click is refused while gadgets is paused", r.data.ok === false && r.data.paused === true, r);
r = await labelClick("gadgets", "issue-92", "r1");
check("the label button is refused while paused", r.data.ok === false && r.data.paused === true, r);
r = await labelClick("gadgets", "disc-95", "r1", { input: { part: "answer" } });
check("the answer button is refused while paused", r.data.ok === false && r.data.paused === true, r);
r = await api("/api/action", { instance: "widgets", itemId: "issue-30", routeId: "r1", draftHash: itemOf("widgets", "issue-30").routes[0].draftHash });
check("a widgets bot click still runs", r.data.ok === true && JSON.stringify(r.data.result.invocations).includes("Hi from widgets"), r);
writeFileSync(join(gadgets.home, "state", "control.json"), JSON.stringify({ paused: false }));
await sleep(300);
r = await api("/api/action", { instance: "gadgets", itemId: "pr-12", routeId: "r1", draftHash: gHash("pr-12", "r1") });
check("after resume the gadgets click runs against its own item", r.data.ok === true && JSON.stringify(r.data.result.invocations).includes("Hi from gadgets"), r);
writeFileSync(ghLog, "");
r = await labelClick("gadgets", "issue-92", "r1");
const labelLookups = readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).stdin).filter((q) => q.includes("label(name:"));
check("the label button of a gadgets item labels in acme/gadgets", r.data.ok === true && labelLookups.length > 0 && labelLookups.every((q) => JSON.parse(q).variables.owner === "acme" && JSON.parse(q).variables.name === "gadgets"), { r, labelLookups });
const gConfig = join(gadgets.home, "config.json");
const gConfigText = readFileSync(gConfig, "utf8");
writeFileSync(gConfig, JSON.stringify({ ...JSON.parse(gConfigText), bot: null }));
await sleep(300);
r = await labelClick("gadgets", "issue-93", "r1");
check("the label button needs a bot or own-token pushes", r.data.ok === false && /needs a bot account, or allowOwnTokenPushes/.test(r.data.result), r);
r = await labelClick("gadgets", "disc-95", "r1", { input: { part: "answer" } });
check("the answer button needs a bot or own-token pushes", r.data.ok === false && /Marking the answer needs a bot account/.test(r.data.result), r);
writeFileSync(gConfig, JSON.stringify({ ...JSON.parse(gConfigText), bot: null, allowOwnTokenPushes: true }));
await sleep(300);
r = await labelClick("gadgets", "issue-93", "r1");
check("the label button runs under the own login in own mode", r.data.ok === true && invocations(r).includes("removeLabelsFromLabelable"), r);
writeFileSync(gConfig, gConfigText);
await sleep(300);
r = await api("/api/action", { instance: "gadgets", itemId: "pr-12", routeId: "r1", draftHash: gHash("pr-12", "r1") });
check("a repeat on gadgets gets 409", r.status === 409, r);
r = await api("/api/action", { instance: "widgets", itemId: "issue-30", routeId: "r1", draftHash: itemOf("widgets", "issue-30").routes[0].draftHash });
check("the repeat lock is per instance", r.status === 409, r);

// Separate state
await sleep(200);
const docsIn = (board) => readdirSync(join(board, "actions")).map((n) => JSON.parse(readFileSync(join(board, "actions", n), "utf8")));
check("the gadgets click wrote its action doc to gadgets only", docsIn(GBOARD).some((d) => d.itemId === "pr-12" && d.status === "done") && !docsIn(BOARD).some((d) => JSON.stringify(d).includes("Hi from gadgets")), docsIn(GBOARD));
multi = (await api("/api/state")).data;
check("served done marks stay per instance", itemOf("gadgets", "pr-12").routes[0].done?.status === "done" && itemOf("widgets", "pr-12").routes[0].done?.status === "done" && itemOf("gadgets", "issue-90").routes[0].done === undefined);
r = await api("/api/action", { instance: "gadgets", action: "dismiss_route", itemId: "issue-90", routeId: "r2", text: "No logs" });
check("dismiss_route on gadgets runs", r.data.ok === true, r);
r = await api("/api/action", { instance: "widgets", action: "dismiss_route", itemId: "issue-90", routeId: "r1" });
check("dismiss_route of a gadgets id on widgets is outdated", r.data.outdated === true, r);
await sleep(100);
const logIn = (h) => {
	try {
		return readFileSync(join(h, "state", "decisions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};
const gLog = logIn(gadgets.home);
check("the gadgets decision log names instance, kind and repo", gLog.some((e) => e.type === "dismissed_route" && e.instance === "gadgets" && e.instanceKind === "maintainer" && e.repo === "acme/gadgets" && e.itemId === "issue-90"), gLog);
check("the widgets decision log has no gadgets entry", logIn(home).every((e) => e.instance === "widgets"), logIn(home).filter((e) => e.instance !== "widgets"));
r = await api("/api/decision", { instance: "nope", itemId: "pr-12", routeId: "r1" });
check("/api/decision refuses an unknown instance", r.status === 400, r);
r = await api("/api/decision", { itemId: "pr-12", routeId: "r1" });
check("/api/decision refuses a missing instance", r.status === 400, r);

// /api/db: the instance in the body or in the path
r = await api("/api/db", { instance: "gadgets", op: "update", path: "items/issue-90", data: { priority: 3 } });
check("a db write with the instance in the body lands in that instance", r.status === 200 && JSON.parse(readFileSync(join(GBOARD, "items", "issue-90.json"), "utf8")).priority === 3, r);
r = await api("/api/db", { op: "update", path: "items/gadgets/issue-90", data: { priority: 4, instance: "gadgets", ref: "acme/gadgets#90" } });
const stored = JSON.parse(readFileSync(join(GBOARD, "items", "issue-90.json"), "utf8"));
check("a db write with the instance in the path lands there and drops served-only fields", r.status === 200 && stored.priority === 4 && stored.instance === undefined && stored.ref === undefined, { r, stored });
r = await api("/api/db", { op: "set", path: "actions/gadgets/issue-90-1", data: { itemId: "gadgets/issue-90", action: "reanalyze", text: "Look again", status: "queued", via: "queue", createdAt: new Date().toISOString() } });
check("a page reanalyze doc stores the plain item id", r.status === 200 && JSON.parse(readFileSync(join(GBOARD, "actions", "issue-90-1.json"), "utf8")).itemId === "issue-90", r);
await sleep(100);
check("the page's note is logged in gadgets", logIn(gadgets.home).some((e) => e.type === "agent_note" && e.itemId === "issue-90" && e.text === "Look again"));
r = await api("/api/db", { op: "set", path: "meta/gadgets", data: { lastRunSummary: "set through the path" } });
check("meta/<instance> writes that instance's meta", r.status === 200 && JSON.parse(readFileSync(join(GBOARD, "meta.json"), "utf8")).lastRunSummary === "set through the path", r);
r = await api("/api/db", { instance: "widgets", op: "update", path: "items/gadgets/issue-90", data: { priority: 1 } });
check("a db write whose body and path disagree is refused", r.status === 400, r);
for (const body of [{ op: "update", path: "items/issue-90", data: {} }, { instance: "nope", op: "update", path: "items/issue-90", data: {} }, { op: "update", path: "items/../issue-90", data: {} }, { op: "set", path: "meta/../widgets", data: {} }]) {
	r = await api("/api/db", body);
	check(`a db write without a known instance is refused: ${body.path}`, r.status === 400, r);
}

// Settings edits apply without a restart, also in a profile outside the root
const editJson = (file, change) => {
	const tmp = file + ".tmp";
	writeFileSync(tmp, JSON.stringify(change(JSON.parse(readFileSync(file, "utf8")))));
	renameSync(tmp, file);
};
const entryTitle = (e) => e?.data.board.instances.find((i) => i.name === "gadgets")?.title;
const relatedOf = (e) => e?.data.board.instances.find((i) => i.name === "gadgets")?.relatedRepos ?? [];
sse.events.length = 0;
editJson(join(T, "profile-gadgets", "profile.json"), (p) => ({ ...p, relatedRepos: ["gadgets-cloud"] }));
let edited = await sse.waitFor((e) => e.event === "board" && relatedOf(e).includes("gadgets-cloud"));
check("a profile edit sends a board event with the new relatedRepos", !!edited, sse.events.filter((e) => e.event === "board").map(relatedOf));
const otherProfile = profileFor("gadgets-two", "acme/gadgets");
editJson(join(gadgets.home, "config.json"), (c) => ({ ...c, profile: otherProfile }));
check("pointing the config to another profile sends a board event", !!(await sse.waitFor((e) => e.event === "board" && entryTitle(e) === "gadgets-two")), sse.events.filter((e) => e.event === "board").map(entryTitle));
sse.events.length = 0;
await sleep(300);
editJson(join(otherProfile, "profile.json"), (p) => ({ ...p, relatedRepos: ["gadgets-two-cloud"] }));
edited = await sse.waitFor((e) => e.event === "board" && relatedOf(e).includes("gadgets-two-cloud"));
check("the watcher follows the new profile", !!edited, sse.events.filter((e) => e.event === "board").map(relatedOf));
sse.events.length = 0;
editJson(join(T, "profile-gadgets", "profile.json"), (p) => ({ ...p, relatedRepos: ["stale"] }));
await sleep(600);
check("the old profile is no longer watched", !sse.events.some((e) => e.event === "board" && e.data.instance === "gadgets"), sse.events.map((e) => [e.event, e.data.instance]));


// Invalid settings keep the instance served with its last valid settings
const gadgetsOf = (e) => e?.data.board.instances.find((i) => i.name === "gadgets");
const servedNow = async () => (await api("/api/state")).data;
const brokenProfile = join(otherProfile, "profile.json");
const goodProfile = readFileSync(brokenProfile, "utf8");
const configStat = statSync(join(gadgets.home, "config.json")).mtimeMs;
writeFileSync(brokenProfile, JSON.stringify({ ...JSON.parse(goodProfile), colour: "red" }));
await sleep(600);
multi = await servedNow();
check("with an unknown profile field gadgets is still listed with its items", !!entry("gadgets") && !!itemOf("gadgets", "issue-90"), multi.board.instances.map((i) => [i.name, i.settingsError]));
check("an unknown field is a warning, not an error", entry("gadgets").settingsError === undefined && entry("gadgets").settingsWarnings?.some((w) => /unknown field "colour"/.test(w)), entry("gadgets"));
sse.events.length = 0;
editJson(brokenProfile, (p) => ({ ...p, colour: undefined, repo: "not a repo" }));
let broken = await sse.waitFor((e) => e.event === "board" && /"repo" must look like/.test(gadgetsOf(e)?.settingsError ?? ""));
check("an invalid profile value sends a board event with the error", !!broken, sse.events.filter((e) => e.event === "board").map((e) => gadgetsOf(e)?.settingsError));
multi = await servedNow();
check("the instance keeps its last valid settings and items", entry("gadgets")?.repos[0] === "acme/gadgets" && itemOf("gadgets", "issue-90")?.ref === "acme/gadgets#90", entry("gadgets"));
check("health still lists it", (await (await fetch(base + "/api/health")).json()).instances.includes("gadgets"));
r = await api("/api/action", { instance: "gadgets", itemId: "issue-90", routeId: "r1", draftHash: gHash("issue-90", "r1") });
check("a bot click is refused with the settings error", r.data.ok === false && /settings of gadgets are invalid/.test(r.data.result) && /"repo" must look like/.test(r.data.settingsError), r);
r = await labelClick("gadgets", "issue-93", "r1");
check("the label button is refused with the settings error", r.data.ok === false && /settings of gadgets are invalid/.test(r.data.result), r);
r = await labelClick("gadgets", "disc-95", "r1", { input: { part: "answer" } });
check("the answer button is refused with the settings error", r.data.ok === false && /settings of gadgets are invalid/.test(r.data.result), r);
r = await api("/api/db", { instance: "gadgets", op: "update", path: "items/issue-90", data: { priority: 2 } });
check("board-only writes keep working", r.status === 200, r);
r = await api("/api/action", { instance: "gadgets", action: "dismiss_proposal", proposalId: "learn-none" });
check("board-only actions keep working", r.status === 200 && !/settings/.test(r.data.result), r);
sse.events.length = 0;
writeFileSync(brokenProfile, "{ broken");
broken = await sse.waitFor((e) => e.event === "board" && /not valid JSON/.test(gadgetsOf(e)?.settingsError ?? ""));
check("invalid JSON in place changes the error", !!broken, sse.events.filter((e) => e.event === "board").map((e) => gadgetsOf(e)?.settingsError));
multi = await servedNow();
check("items stay served with invalid JSON", !!itemOf("gadgets", "issue-90") && entry("gadgets").title === "gadgets-two", entry("gadgets"));
sse.events.length = 0;
const tmpProfile = brokenProfile + ".tmp";
writeFileSync(tmpProfile, goodProfile);
renameSync(tmpProfile, brokenProfile);
const cleared = await sse.waitFor((e) => e.event === "board" && gadgetsOf(e) && gadgetsOf(e).settingsError === undefined);
check("repairing the profile clears the error", !!cleared, sse.events.filter((e) => e.event === "board").map((e) => gadgetsOf(e)?.settingsError));
check("without touching config.json", statSync(join(gadgets.home, "config.json")).mtimeMs === configStat);
r = await api("/api/action", { instance: "gadgets", itemId: "issue-90", routeId: "r1", draftHash: (await servedNow()).items.find((i) => i.instance === "gadgets" && i.id === "issue-90").routes[0].draftHash });
check("clicks are no longer refused for the settings", r.data.settingsError === undefined && !/settings/.test(r.data.result ?? ""), r);
check("the log names the error and its end", /settings of gadgets are invalid/.test(readFileSync(join(root, "state", "server.log"), "utf8")) && /settings of gadgets are valid again/.test(readFileSync(join(root, "state", "server.log"), "utf8")));

// An instance that was never valid is listed with its error and no items
sse.events.length = 0;
const neverHome = join(root, "instances", "never");
mkdirSync(join(neverHome, "state", "board", "items"), { recursive: true });
writeFileSync(join(neverHome, "state", "board", "items", "issue-1.json"), JSON.stringify({ kind: "issue", repo: "acme/never", number: 1, title: "x", routes: [{ id: "r1", type: "reply", as: "bot", text: "x" }] }));
writeFileSync(join(neverHome, "config.json"), "{ not json");
const never = await sse.waitFor((e) => e.event === "board" && e.data.board.instances.some((i) => i.name === "never"));
const neverEntry = never?.data.board.instances.find((i) => i.name === "never");
check("a never valid instance is listed with its error", /not valid JSON/.test(neverEntry?.settingsError ?? "") && neverEntry.repos.length === 0, neverEntry);
multi = await servedNow();
check("and serves no items", !multi.items.some((i) => i.instance === "never"));
r = await api("/api/action", { instance: "never", itemId: "issue-1", routeId: "r1" });
check("a click on it is refused with the error", r.data.ok === false && /not valid JSON/.test(r.data.settingsError ?? ""), r);
rmSync(neverHome, { recursive: true, force: true });
await sleep(400);

// A new instance appears while the server runs
sse.events.length = 0;
const third = makeHome(T, { profile: profileFor("third", "acme/third") }, "third");
writeFileSync(join(third.home, "state", "board", "items", "issue-5.json"), JSON.stringify({ kind: "issue", repo: "acme/third", number: 22, title: "third", reviewedAt, hint: "Reply: x", routes: [{ id: "r1", type: "reply", title: "Reply: x", as: "bot", recommended: true, text: "Hi from third" }] }));
const added = await sse.waitFor((e) => e.event === "board" && e.data.instance === "third");
check("a new instance sends a board event that names it", added?.data.board.instances.some((i) => i.name === "third" && i.title === "third"), sse.events.map((e) => [e.event, e.data.instance]));
check("then its items", !!(await sse.waitFor((e) => e.event === "items" && e.data.instance === "third" && e.data.docs.some((d) => d.id === "issue-5"))));
check("health lists the new instance", (await (await fetch(base + "/api/health")).json()).instances.includes("third"));
multi = (await api("/api/state")).data;
r = await api("/api/action", { instance: "third", itemId: "issue-5", routeId: "r1", draftHash: itemOf("third", "issue-5").routes[0].draftHash, force: true });
check("a click on the new instance runs", r.data.ok === true && JSON.stringify(r.data.result.invocations).includes("Hi from third"), r);

// A directory without config.json is no instance, and removing one stops serving it
mkdirSync(join(root, "instances", "ghost", "state", "board", "items"), { recursive: true });
r = await api("/api/action", { instance: "ghost", itemId: "issue-5", routeId: "r1" });
check("a directory without config.json is an unknown instance", r.status === 400, r);
sse.events.length = 0;
rmSync(third.home, { recursive: true, force: true });
const removed = await sse.waitFor((e) => e.event === "board" && e.data.instance === "third");
check("removing an instance sends a board event without it", removed && !removed.data.board.instances.some((i) => i.name === "third"), sse.events.map((e) => [e.event, e.data.instance]));
check("and empty collections for it", !!(await sse.waitFor((e) => e.event === "items" && e.data.instance === "third" && e.data.docs.length === 0)));
r = await api("/api/action", { instance: "third", itemId: "issue-5", routeId: "r1" });
check("a removed instance is unknown", r.status === 400, r);
sse.close();

// One server-wide token and log
check("the token lives in the root state only", readdirSync(join(home, "state")).every((n) => n !== "server-token"));
check("the server log is in the root state", /Serving instance gadgets/.test(readFileSync(join(root, "state", "server.log"), "utf8")));
const pageHtml = await (await fetch(base + "/")).text();
check("the page shim carries the board with every instance", pageHtml.includes('"instances":[{"name":"gadgets"') && pageHtml.includes('"name":"widgets"'));
r = await fetch(base + "/api/state", { headers: { "X-Board-Token": TOKEN, Origin: "http://evil.example" } });
check("a foreign origin is refused", r.status === 403);
const hostStatus = await new Promise((resolve) => get({ host: "127.0.0.1", port: PORT, path: "/api/state", headers: { "X-Board-Token": TOKEN, Host: `example.com:${PORT}` } }, (res) => resolve(res.statusCode)).on("error", () => resolve(null)));
check("a foreign host is refused", hostStatus === 421, hostStatus);
r = await fetch(base + "/api/action", { method: "POST", headers: { "X-Board-Token": TOKEN, "Content-Type": "text/plain" }, body: "{}" });
check("a non-JSON body is refused", r.status === 415);
r = await fetch(base + "/api/action", { method: "POST", headers: { "X-Board-Token": TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ instance: "widgets", text: "x".repeat(300 * 1024) }) });
check("a body over 256 KB is refused", r.status === 413);
r = await fetch(base + "/api/state");
check("a request without the token is refused", r.status === 401);

child.kill("SIGTERM");
removeDir(T);
console.log(`server: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
