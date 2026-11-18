// Serves the page with a home whose config has no bot, then checks what the server sends and what the page shows.
// Usage: node test/page/served-nobot.mjs [own]. Needs Chrome or Chromium, CHROME names the binary.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, freePort, makeHome, removeDir, tempDir } from "../lib.mjs";

const PORT = await freePort();
const DIR = tempDir();
const own = process.argv[2] === "own";
const { home: HOME, env: ENV } = makeHome(DIR, { port: PORT, bot: null, allowOwnTokenPushes: own });
const BOARD = join(HOME, "state", "board");
const PAGE = join(ROOT, "board", "board.html");
const item = { kind: "issue", number: 21, title: "Probe", url: "https://github.com/acme/widgets/issues/21", author: "someone", authorType: "contributor", section: "easy", priority: 0, effortMinutes: 1, reviewDepth: "full", hint: "Ask: debug log",
	routes: [
		{ id: "r1", type: "request_logs", as: "bot", title: "Ask: debug log", recommended: true, text: "Please post a debug log." },
		{ id: "r2", type: "chore", as: "bot", title: "Label: needs info", params: { action: "label", add: ["needs info"] } },
		{ id: "r3", type: "follow_up", as: "agent", title: "Start fix: warn", text: "" },
		{ id: "r4", type: "move", as: "bot", title: "Move to widgets-desktop", params: { to: "widgets-desktop" }, text: "Please open it again in widgets-desktop." },
	] };
writeFileSync(join(BOARD, "items", "issue-21.json"), JSON.stringify(item));
const server = spawn(process.execPath, [join(ROOT, "server", "server.mjs"), "--dry-run", "--port", String(PORT), "--page-file", PAGE], { stdio: ["ignore", "pipe", "pipe"], env: ENV });
await new Promise((r) => server.stderr.on("data", (d) => { if (/Board of \S+ on/.test(d)) r(); else process.stderr.write("[server] " + d); }));
const results = [];
const ok = (n, v) => results.push((v ? "PASS " : "FAIL ") + n);
try {
	const token = readFileSync(join(HOME, "state", "server-token"), "utf8").trim();
	const st = await (await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { "X-Board-Token": token } })).json();
	const routes = st.items.find((i) => i.id === "issue-21").data.routes;
	const actors = Object.fromEntries(routes.map((r) => [r.id, r.actor]));
	results.push("INFO actors " + JSON.stringify(actors) + " move " + JSON.stringify(routes[3].actors) + " board.bot " + JSON.stringify(st.board.bot));
	const html = await new Promise((resolve) => {
		const c = spawn("timeout", ["30", process.env.CHROME ?? "google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${join(DIR, "prof")}`, "--timeout=6000", "--dump-dom", `http://127.0.0.1:${PORT}/`]);
		let out = "";
		c.stdout.on("data", (d) => (out += d));
		c.on("exit", () => resolve(out));
	});
	ok("the page lists the probe", /data-id="issue-21"/.test(html));
	ok("no bot avatar anywhere on the page", !/widgets-bot\.png/.test(html));
} finally {
	server.kill();
	const pass = results.filter((l) => l.startsWith("PASS")).length;
	const failed = results.filter((l) => l.startsWith("FAIL")).length;
	console.log(results.filter((l) => !l.startsWith("PASS")).join("\n"));
	console.log(`page (served, no bot${own ? ", own pushes" : ""}): ${pass} passed, ${failed} failed`);
	process.exitCode = failed ? 1 : 0;
	removeDir(DIR);
}
