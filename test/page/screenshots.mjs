// Renders the screenshots in docs/images/ from demo data: two made-up projects on a dry-run server.
// Run with `npm run screenshots`. Needs Chrome or Chromium. CHROME names the binary, default google-chrome.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PROFILE, ROOT, freePort, makeHome, removeDir, tempDir } from "../lib.mjs";

const OUT = join(ROOT, "docs", "images");
const PORT = await freePort();
const DEBUG_PORT = await freePort();
const DIR = tempDir();
const iso = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600000;
const DAY = 24 * HOUR;

const GADGETS = join(DIR, "profile-gadgets");
cpSync(PROFILE, GADGETS, { recursive: true });
writeFileSync(join(GADGETS, "profile.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8")), name: "gadgets", repo: "contoso/gadgets" }));
const { home: WIDGETS_HOME, env: ENV } = makeHome(DIR, { port: PORT, tab: { icon: "zap", color: "#0071bc", background: true, favorite: true } }, "widgets");
const { home: GADGETS_HOME } = makeHome(DIR, { profile: GADGETS, tab: { icon: "plug", color: "green" } }, "gadgets");

const URLS = { pr: "pull", issue: "issues", discussion: "discussions" };
const PREFIX = { pr: "pr-", issue: "issue-", discussion: "disc-" };
function put(home, repo, kind, number, doc) {
	const item = { kind, number, repo, url: `https://github.com/${repo}/${URLS[kind]}/${number}`, authorType: "contributor", priority: 1, reviewDepth: "full", classifiedBy: "full", updatedAt: iso(number * 60000), reviewedAt: iso(HOUR), ...doc };
	writeFileSync(join(home, "state", "board", "items", `${PREFIX[kind]}${number}.json`), JSON.stringify(item));
}
const widgets = (kind, number, doc) => put(WIDGETS_HOME, "acme/widgets", kind, number, doc);
const gadgets = (kind, number, doc) => put(GADGETS_HOME, "contoso/gadgets", kind, number, doc);

const hunk = '@@ -38,7 +38,7 @@ export const DEFAULTS = {\n \tretries: 3,\n \tbackoff: "exponential",\n-\ttimeoutSeconds: 240,\n+\ttimeoutSeconds: 24,\n \tchunkSize: 4 * 1024 * 1024,\n };';
widgets("pr", 412, {
	title: "Stop retrying an upload after a 413",
	author: "mira-k", labels: ["bug"], ci: "passing", category: "land", effortMinutes: 4, waitingDays: 2,
	state: "The fix is right. One default looks like a typo, and one getter changes behavior for unknown sizes.",
	story: "mira-k's uploads hung after the 4.2 update. Their log showed the client retrying the first chunk 214 times in 3 minutes, and every retry got a 413. This PR stops the retry loop on a 413 and reports the server's size limit. CI passes. The review found two small problems in lines the PR touches.",
	hint: "Request changes: default and getter",
	findings: [
		{ severity: "major", text: "`timeoutSeconds` drops from 240 to 24. The PR description does not mention it, and the upload docs still say 240.", ref: "src/upload/defaults.ts:40" },
		{ severity: "minor", text: "`remainingBytes` now returns 0 while the total size is unknown. Callers treat 0 as done.", ref: "src/upload/Upload.ts:118" },
	],
	routes: [
		{ id: "r1", type: "review", as: "bot", title: "Request changes: default and getter", recommended: true, text: "Thanks, two small suggestions inline.", params: { event: "request_changes", comments: [
			{ id: "c1", path: "src/upload/defaults.ts", line: 40, text: "The docs list 240 seconds as the default. `24` looks like a typo.", original: "\ttimeoutSeconds: 24,", suggestion: "\ttimeoutSeconds: 240,", diffHunk: hunk },
			{ id: "c2", path: "src/upload/Upload.ts", line: 118, text: "Callers treat 0 as done. Please keep returning `undefined` while the total size is unknown." },
		] } },
		{ id: "r2", type: "take_over", as: "agent", title: "Take over: fix both and finish the PR", params: { mode: "push" } },
		{ id: "r3", type: "merge", as: "me", title: "Merge: as is" },
	],
});
widgets("issue", 398, {
	title: "Export loses the room names",
	author: "tobi-w", labels: ["bug"], category: "unblock", effortMinutes: 2, waitingDays: 5,
	state: "Reporter found the cause and needs a go-ahead to send a PR.",
	story: "tobi-w exported a project with 12 rooms and got 12 rooms named \"Room\". They traced it to the exporter reading `label` where the model stores `name`. They asked whether a PR is welcome and where the test belongs.",
	hint: "Reply: PR welcome",
	routes: [
		{ id: "r1", type: "reply", as: "me", title: "Reply: PR welcome", recommended: true, text: "I'll accept a PR that:\n\n1. reads `name` in `exportRooms()`\n2. adds a case to `export.test.ts` with two named rooms" },
		{ id: "r2", type: "follow_up", as: "agent", title: "Start fix: read the room name" },
	],
});
widgets("pr", 407, {
	title: "chore(deps): bump undici from 7.3.0 to 7.4.1",
	author: "dependabot", authorType: "bot", labels: ["dependencies"], ci: "passing", category: "land", effortMinutes: 1, classifiedBy: "fast",
	state: "Patch and minor update of a runtime dependency. The changelog lists no breaking change.",
	story: "Dependabot bumps undici from 7.3.0 to 7.4.1. Only the lockfile and one line of package.json change.",
	hint: "Merge",
	routes: [{ id: "r1", type: "merge", as: "me", title: "Merge", recommended: true }],
});
widgets("discussion", 371, {
	title: "Hub loses its pairing after a power cut",
	author: "jonas-b", category: "unblock", effortMinutes: 5, waitingDays: 3,
	state: "Three users confirmed it on firmware 3.3. This is a bug and belongs in an issue.",
	story: "jonas-b's hub forgets all paired sensors after a power cut. Two others confirmed it, all on firmware 3.3. The attached log shows the pairing key written after the reboot, and the reboot wins the race.",
	hint: "Escalate to an issue",
	routes: [
		{ id: "r1", type: "move", as: "me", title: "Escalate to an issue", params: { to: "issue" }, recommended: true },
		{ id: "r2", type: "follow_up", as: "agent", title: "Start fix: write the key before the reboot" },
	],
});
widgets("issue", 402, {
	title: "Expose the request timeout as an option?",
	author: "lena-v", labels: ["enhancement"], category: "decide", effortMinutes: 10, waitingDays: 9,
	state: "Open question whether the client should expose its request timeout publicly.",
	story: "lena-v runs the client behind a slow proxy and patches the 30 s timeout locally. They ask for a public option. Nobody else asked so far.",
	hint: "Decide: expose the request timeout?",
	routes: [{ id: "r1", type: "reply", as: "me", title: "Decide: expose the request timeout?", recommended: true, text: "" }],
});
widgets("pr", 415, {
	title: "fix: write the pairing key before the reboot",
	author: "widgets-bot", authorType: "bot", ci: "passing", category: "land", effortMinutes: 6,
	state: "Gary's fix for the pairing loss. The review bot's two comments are addressed.",
	story: "Gary wrote this fix for the pairing loss after a power cut. A new test fails without the change and passes with it. Two review rounds are done.",
	hint: "Approve: after reading the diff",
	routes: [{ id: "r1", type: "review", as: "bot", title: "Approve: after reading the diff", params: { event: "approve", comments: [] }, text: "Thanks!", recommended: true }, { id: "r2", type: "merge", as: "me", title: "Merge" }],
});
gadgets("pr", 88, {
	title: "Add the Gadget Pro 2 to the device list",
	author: "first-timer", labels: ["devices"], ci: "failing", category: "unblock", effortMinutes: 3, waitingDays: 1,
	state: "A device file from a first-time contributor. The manual link is missing, and CI fails on formatting only.",
	story: "first-timer adds a device file for the Gadget Pro 2. The values match the manual. The formatter would change 4 lines.",
	hint: "Request changes: manual link",
	autofix: { changes: true, files: 1, lines: 4, tools: ["prettier"] },
	routes: [
		{ id: "r1", type: "review", as: "bot", title: "Request changes: manual link", params: { event: "request_changes", comments: [] }, text: "Thanks! Please add the link to the manual.", recommended: true },
		{ id: "r2", type: "format", as: "agent", title: "Format: fix formatting and lint" },
	],
});
gadgets("issue", 91, {
	title: "Pairing button does nothing on Android 15",
	author: "sam-r", labels: ["bug"], category: "unblock", effortMinutes: 2, waitingDays: 4,
	state: "No log yet. The report matches two older Android 15 permission bugs.",
	story: "sam-r taps the pairing button on a Pixel 9 with Android 15, and nothing happens. They attached a screen recording and no log.",
	hint: "Ask for a debug log",
	routes: [{ id: "r1", type: "request_logs", as: "bot", title: "Ask for a debug log", recommended: true, text: "Please attach a debug log that covers one tap on the pairing button." }],
});
gadgets("issue", 79, {
	title: "Gadget clock drifts by a minute a day",
	author: "pat-d", labels: ["bug"], category: "act", effortMinutes: 20, waitingDays: 12, dueAt: iso(-DAY).slice(0, 10), dueSource: "milestone 2.4",
	state: "Reproduced. The sync job reads the hub's uptime where it needs the wall clock.",
	story: "pat-d's gadget loses about a minute a day. The sync job runs every hour and computes the offset from the hub's uptime. The milestone 2.4 is due tomorrow.",
	hint: "Start fix: sync against the wall clock",
	routes: [{ id: "r1", type: "follow_up", as: "agent", title: "Start fix: sync against the wall clock", recommended: true }],
});

mkdirSync(join(WIDGETS_HOME, "state", "board", "proposals"), { recursive: true });
writeFileSync(join(WIDGETS_HOME, "state", "board", "proposals", "learn-1.json"), JSON.stringify({
	title: "Drop the opening thanks in log requests",
	why: "You removed the opening \"Thanks for the report!\" from the last four log requests before posting them.",
	evidence: [
		{ at: iso(9 * DAY), itemId: "issue-361", type: "edited", gist: "Removed \"Thanks for the report!\" before posting." },
		{ at: iso(7 * DAY), itemId: "issue-377", type: "edited", gist: "Removed the opening thanks and shortened the link sentence." },
		{ at: iso(3 * DAY), itemId: "issue-390", type: "edited", gist: "Removed \"Thanks for the report!\" before posting." },
	],
	target: "personal", file: "personal.md", heading: "Voice", status: "open", createdAt: iso(DAY),
	text: "In log requests, start with the request itself. No opening thanks.",
}));
for (const home of [WIDGETS_HOME, GADGETS_HOME]) writeFileSync(join(home, "state", "board", "meta.json"), JSON.stringify({ lastRunAt: iso(20 * 60000) }));

const server = spawn(process.execPath, [join(ROOT, "server", "server.mjs"), "--dry-run", "--port", String(PORT)], { stdio: ["ignore", "pipe", "pipe"], env: ENV });
await new Promise((r) => server.stderr.on("data", (d) => { if (/Board on/.test(d)) r(); }));
// Avatars come from github.com. With every host unresolvable the page draws its letter placeholders
const chrome = spawn(process.env.CHROME ?? "google-chrome", ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(DIR, "prof")}`, "about:blank"], { stdio: "ignore" });
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
const ev = (expr) => cmd("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true });
async function shot(name, width, height) {
	await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
	await sleep(600);
	const { result } = await cmd("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(OUT, name), Buffer.from(result.data, "base64"));
	console.log(`wrote docs/images/${name}`);
}
const tab = (name) => ev(`[...document.querySelectorAll("#tabs .tab")].find((b) => b.textContent.trim() === ${JSON.stringify(name)})?.click();`);
try {
	mkdirSync(OUT, { recursive: true });
	await cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await cmd("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
	await sleep(3000);
	await ev(`for (let i = 0; i < 4; i++) { for (const b of document.querySelectorAll(".show-all")) if (!b.hidden) b.click(); await new Promise((r) => setTimeout(r, 50)); }`);
	await ev(`document.querySelector(".dry, #dry, [class*=dry]")?.remove();`);
	await shot("board.png", 1180, 860);
	await tab("widgets");
	await ev(`openDetail("widgets/pr-412");`);
	await sleep(1200);
	await shot("item.png", 1180, 980);
	await ev(`document.getElementById("d-close").click();`);
	await ev(`openDetail("widgets/issue-398");`);
	await sleep(1200);
	await shot("reply.png", 1180, 760);
} finally {
	ws.close(); chrome.kill(); server.kill();
	removeDir(DIR);
}
