// gary pause and resume: the server, gary action and the queue watcher stop, board-only actions keep working.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("pause");
const T = tempDir();
const port = await freePort();
const { home, env } = makeHome(T, { port });
const BOARD = join(home, "state", "board");
const reviewedAt = "2026-11-17T14:00:00Z";
writeFileSync(join(BOARD, "items", "pr-12.json"), JSON.stringify({
	kind: "pr", number: 12, title: "t", url: "https://github.com/acme/widgets/pull/12", author: "octocat", authorType: "maintainer",
	section: "easy", priority: 1, effortMinutes: 5, reviewDepth: "full", state: "Decide.", reviewedAt, hint: "Reply: thanks",
	routes: [
		{ id: "r1", type: "reply", as: "bot", title: "Reply: thanks", text: "Thanks", recommended: true },
		{ id: "r2", type: "drive", as: "agent", title: "Drive: finish it" },
		{ id: "r3", type: "merge", as: "me", title: "Merge: ready" },
	],
}));
const gary = (args, input) => spawnSync(process.execPath, [GARY, ...args], { env, input, encoding: "utf8" });
const stub = join(T, "stub.json");
writeFileSync(stub, JSON.stringify({ "*": { state: "OPEN" } }));
const server = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--port", String(port)], { env: { ...env, GARY_GUARD_STUB: stub }, stdio: ["ignore", "inherit", "pipe"] });
let stderr = "";
server.stderr.on("data", (d) => (stderr += d));
for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await sleep(100);
const token = readFileSync(join(home, "state", "server-token"), "utf8").trim();
const api = async (path, body) => {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? "POST" : "GET", headers: { "X-Board-Token": token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, data: await res.json() };
};
const hash = async (routeId) => (await api("/api/state")).data.items.find((i) => i.id === "pr-12").data.routes.find((r) => r.id === routeId).draftHash;
const MESSAGE = "Gary is paused. Nothing was sent.";

try {
	t.check("board.paused is false at first", (await api("/api/state")).data.board.paused === false);
	let r = gary(["pause"]);
	t.check("gary pause writes control.json", r.status === 0 && JSON.parse(readFileSync(join(home, "state", "control.json"), "utf8")).paused === true, r.stdout + r.stderr);
	t.check("board.paused is true", (await api("/api/state")).data.board.paused === true);
	const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
	t.check("the page shim carries paused", page.includes('"paused":true'));

	r = await api("/api/action", { itemId: "pr-12", routeId: "r1", draftHash: await hash("r1") });
	t.check("a bot click is refused with the pause message", r.data.ok === false && r.data.result === MESSAGE && r.data.paused === true, r);
	t.check("the refused click writes no action doc", readdirSync(join(BOARD, "actions")).length === 0);
	r = await api("/api/action", { itemId: "pr-12", routeId: "r2", draftHash: await hash("r2") });
	t.check("an agent request is still queued", r.data.ok && r.data.queued, r);

	r = gary(["action", "--dry-run"], '{"action":"comment","kind":"pr","number":12,"text":"x"}');
	t.check("gary action refuses with the pause message", r.status === 1 && r.stdout.includes(MESSAGE), r.stdout);
	r = gary(["action", "--dry-run", "--autonomous"], '{"action":"label","kind":"issue","number":21,"params":{"add":["needs-info"]}}');
	t.check("an autonomous label is refused too", r.status === 1 && r.stdout.includes(MESSAGE), r.stdout);

	r = gary(["watch-queue", "--once"]);
	t.check("the queue watcher prints nothing while paused", r.status === 0 && r.stdout.trim() === "", r.stdout);
	r = gary(["doctor"]);
	t.check("doctor shows the pause", /pause\s+paused: nothing goes to GitHub/.test(r.stdout), r.stdout);

	r = await api("/api/action", { action: "dismiss_route", itemId: "pr-12", routeId: "r3", text: "Not yet" });
	t.check("dismiss_route keeps working", r.data.ok, r);
	r = await api("/api/db", { op: "update", path: "items/pr-12", data: { snoozedUntil: new Date(Date.now() + 86400000).toISOString() } });
	t.check("snooze keeps working", r.status === 200, r);

	r = gary(["resume"]);
	t.check("gary resume clears the switch", r.status === 0 && JSON.parse(readFileSync(join(home, "state", "control.json"), "utf8")).paused === false, r.stdout);
	t.check("board.paused is false again", (await api("/api/state")).data.board.paused === false);
	r = gary(["watch-queue", "--once"]);
	t.check("after resume the queue watcher prints the waiting request", /"action":"drive"/.test(r.stdout), r.stdout);
	r = await api("/api/action", { itemId: "pr-12", routeId: "r1", draftHash: await hash("r1") });
	t.check("a bot click runs again", r.data.ok === true, r);
} finally {
	server.kill("SIGTERM");
}
await sleep(200);
removeDir(T);
t.done();
