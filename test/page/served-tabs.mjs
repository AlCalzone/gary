// Two instances on one server: the page shows tabs, full refs in the combined tab, and sends every click to the item's own instance.
// Needs Chrome or Chromium. CHROME names the binary, default google-chrome.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, PROFILE, ROOT, freePort, makeHome, removeDir, tempDir } from "../lib.mjs";

const PORT = await freePort();
const DEBUG_PORT = await freePort();
const DIR = tempDir();
// The second instance needs a profile of its own repo
const GADGETS = join(DIR, "profile-gadgets");
cpSync(PROFILE, GADGETS, { recursive: true });
writeFileSync(join(GADGETS, "profile.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8")), name: "contoso-gadgets", repo: "contoso/gadgets" }));
const { home: WIDGETS_HOME, root: ROOTDIR, env: ENV } = makeHome(DIR, { port: PORT }, "widgets");
const { home: GADGETS_HOME } = makeHome(DIR, { profile: GADGETS }, "gadgets");
const item = (repo, kind, number, extra) => ({ kind, number, repo, title: "Probe " + repo + "#" + number, url: `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`, author: "someone", authorType: "contributor", section: "easy", priority: 0, effortMinutes: 1, reviewDepth: "full", ...extra });
const reply = [{ id: "r1", type: "reply", as: "me", title: "Reply: thanks", recommended: true, text: "Thanks!" }, { id: "r2", type: "follow_up", as: "agent", title: "Start fix: check it", text: "" }];
writeFileSync(join(WIDGETS_HOME, "state", "board", "items", "issue-12.json"), JSON.stringify(item("acme/widgets", "issue", 12, { hint: "Reply: thanks", routes: reply })));
writeFileSync(join(GADGETS_HOME, "state", "board", "items", "issue-12.json"), JSON.stringify(item("contoso/gadgets", "issue", 12, { hint: "Reply: thanks", routes: reply })));
const PAGE = join(DIR, "page.html");
cpSync(process.env.BOARD_HTML ?? join(ROOT, "board", "board.html"), PAGE);

const server = spawn(process.execPath, [join(ROOT, "server", "server.mjs"), "--dry-run", "--port", String(PORT), "--page-file", PAGE], { stdio: ["ignore", "pipe", "pipe"], env: ENV });
await new Promise((r) => server.stderr.on("data", (d) => { if (/Board on/.test(d)) r(); }));
const chrome = spawn(process.env.CHROME ?? "google-chrome", ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(DIR, "prof")}`, "about:blank"], { stdio: "ignore" });
let tabs;
for (let i = 0; i < 50; i++) {
	try { tabs = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json(); if (tabs.length) break; } catch {}
	await sleep(200);
}
const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const cmd = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await cmd("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })).result.result?.value;
const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await ev(`return !!(${expr});`)) return true; } catch {} await sleep(100); } return false; };
const results = [];
const ok = (n, v) => results.push((v ? "PASS " : "FAIL ") + n);
const actions = (home) => readdirSync(join(home, "state", "board", "actions")).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(home, "state", "board", "actions", n), "utf8")));
const fileUntil = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (fn()) return true; } catch {} await sleep(150); } return false; };
try {
	await cmd("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
	ok("two instances: All first, then one tab per instance in the server's order", await until(`[...document.querySelectorAll("#tabs .tab")].map((b) => b.textContent).join() === "All,contoso-gadgets,widgets"`));
	ok("combined: both #12 rows with their full refs", await until(`[...document.querySelectorAll("#board .row .r-ref")].map((e) => e.textContent).sort().join() === "acme/widgets#12,contoso/gadgets#12"`));
	await ev(`[...document.querySelectorAll("#tabs .tab")].find((b) => b.textContent === "contoso-gadgets").click();`);
	ok("project tab: only its row, with #12", await until(`document.querySelectorAll("#board .row").length === 1 && document.querySelector("#board .row .r-num").textContent === "#12" && document.querySelector("#board .row").dataset.id === "gadgets/issue-12"`));
	await ev(`window.open = () => null; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } }); openDetail("gadgets/issue-12");`);
	await until(`document.getElementById("detail").open`);
	await ev(`const ta = document.querySelector("#d-routes .card.open textarea"); ta.value = "Thanks, edited."; ta.dispatchEvent(new Event("input")); [...document.querySelectorAll("#d-routes .card.open .card-actions button")].find((b) => b.textContent === "Copy reply, open GitHub").click();`);
	const decisions = (name) => JSON.parse(spawnSync(process.execPath, [GARY, "--instance", name, "decisions", "--json"], { env: ENV, encoding: "utf8" }).stdout || "[]");
	ok("the decision post lands in the item's own instance", await fileUntil(() => decisions("gadgets").some((e) => e.type === "edited_text" && e.itemId === "issue-12")) && !decisions("widgets").some((e) => e.itemId === "issue-12"));
	await ev(`document.querySelectorAll("#d-routes .card")[1].querySelector(".card-head").click();`);
	await sleep(200);
	await ev(`[...document.querySelectorAll("#d-routes .card.open .card-actions button")].find((b) => b.textContent === "Start fix").click();`);
	ok("an agent route queues in the item's own instance", await fileUntil(() => actions(GADGETS_HOME).some((a) => a.itemId === "issue-12" && a.status === "queued")) && !actions(WIDGETS_HOME).length);
	spawnSync(process.execPath, [GARY, "--instance", "gadgets", "pause"], { env: ENV });
	await ev(`document.getElementById("d-close").click(); [...document.querySelectorAll("#tabs .tab")][0].click();`);
	ok("pausing one instance names it in the combined tab", await until(`!document.getElementById("paused").hidden && document.getElementById("paused").textContent === "Paused: contoso-gadgets"`));
} finally {
	console.log(results.join("\n"));
	const pass = results.filter((l) => l.startsWith("PASS")).length;
	const fail = results.length - pass;
	console.log(`page (served, two instances): ${pass} passed, ${fail} failed`);
	process.exitCode = fail || !pass ? 1 : 0;
	ws.close(); chrome.kill(); server.kill();
	removeDir(DIR);
}
