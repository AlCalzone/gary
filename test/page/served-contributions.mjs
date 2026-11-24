// A maintainer instance and a contributions instance on one server: the contributions tab names the repo in every
// row, FYI items join the three groups with their own chip, Got it hides one until there is news, and the dialog
// shows no control that would need a profile, a bot or a checkout.
// Needs Chrome or Chromium. CHROME names the binary, default google-chrome.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT, freePort, makeHome, removeDir, tempDir } from "../lib.mjs";

const PORT = await freePort();
const DEBUG_PORT = await freePort();
const DIR = tempDir();
const { home: WIDGETS_HOME, root: ROOTDIR, env: ENV } = makeHome(DIR, { port: PORT }, "widgets");
const MINE = join(ROOTDIR, "instances", "mine");
mkdirSync(join(MINE, "state", "board", "items"), { recursive: true });
mkdirSync(join(MINE, "state", "board", "actions"), { recursive: true });
writeFileSync(join(MINE, "config.json"), JSON.stringify({ kind: "contributions", me: "octocat" }));
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
// The allowed repos of a contributions instance come from its snapshot
writeFileSync(join(MINE, "state", "snapshot.json"), JSON.stringify({ fetchedAt: ago(0), items: Object.fromEntries(["other/lib", "third/app", "acme/widgets"].map((repo, i) => [`x${i}`, { repo, updatedAt: ago(1) }])) }));
const base = (repo, kind, number, extra) => ({ repo, kind, number, title: `Probe ${repo}#${number}`, url: `https://github.com/${repo}/${kind === "pr" ? "pull" : kind === "issue" ? "issues" : "discussions"}/${number}`, author: "carol", authorType: "contributor", reviewDepth: "quick", reviewedAt: ago(1), state: "Dave fixed it in 2.0.", ...extra });
const put = (home, id, doc) => writeFileSync(join(home, "state", "board", "items", id + ".json"), JSON.stringify(doc));
put(MINE, "other.lib.issue-4", base("other/lib", "issue", 4, { category: "fyi", effortMinutes: 1, newsAt: ago(2), authorType: "maintainer" }));
put(MINE, "other.lib.issue-6", base("other/lib", "issue", 6, { category: "fyi", effortMinutes: 1, newsAt: ago(5), gotIt: { at: ago(3) } }));
put(MINE, "third.app.disc-2", base("third/app", "discussion", 2, { category: "fyi", effortMinutes: 15, newsAt: ago(2), state: "A long thread found the root cause." }));
put(MINE, "other.lib.pr-5", base("other/lib", "pr", 5, { category: "unblock", effortMinutes: 5, priority: 1, hint: "Review: looks good", state: "Alice asked for your review.", routes: [{ id: "r1", type: "review", as: "me", title: "Review: looks good", recommended: true, text: "Looks good to me.", params: { event: "approve" } }] }));
put(WIDGETS_HOME, "issue-12", { kind: "issue", number: 12, repo: "acme/widgets", title: "Widgets issue", url: "https://github.com/acme/widgets/issues/12", author: "someone", authorType: "contributor", category: "unblock", priority: 0, effortMinutes: 5, reviewDepth: "full", reviewedAt: ago(1), state: "s", hint: "Reply: thanks", routes: [{ id: "r1", type: "reply", as: "me", title: "Reply: thanks", recommended: true, text: "Thanks!" }] });
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
const rowOf = (id) => `document.querySelector('#board .row[data-id="mine/${id}"]')`;
const groupOf = (id) => `${rowOf(id)}?.closest("section.group")?.id`;
// The contrast of the FYI chip's text on its tint, and of the bar's ink against the page, as the page computes them
const CONTRAST = `
	const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
	const lum = (c) => { const v = rgb(c).map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
	const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
	const chip = document.querySelector("#board .cat-fyi");
	const s = getComputedStyle(chip);
	const probe = document.createElement("span"); probe.style.color = "var(--cat-fyi-ink)"; document.body.append(probe);
	const ink = getComputedStyle(probe).color; probe.remove();
	const page = getComputedStyle(document.body).backgroundColor;
	return { text: ratio(s.color, s.backgroundColor), dot: ratio(ink, page), bg: s.backgroundColor };
`;
try {
	await cmd("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
	ok("the contributions instance is a tab of its own, titled by its config", await until(`[...document.querySelectorAll("#tabs .tab")].map((b) => b.textContent).join() === "All,Contributions,widgets"`));
	await ev(`[...document.querySelectorAll("#tabs .tab")].find((b) => b.textContent === "Contributions").click();`);
	ok("contributions tab: its rows only, each with owner/name#number and no number column", await until(`[...document.querySelectorAll("#board .row")].length === 3 && [...document.querySelectorAll("#board .row")].every((r) => /^(other\\/lib|third\\/app)#\\d+$/.test(r.querySelector(".r-ref")?.textContent ?? "") && getComputedStyle(r.querySelector(".r-num")).display === "none")`));
	ok("an FYI item carries the FYI chip", await ev(`return ${rowOf("other.lib.issue-4")}?.querySelector(".r-cat .cat")?.className === "cat cat-fyi" && ${rowOf("other.lib.issue-4")}.querySelector(".r-cat .cat").textContent === "FYI";`));
	ok("a short FYI lands in Quick & Easy, a long read in When you have time", (await ev(`return ${groupOf("other.lib.issue-4")};`)) === "group-quick" && (await ev(`return ${groupOf("third.app.disc-2")};`)) === "group-later");
	ok("FYI has no group of its own", (await ev(`return [...document.querySelectorAll("section.group")].map((g) => g.id).join();`)) === "group-quick,group-after,group-later");
	ok("an actionable item keeps its group", (await ev(`return ${groupOf("other.lib.pr-5")};`)) === "group-after");
	ok("an FYI item the maintainer said Got it to stays off the board", !(await ev(`return !!${rowOf("other.lib.issue-6")};`)));
	ok("the day bar names FYI by its time, like every category", await ev(`return [...document.querySelectorAll(".split-key")].some((k) => /^FYI \\d/.test(k.textContent));`));
	const light = await ev(CONTRAST);
	ok("the FYI chip text has 4.5:1 on its tint and its ink 3:1 on the page, light", light.text >= 4.5 && light.dot >= 3);
	await cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await sleep(200);
	const dark = await ev(CONTRAST);
	ok("the same holds in dark mode, with its own tint", dark.text >= 4.5 && dark.dot >= 3 && dark.bg !== light.bg);
	await cmd("Emulation.setEmulatedMedia", { features: [] });
	ok("the FYI chip color differs from every other category", await ev(`
		const bg = (cls) => { const e = document.createElement("span"); e.className = "cat " + cls; document.body.append(e); const c = getComputedStyle(e).backgroundColor; e.remove(); return c; };
		const fyi = bg("cat-fyi");
		return ["cat-act", "cat-unblock", "cat-land", "cat-decide", "cat-snoozed"].every((c) => bg(c) !== fyi);`));

	// The dialog of an actionable item: only what works without a profile, bot or checkout
	await ev(`window.open = () => null; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } }); openDetail("mine/other.lib.pr-5");`);
	await until(`document.getElementById("detail").open`);
	ok("the dialog's top bar shows the full ref", await until(`document.querySelector("#d-ref .ref")?.textContent === "other/lib#5"`));
	ok("no Focus button: a focus needs a checkout", await ev(`return document.querySelector('#d-foot [aria-label="Focus"]').hidden === true;`));
	ok("the review card copies the text and opens GitHub, nothing posts as a bot", await ev(`const b = [...document.querySelectorAll("#d-routes .card.open .card-actions button")].map((x) => x.textContent); return b.some((t) => /open GitHub/.test(t)) && !b.some((t) => /^Confirm|Request changes$|^Approve$|Start fix|Take over|Merge/.test(t));`));
	ok("no label, merge or agent control in the dialog", await ev(`return !document.querySelector("#d-routes .intent-agent, #d-routes .label-btn, #d-routes [data-focus-key*='label']") && !document.querySelector(".fyi-ack");`));
	ok("Analyze again stays", await ev(`return document.querySelector('#d-foot [aria-label="Analyze again"]').hidden === false;`));
	await ev(`document.getElementById("d-close").click();`);

	// An FYI item: one Got it, then it leaves until the routine reports news
	await ev(`openDetail("mine/other.lib.issue-4");`);
	ok("your own item says You, never Maintainer", await until(`/You/.test(document.getElementById("d-meta").textContent) && !/Maintainer/.test(document.getElementById("d-meta").textContent)`));
	await until(`document.getElementById("detail").open`);
	ok("an FYI dialog has one Got it button and no Focus", await until(`document.querySelectorAll(".fyi-ack button").length === 1 && document.querySelector(".fyi-ack button").textContent === "Got it" && document.querySelector('#d-foot [aria-label="Focus"]').hidden`));
	await ev(`document.querySelector(".fyi-ack button").click();`);
	ok("Got it closes the dialog and hides the row", await until(`!document.getElementById("detail").open && !${rowOf("other.lib.issue-4")}`));
	const stored = () => JSON.parse(readFileSync(join(MINE, "state", "board", "items", "other.lib.issue-4.json"), "utf8"));
	ok("Got it is stored on the item", typeof stored().gotIt?.at === "string");
	// The routine writes the item again with newer news
	await sleep(50);
	put(MINE, "other.lib.issue-4", { ...stored(), newsAt: new Date().toISOString(), state: "2.0.1 has the full fix." });
	ok("news after Got it bring the row back", await until(`!!${rowOf("other.lib.issue-4")}`));
	put(MINE, "other.lib.issue-4", { ...stored(), gotIt: { at: new Date(Date.now() + 1000).toISOString() } });
	ok("an item written again without new news stays hidden", await until(`!${rowOf("other.lib.issue-4")}`));

	// The maintainer tab is unchanged
	await ev(`[...document.querySelectorAll("#tabs .tab")].find((b) => b.textContent === "widgets").click();`);
	ok("the maintainer tab shows #number and no ref line", await until(`document.querySelectorAll("#board .row").length === 1 && document.querySelector("#board .row .r-num").textContent === "#12" && !document.querySelector("#board .row .r-ref")`));
	await ev(`openDetail("widgets/issue-12");`);
	await until(`document.getElementById("detail").open`);
	ok("the maintainer dialog keeps its Focus button", await ev(`return document.querySelector('#d-foot [aria-label="Focus"]').hidden === false;`));
} finally {
	console.log(results.join("\n"));
	const pass = results.filter((l) => l.startsWith("PASS")).length;
	const fail = results.length - pass;
	console.log(`page (served, contributions): ${pass} passed, ${fail} failed`);
	process.exitCode = fail || !pass ? 1 : 0;
	ws.close(); chrome.kill(); server.kill();
	removeDir(DIR);
}
