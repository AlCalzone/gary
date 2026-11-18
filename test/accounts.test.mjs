// The account modes of server/server.mjs on temp homes in dry-run mode, with the fake gh.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, freePort, makeHome as baseHome, removeDir, tempDir } from "./lib.mjs";

const T = tempDir();

const reviewedAt = "2026-11-17T14:00:00Z";
const items = {
	"pr-12": {
		kind: "pr", number: 12, title: "t", authorType: "maintainer", reviewedAt, hint: "Reply: x",
		threads: [{ id: "PRRT_1", verdict: "valid" }],
		routes: [
			{ id: "reply", type: "reply", as: "bot", text: "Thanks", recommended: true },
			{ id: "logs", type: "request_logs", as: "bot", text: "Please send a log" },
			{ id: "body", type: "review", as: "bot", params: { event: "approve" }, text: "LGTM" },
			{ id: "inline", type: "review", as: "bot", params: { event: "comment", comments: [{ id: "c1", path: "a.ts", line: 3, text: "x" }] } },
			{ id: "label", type: "chore", as: "bot", params: { action: "label", add: ["bug"] } },
			{ id: "fix", type: "address_review", as: "agent" },
			{ id: "drive", type: "drive", as: "agent" },
			{ id: "merge", type: "merge", as: "me" },
			{ id: "melogs", type: "request_logs", as: "me", text: "Please send a log" },
			{ id: "mebody", type: "review", as: "me", params: { event: "approve" }, text: "LGTM" },
			{ id: "meinline", type: "review", as: "me", params: { event: "comment", comments: [{ id: "c1", path: "a.ts", line: 3, text: "x" }] } },
		],
	},
	"issue-21": {
		kind: "issue", number: 21, title: "t", reviewedAt, hint: "Move: x",
		routes: [
			{ id: "move", type: "move", params: { to: "widgets-desktop" }, text: "Please open it there.", recommended: true },
			{ id: "issue", type: "follow_up", as: "bot", params: { title: "x" }, text: "Body" },
			{ id: "fix", type: "follow_up", as: "agent", text: "Fix it" },
		],
	},
	"pr-16": {
		kind: "pr", number: 16, title: "deps", authorType: "bot", reviewedAt, hint: "Take over: x",
		routes: [{ id: "r1", type: "take_over", as: "agent", params: { mode: "push" }, text: "Fix the lockfile", recommended: true }],
	},
	"issue-20": {
		kind: "issue", number: 20, title: "closed", reviewedAt, hint: "Reopen: x",
		routes: [{ id: "reopen", type: "reopen", text: "Reopening.", recommended: true }],
	},
};

function makeHome(name, extra) {
	const { home, env } = baseHome(join(T, name), extra);
	const board = join(home, "state", "board");
	for (const [id, data] of Object.entries(items)) writeFileSync(join(board, "items", id + ".json"), JSON.stringify(data));
	return { home, env };
}

const stubFile = join(T, "stub.json");
writeFileSync(stubFile, JSON.stringify({ "*": { state: "OPEN" }, "issue-20": { state: "CLOSED" } }));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
	if (cond) pass++;
	else {
		fail++;
		console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 500));
	}
}

async function withServer({ home, env }, port, fn) {
	const child = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--port", String(port)], {
		env: { ...env, GARY_GUARD_STUB: stubFile },
		stdio: ["ignore", "inherit", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await new Promise((r) => setTimeout(r, 100));
	if (!stderr.includes(" on http://127.0.0.1:")) console.log(stderr);
	const token = readFileSync(join(home, "state", "server-token"), "utf8").trim();
	const api = async (path, body) => {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, {
			method: body ? "POST" : "GET",
			headers: { "X-Board-Token": token, "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
		return { status: res.status, data: await res.json() };
	};
	const state = (await api("/api/state")).data;
	const route = (itemId, routeId) => state.items.find((i) => i.id === itemId).data.routes.find((r) => r.id === routeId);
	const click = (itemId, routeId, extra = {}) => api("/api/action", { itemId, routeId, draftHash: route(itemId, routeId).draftHash, ...extra });
	const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
	try {
		await fn({ state, route, click, page });
	} finally {
		child.kill("SIGTERM");
	}
}

const actors = (route, list) => list.every(([itemId, routeId, actor]) => route(itemId, routeId).actor === actor);
const invocations = (r) => JSON.stringify(r.data.result?.invocations ?? []);

// No bot, no own pushes
await withServer(makeHome("nobot", { bot: null }), await freePort(), async ({ state, route, click, page }) => {
	const b = state.board;
	check("board info without a bot", b.bot === null && b.accountMode === "none" && b.me.login === "octocat" && b.me.avatarUrl === "https://github.com/octocat.png?size=80", b);
	check("board info names the project", b.name === "widgets" && b.repo === "acme/widgets" && b.repoUrl === "https://github.com/acme/widgets", b);
	check("board info carries relatedRepos and botCommands", b.relatedRepos.includes("widgets-desktop") && b.botCommands.escalate?.startsWith("@"), b);
	check("the page shim carries the same info", page.includes('"accountMode":"none"') && page.includes('host:gary'));
	check("prefill actors", actors(route, [["pr-12", "reply", "me"], ["pr-12", "logs", "me"], ["pr-12", "body", "me"], ["issue-21", "issue", "me"], ["issue-20", "reopen", "me"], ["pr-12", "merge", "me"]]), state.items.map((i) => i.data.routes.map((r) => [r.id, r.actor])));
	check("routes without prefill are unavailable", actors(route, [["pr-12", "inline", "unavailable"], ["pr-12", "label", "unavailable"]]));
	check("pushing agent routes are unavailable", actors(route, [["pr-12", "fix", "unavailable"], ["pr-12", "drive", "unavailable"], ["issue-21", "fix", "unavailable"]]));
	const mv = route("issue-21", "move");
	check("move has one actor per button", mv.actors?.transfer === "unavailable" && mv.actors?.close === "me", mv);
	const r1 = await click("pr-12", "reply");
	check("a bot reply becomes prefill", r1.data.ok === false && /Without a bot account/.test(r1.data.result), r1);
	const r2 = await click("pr-12", "label");
	check("a chore is refused", r2.data.ok === false && /needs a bot account/.test(r2.data.result), r2);
	const r3 = await click("pr-12", "fix", { input: { decisions: [{ threadId: "PRRT_1", decision: "fix" }] } });
	check("address_review is refused", r3.data.ok === false && /needs a bot account/.test(r3.data.result), r3);
	const r4 = await click("issue-21", "move", { input: { mode: "transfer" } });
	check("transfer is refused", r4.data.ok === false && /needs a bot account/.test(r4.data.result), r4);
	check("request_logs and review as me are prefill", actors(route, [["pr-12", "melogs", "me"], ["pr-12", "mebody", "me"], ["pr-12", "meinline", "invalid"]]));
	const r6 = await click("pr-12", "melogs");
	check("request_logs as me is refused", r6.data.ok === false && /yours to do on GitHub/.test(r6.data.result), r6);
	const r5 = await click("issue-21", "move", { input: { mode: "close" } });
	check("move close becomes prefill", r5.data.ok === false && /Without a bot account/.test(r5.data.result), r5);
});

// No bot, own pushes allowed
await withServer(makeHome("own", { bot: null, allowOwnTokenPushes: true }), await freePort(), async ({ state, route, click }) => {
	check("board info in own mode", state.board.accountMode === "own" && state.board.bot === null, state.board);
	check("own actors", actors(route, [["pr-12", "reply", "me"], ["pr-12", "inline", "own"], ["pr-12", "label", "own"], ["pr-12", "fix", "agent"]]));
	check("move in own mode", route("issue-21", "move").actors.transfer === "own" && route("issue-21", "move").actors.close === "me");
	const r1 = await click("pr-12", "label");
	check("a chore runs under my login", r1.data.ok && invocations(r1).includes('"as":"octocat"'), r1);
	const r2 = await click("pr-12", "inline");
	check("an inline review runs under my login", r2.data.ok && invocations(r2).includes('"as":"octocat"'), r2);
	const r3 = await click("issue-21", "move", { input: { mode: "transfer" } });
	check("a transfer runs under my login", r3.data.ok && invocations(r3).includes("transferIssue"), r3);
	const r4 = await click("pr-12", "reply");
	check("a reply stays prefill", r4.data.ok === false && /Without a bot account/.test(r4.data.result), r4);
	const r5 = await click("pr-12", "drive", { input: { maxRounds: 2 } });
	check("drive is queued", r5.data.ok && r5.data.queued, r5);
});

// With a bot
await withServer(makeHome("bot"), await freePort(), async ({ state, route, click }) => {
	check("board info with a bot", state.board.accountMode === "bot" && state.board.bot.login === "widgets-bot" && state.board.bot.avatarUrl.includes("widgets-bot"), state.board);
	check("bot actors", actors(route, [["pr-12", "reply", "bot"], ["pr-12", "inline", "bot"], ["pr-12", "label", "bot"], ["pr-12", "fix", "agent"], ["issue-20", "reopen", "bot"], ["pr-12", "merge", "me"]]));
	check("move with a bot", route("issue-21", "move").actors.transfer === "bot" && route("issue-21", "move").actors.close === "bot");
	const r1 = await click("pr-12", "reply");
	check("a bot reply runs as the bot", r1.data.ok && invocations(r1).includes('"as":"widgets-bot"'), r1);
	const r2 = await click("pr-12", "drive", { input: { maxRounds: 4 } });
	check("drive rejects maxRounds 4 in input", r2.data.ok === false && /maxRounds/.test(r2.data.result), r2);
	const r4 = await click("pr-16", "r1");
	check("take_over on a bot PR is queued", r4.data.ok && r4.data.queued, r4);
	const r3 = await click("pr-12", "drive", { input: { maxRounds: 1 } });
	check("drive takes maxRounds from input", r3.data.ok && r3.data.queued, r3);
});

const driveDocs = readdirSync(join(T, "bot", "root", "instances", "widgets", "state", "board", "actions")).map((n) => JSON.parse(readFileSync(join(T, "bot", "root", "instances", "widgets", "state", "board", "actions", n), "utf8"))).filter((d) => d.action === "drive");
check("the drive doc carries maxRounds 1 from the input", driveDocs.length === 1 && driveDocs[0].params.maxRounds === 1, driveDocs);

removeDir(T);
console.log(`accounts: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
