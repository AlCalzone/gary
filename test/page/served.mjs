// Drives headless Chrome against the real board server (dry run) through the DevTools protocol.
// Needs Chrome or Chromium. CHROME names the binary, default google-chrome. GitHub reads go to the fake gh.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, PROFILE, ROOT, TEST_DIR, freePort, makeHome, removeDir, tempDir } from "../lib.mjs";

const PORT = await freePort();
const DEBUG_PORT = await freePort();
const DIR = tempDir();
// Accepted rules are appended to the profile, so the test works on its own copy outside any git repo
const PROFILE_COPY = join(DIR, "profile");
cpSync(PROFILE, PROFILE_COPY, { recursive: true });
const { home: HOME, root: ROOTDIR, env: ENV } = makeHome(DIR, { port: PORT, profile: PROFILE_COPY, escalateAs: "me" });
const BOARD = join(HOME, "state", "board");
const FIXTURE_ITEMS = JSON.parse(readFileSync(join(TEST_DIR, "fixtures", "board-items.json"), "utf8"));
const writeFixtureItems = () => {
	for (const [id, data] of Object.entries(FIXTURE_ITEMS)) writeFileSync(join(BOARD, "items", id + ".json"), JSON.stringify(data));
};
writeFixtureItems();
const SHOT = process.argv[2];
const PAGE = join(DIR, "page.html");
cpSync(process.env.BOARD_HTML ?? join(ROOT, "board", "board.html"), PAGE);

let server;
const STUB = join(DIR, "guard-stub.json");
const setStub = (o) => writeFileSync(STUB, JSON.stringify({ "*": { state: "OPEN" }, ...o }));
setStub({});
function startServer() {
	server = spawn(process.execPath, [join(ROOT, "server", "server.mjs"), "--dry-run", "--port", String(PORT), "--page-file", PAGE], { stdio: ["ignore", "pipe", "pipe"], env: { ...ENV, GARY_GUARD_STUB: STUB } });
	return new Promise((r) => server.stderr.on("data", (d) => {
		if (/Board on/.test(d)) r();
		else process.stderr.write("[server] " + d);
	}));
}
await startServer();

const chrome = spawn(process.env.CHROME ?? "google-chrome", ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(DIR, "prof")}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
let tabs;
for (let i = 0; i < 50; i++) {
	try { tabs = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json(); if (tabs.length) break; } catch {}
	await sleep(200);
}
const page = tabs.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const waiting = new Map();
const problems = [];
ws.addEventListener("message", (e) => {
	const m = JSON.parse(e.data);
	if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
	if (m.method === "Runtime.exceptionThrown") problems.push("exception: " + m.params.exceptionDetails.exception?.description);
	if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon|ERR_NAME|net::|avatars|github\.com/.test(m.params.entry.text + m.params.entry.url)) problems.push("log: " + m.params.entry.text + " " + (m.params.entry.url || ""));
	if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push("console: " + m.params.args.map((a) => a.value ?? a.description).join(" "));
});
const cmd = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
	const r = await cmd("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
	if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
	return r.result.result.value;
};
await cmd("Runtime.enable"); await cmd("Log.enable"); await cmd("Page.enable");
await cmd("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1400, deviceScaleFactor: 1, mobile: false });
await cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await cmd("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });

const results = [];
const ok = (name, v) => results.push((v ? "PASS " : "FAIL ") + name);
const until = async (expr, ms = 5000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try { if (await ev(`return !!(${expr});`)) return true; } catch { /* page is reloading */ }
		await sleep(100);
	}
	return false;
};
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const itemFile = (id) => join(BOARD, "items", id + ".json");
const actionFiles = () => readdirSync(join(BOARD, "actions")).filter((n) => n.endsWith(".json")).map((n) => json(join(BOARD, "actions", n)));
const fileUntil = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (fn()) return true; } catch {} await sleep(150); } return false; };
const put = (id, data) => {
	const f = join(DIR, "put.json");
	writeFileSync(f, JSON.stringify(data));
	const r = spawn(process.execPath, [GARY, "put", "--merge", "items", id, f], { env: ENV });
	return new Promise((res) => r.on("exit", res));
};

try {
	ok("rows render from the server", await until(`document.querySelectorAll("#board .row").length > 0`));
	ok("title comes from the board info", await until(`document.getElementById("board-title").textContent === "widgets triage" && document.title === "widgets triage"`));
	ok("dry run marker shows", await ev(`return !document.getElementById("dry-run").hidden;`));
	ok("connection icon shows connected", await until(`document.getElementById("conn").dataset.state === "connected"`));
	ok("avatar or placeholder in every row", await ev(`return [...document.querySelectorAll("#board .row")].every((r) => r.querySelector(".r-author .avatar"));`));
	ok("avatar src through the DOM", await ev(`const i = document.querySelector("#board .row img.avatar"); return !!i && /^https:\\/\\/github\\.com\\/[A-Za-z0-9-]+\\.png\\?size=40$/.test(i.src) && i.loading === "lazy" && i.referrerPolicy === "no-referrer" && i.alt === "";`));
	ok("author name shown", await ev(`return !!document.querySelector("#board .row .a-name")?.textContent;`));
	ok("author type icon sits in the second-line cluster", await ev(`return [...document.querySelectorAll(".r-meta svg")].some((s) => /^(Maintainer|Bot|Copilot)$/.test(s.getAttribute("aria-label"))) && !document.querySelector(".r-author svg");`));
	const align = await ev(`const rows = [...document.querySelectorAll("#board .row")];
		const left = (el) => el.getBoundingClientRect().left;
		const firstChar = (t) => { const r = document.createRange(); r.setStart(t.firstChild, 0); r.setEnd(t.firstChild, 1); return r.getBoundingClientRect().left; };
		const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
		const meta = rows.filter((r) => r.querySelector(".r-meta svg"));
		return { avatar: spread(rows.map((r) => left(r.querySelector(".r-author .avatar")))), title: spread(rows.map((r) => firstChar(r.querySelector(".r-title")))),
			metaVsNum: meta.length ? Math.max(...meta.map((r) => Math.abs(left(r.querySelector(".r-meta svg")) - left(r.querySelector(".r-num"))))) : 99, metaRows: meta.length,
			oneLine: rows.filter((r) => !r.querySelector(".r-meta") && !r.querySelector(".r-hint") && r.querySelector(".r-title").getBoundingClientRect().height < 30).every((r) => r.getBoundingClientRect().height < 52) };`);
	ok("avatars share one left edge " + JSON.stringify(align), align.avatar < 1);
	ok("titles start at one x", align.title < 1);
	ok("second-line icons start under the number", align.metaRows > 0 && align.metaVsNum < 1);

	// Hot reload of the page
	const touchPage = () => writeFileSync(PAGE, readFileSync(PAGE, "utf8") + "\n");
	await ev(`window.__marker = 1;`);
	touchPage();
	ok("page reloads itself after a board.html change", await until(`window.__marker === undefined && document.querySelectorAll("#board .row").length > 0`, 8000));
	await until(`document.getElementById("conn").dataset.state === "connected"`);
	await ev(`openDetail("widgets/issue-9471"); window.__marker = 2;`);
	await until(`document.getElementById("detail").open`);
	touchPage();
	await sleep(1500);
	ok("open dialog defers the reload and shows the control", await ev(`return window.__marker === 2 && document.getElementById("detail").open && !document.getElementById("reload").hidden;`));
	await ev(`document.getElementById("d-close").click();`);
	ok("closing the dialog cleanly reloads", await until(`window.__marker === undefined && document.querySelectorAll("#board .row").length > 0`, 8000));
	await until(`document.getElementById("conn").dataset.state === "connected"`);

	// Probe items with routes, written as files like the routine does
	const PR = "https://github.com/acme/widgets/pull/12";
	const ISSUE = "https://github.com/acme/widgets/issues/21";
	const probe = (kind, number, url, extra) => ({ kind, number, repo: "acme/widgets", state: "Probe item.", title: "Probe " + number, url, author: "someone", authorType: "contributor", section: "easy", priority: 0, effortMinutes: 1, reviewDepth: "full", reviewedAt: new Date(Date.now() - 3600000).toISOString(), ...extra });
	const writeProbes = () => {
		writeFileSync(itemFile("pr-12"), JSON.stringify(probe("pr", 12, PR, {
			// address_review needs a taken-over contributor PR
			takenOver: true,
			hint: "Request changes: two style nits",
			threads: [
				{ id: "t1", author: "copilot-pull-request-reviewer", path: "src/a.ts", line: 4, summary: "Real bug", verdict: "valid" },
				{ id: "t2", author: "someone", path: "src/b.ts", line: 9, summary: "Not needed", verdict: "wrong" },
			],
			routes: [
				{ id: "r1", type: "review", as: "bot", title: "Request changes: two style nits", recommended: true, text: "Thanks, two nits.", params: { event: "request_changes", comments: [{ id: "c1", path: "src/a.ts", line: 3, text: "Use const" }, { id: "c2", path: "src/b.ts", startLine: 7, line: 9, text: "Rename" }] } },
				{ id: "r2", type: "merge", as: "me", title: "Merge: after the nits" },
				{ id: "r3", type: "address_review", as: "agent", title: "Take over: address the review", text: "" },
				{ id: "r4", type: "take_over", as: "agent", title: "Take over: replace the PR", params: { mode: "replace" }, callout: "The fork does not allow pushes." },
			],
		})));
		writeFileSync(itemFile("issue-21"), JSON.stringify(probe("issue", 21, ISSUE, {
			hint: "Reply: a PR is welcome",
			routes: [
				{ id: "r1", type: "reply", as: "me", title: "Reply: a PR is welcome", recommended: true, text: "A PR is welcome!" },
				{ id: "r2", type: "request_logs", as: "bot", title: "Ask: debug log", text: "Please post a driver log on loglevel debug." },
				{ id: "r3", type: "close", as: "me", title: "Close: duplicate of #123", params: { reason: "duplicate", duplicateOf: 123 }, text: "" },
				{ id: "r4", type: "follow_up", as: "me", title: "File issue: as you", params: { title: "A & B" }, text: "Line 1" },
			],
		})));
		writeFileSync(itemFile("issue-23"), JSON.stringify(probe("issue", 23, "https://github.com/acme/widgets/issues/23", { hint: "Wait: the reporter sends a log", routes: [] })));
		const simpleReply = [{ id: "r1", type: "reply", as: "me", title: "Reply: thanks", recommended: true, text: "Thanks!" }];
		writeFileSync(itemFile("issue-24"), JSON.stringify(probe("issue", 24, "https://github.com/acme/widgets/issues/24", { hint: "Reply: thanks", routes: simpleReply })));
		writeFileSync(itemFile("issue-25"), JSON.stringify(probe("issue", 25, "https://github.com/acme/widgets/issues/25", { hint: "Reply: thanks", routes: simpleReply })));
	};
	writeProbes();
	await until(`!!document.querySelector('.row[data-id="widgets/issue-25"]')`);
	const revealAll = () => ev(`for (let i = 0; i < 4; i++) for (const b of document.querySelectorAll(".show-all")) if (!b.hidden) b.click();`);
	await revealAll();
	ok("served hint colors the action", await ev(`return document.querySelector('.row[data-id="widgets/pr-12"] .r-hint .h-act')?.textContent === "Request changes" && document.querySelector('.row[data-id="widgets/pr-12"] .r-hint').classList.contains("act-push");`));
	const openItem = async (id) => {
		await ev(`if (document.getElementById("detail").open) document.getElementById("d-close").click();`);
		await until(`!document.getElementById("detail").open`);
		await ev(`openDetail(${JSON.stringify("widgets/" + id)});`);
		return until(`document.getElementById("detail").open && detail.id === ${JSON.stringify("widgets/" + id)}`);
	};
	const closeItem = async () => { await ev(`document.getElementById("d-close").click();`); await until(`!document.getElementById("detail").open`); };
	const openCardText = `(document.querySelector("#d-routes .card.open")?.textContent ?? "")`;
	const cardButton = (label) => `[...document.querySelectorAll("#d-routes .card.open .card-actions button")].find((b) => b.textContent === ${JSON.stringify(label)})`;
	const clickCard = (i) => ev(`document.querySelectorAll("#d-routes .card")[${i}].querySelector(".card-head").click();`).then(() => sleep(150));
	const press = (label) => ev(`${cardButton(label)}.click();`);
	const rowButton = (i, label) => `[...document.querySelectorAll("#d-routes .card")[${i}].querySelectorAll(".card-actions button")].find((b) => b.textContent === ${JSON.stringify(label)})`;
	ok("items without routes are not on the board", await ev(`return !document.querySelector('.row[data-id="widgets/issue-23"]') && !!document.querySelector('.row[data-id="widgets/issue-25"]');`));

	// review as the bot: the checklist, the second confirm and the action doc the server writes
	ok("dialog opens", await openItem("pr-12"));
	ok("dialog shows author", await ev(`return !!document.querySelector("#d-meta .d-author .avatar");`));
	ok("served route cards: four, the recommended one open", await ev(`return document.querySelectorAll("#d-routes .card").length === 4 && document.querySelectorAll("#d-routes .card.open").length === 1;`));
	ok("comment range shows as path:start-line", await ev(`return /src\\/b\\.ts:7-9/.test(${openCardText});`));
	await ev(`document.querySelectorAll("#d-routes .card.open .checklist input")[0].click();`);
	await press("Request changes");
	ok("second confirm shown", await until(`!!${cardButton("Confirm: request changes as widgets-bot")}`));
	await press("Confirm: request changes as widgets-bot");
	ok("server logs the review as done with only the checked comment", await fileUntil(() => actionFiles().some((a) => a.itemId === "pr-12" && a.routeId === "r1" && a.route === "review" && a.status === "done" && a.via === "server" && a.params.comments?.length === 1 && a.params.comments[0].startLine === 7)));
	ok("the page wrote no action doc of its own", actionFiles().filter((a) => a.itemId === "pr-12").length === 1);
	ok("the done card collapses with Done in its header row", await until(`!document.querySelector("#d-routes .card.open") && /^Done/.test(document.querySelector("#d-routes .card.settled .card-top > .head-done")?.textContent ?? "") && !document.querySelector("#d-routes .card.settled .card-top > .head-done").hidden`, 8000));
	ok("the done card still shows its result when expanded", await ev(`const c = document.querySelector("#d-routes .card.settled"); return /Done/.test(c.querySelector(".card-actions").textContent) && ![...c.querySelectorAll(".card-actions button")].some((b) => b.textContent === "Request changes");`));
	await ev(`location.reload();`);
	await sleep(1500);
	await until(`typeof state === "object" && !!state.items.get("widgets/pr-12")`, 15000);
	await openItem("pr-12");
	ok("after a reload the done card starts collapsed with its confirmation", await until(`(() => { const c = document.querySelector("#d-routes .card.settled"); return !!c && !c.classList.contains("open") && /^Done/.test(c.querySelector(".card-top > .head-done").textContent); })()`, 8000));

	// Bound actions, repeats and refusals
	const token = readFileSync(join(ROOTDIR, "state", "server-token"), "utf8").trim();
	const api = async (path, body) => {
		const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: body ? "POST" : "GET", headers: { "X-Board-Token": token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		return [res.status, await res.json()];
	};
	const hashOf = async (itemId, routeId) => (await api("/api/state"))[1].items.find((i) => i.instance === "widgets" && i.id === itemId).routes.find((r) => r.id === routeId).draftHash;
	const [s1, r1] = await api("/api/action", { instance: "widgets", itemId: "pr-12", routeId: "nope", draftHash: "x" });
	ok("unknown route refused: " + r1.result, s1 === 200 && r1.ok === false && r1.result === "The board is out of date, reload it.");
	const [s2, r2] = await api("/api/action", { instance: "widgets", itemId: "pr-12", routeId: "r1", draftHash: "0000000000000000", text: "" });
	ok("draft hash mismatch refused", s2 === 200 && r2.result === "The board is out of date, reload it.");
	const [s3, r3] = await api("/api/action", { instance: "widgets", itemId: "pr-12", routeId: "r1", draftHash: await hashOf("pr-12", "r1"), text: "again", input: {} });
	ok("second identical review gets 409: " + r3.result, s3 === 409 && r3.ok === false);
	const [, r6] = await api("/api/action", { instance: "widgets", itemId: "pr-12", routeId: "r2", draftHash: await hashOf("pr-12", "r2"), force: true, input: {} });
	ok("a route in the maintainer's name is never run by the server: " + r6.result, r6.ok === false && /yours to do on GitHub/.test(r6.result));

	// address_review as the agent: decisions go into the queued doc, a repeat says already requested
	await clickCard(2);
	ok("address_review prefills fix and dismiss", await ev(`return [...document.querySelectorAll("#d-routes .card.open .decisions li")].map((li) => li.querySelector('.seg[aria-pressed="true"]').textContent).join() === "Fix,Dismiss";`));
	ok("threads list is replaced by the card", await ev(`return document.getElementById("d-threads").hidden;`));
	await clickCard(3);
	ok("take_over replace shows its callout", await ev(`return /The fork does not allow pushes/.test(document.querySelector("#d-routes .card.open .callout")?.textContent ?? "");`));
	await clickCard(2);
	await press("Address the review");
	ok("the server queues address_review with the decisions", await fileUntil(() => actionFiles().some((a) => a.itemId === "pr-12" && a.routeId === "r3" && a.status === "queued" && a.action === "address_review" && a.params.decisions.map((d) => d.decision).join() === "fix,dismiss")));
	// Queuing a pushing job marks the PR as being changed: the banner explains, the deciding routes go away
	ok("after queuing, the PR shows the push banner", await until(`/The agent is changing this PR/.test(document.getElementById("d-fix").textContent)`, 8000));
	ok("and offers no merge, review or second push", await ev(`return ![...document.querySelectorAll("#d-routes .card .card-head .r-hint")].some((e) => /^(Merge|Request changes|Take over|Address review)/.test(e.textContent));`));
	await closeItem();

	// The freshness guard: a refusal, then Post anyway with the second confirm
	const twelveMin = new Date(Date.now() - 12 * 60000).toISOString();
	setStub({ "issue-21": { comments: [{ author: { login: "jbarreiros", __typename: "User" }, at: twelveMin }] } });
	await openItem("issue-21");
	await clickCard(1);
	await ev(`const ta = document.querySelector("#d-routes .card.open textarea"); ta.focus(); ta.value += " Edited."; ta.dispatchEvent(new Event("input"));`);
	await press("Ask for a debug log");
	await until(`!!${cardButton("Confirm: ask for a debug log as widgets-bot")}`);
	await press("Confirm: ask for a debug log as widgets-bot");
	ok("refusal shows on the card with the reason", await until(`/jbarreiros commented 12 minutes ago/.test(${openCardText})`, 8000));
	ok("Post anyway offered", await until(`!!${cardButton("Post anyway")}`));
	await press("Post anyway");
	ok("Post anyway needs the second confirm", await until(`!!document.querySelector("#d-routes .card.open .btn.confirm")`));
	await ev(`document.querySelector("#d-routes .card.open .btn.confirm").click();`);
	ok("Post anyway passes for a newer comment", await fileUntil(() => actionFiles().some((a) => a.itemId === "issue-21" && a.routeId === "r2" && a.status === "done" && a.edited === true && /Edited\./.test(a.text))));
	await closeItem();

	// A guard read that finds the thread closed shows Already closed on the close card
	writeFileSync(itemFile("issue-21"), JSON.stringify({ ...json(itemFile("issue-21")), routes: json(itemFile("issue-21")).routes.map((r) => (r.id === "r2" ? { ...r, text: "Second ask." } : r)) }));
	await sleep(700);
	setStub({ "issue-21": { state: "CLOSED", stateReason: "COMPLETED" } });
	await openItem("issue-21");
	await clickCard(1);
	await press("Ask for a debug log");
	await until(`!!${cardButton("Confirm: ask for a debug log as widgets-bot")}`);
	await press("Confirm: ask for a debug log as widgets-bot");
	ok("closed thread refused on the card", await until(`/is closed/.test(${openCardText})`, 8000));
	ok("close row shows Already closed", await until(`/Already closed/.test(document.querySelectorAll("#d-routes .card")[2].textContent) && !${rowButton(2, "Open GitHub to close")}`, 8000));
	// The list waits for the dialog, so the row shows the new state once it closes
	await closeItem();
	await revealAll();
	// The posted log request marked it handled, so its row may sit in the handled line
	ok("kind icon follows the live state", await until(`(document.querySelector('.row[data-id="widgets/issue-21"] .r-kind svg') ?? document.querySelector('.handled-row[data-id="widgets/issue-21"] .h-kind svg'))?.getAttribute("aria-label") === "Issue, closed as completed"`));
	setStub({});

	// Routes in his name: the board copies and opens GitHub, the server is never asked to write
	await ev(`window.__apiCalls = 0; const f = window.fetch; window.fetch = (u, o) => { if (String(u).includes("/api/action")) window.__apiCalls++; return f(u, o); };
		window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; };
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__clip = t; } } });`);
	writeFileSync(itemFile("issue-21"), JSON.stringify({ ...json(itemFile("issue-21")), title: "Probe 21 reopened" }));
	setStub({});
	await openItem("issue-21");
	ok("his buttons carry his avatar", await until(`!!document.querySelector("#d-routes .card.open .me-btn img.avatar[src*='octocat']")`));
	await ev(`const ta = document.querySelector("#d-routes .card.open textarea"); ta.value += " (edited)"; ta.dispatchEvent(new Event("input"));`);
	await press("Copy reply, open GitHub");
	ok("me route: clipboard gets the edited text", await until(`String(window.__clip).endsWith(" (edited)")`));
	ok("me route: an issue without comments opens its plain URL", await until(`window.__opened[0] === ${JSON.stringify(ISSUE)}`));
	ok("me route: no /api/action request", await ev(`return window.__apiCalls === 0;`));
	await sleep(500);
	ok("me route: no action doc", !actionFiles().some((a) => a.itemId === "issue-21" && a.routeId === "r1"));
	ok("me route: the card collapses and says copied and opened, with Copy again inside", await until(`(() => { const c = document.querySelector("#d-routes .card.settled"); return !!c && /^Copied and opened, \\d\\d:\\d\\d/.test(c.querySelector(".card-top > .head-done").textContent) && /Copied and opened on GitHub, \\d\\d:\\d\\d/.test(c.querySelector(".status.opened")?.textContent ?? "") && [...c.querySelectorAll(".card-actions button")].some((b) => b.textContent === "Copy again"); })()`));
	ok("me route: the server serves the mark on the route", await until(`!!state.items.get("widgets/issue-21").routes.find((r) => r.id === "r1").opened?.at`, 8000));
	ok("me route: the server keeps the copied text", await fileUntil(() => / \(edited\)$/.test(json(join(HOME, "state", "opened.json"))["issue-21"].r1.text)));
	await clickCard(3);
	await press("Open GitHub to file the issue");
	ok("me follow_up opens the new-issue form", await until(`window.__opened.includes("https://github.com/acme/widgets/issues/new?title=A%20%26%20B&body=Line%201")`));
	writeFileSync(itemFile("pr-16"), JSON.stringify(probe("pr", 16, "https://github.com/acme/widgets/pull/16", {
		hint: "Reply: thanks", routes: [{ id: "r1", type: "reply", as: "me", title: "Reply: thanks", recommended: true, text: "Thanks!" }, { id: "r2", type: "merge", as: "me", title: "Merge: ready" }],
	})));
	await until(`!!state.items.get("widgets/pr-16")`);
	await openItem("pr-16");
	await ev(`${rowButton(1, "Open GitHub to merge")}.click();`);
	ok("me merge opens the PR URL", await until(`window.__opened.includes("https://github.com/acme/widgets/pull/16")`));
	ok("still no /api/action request", await ev(`return window.__apiCalls === 0;`));
	await closeItem();

	// Analyze again: a footer action that opens a note panel
	await openItem("issue-24");
	ok("Analyze again sits in the footer", await ev(`return !!document.querySelector("#d-foot .foot-analyze") && document.getElementById("d-analyze").hidden;`));
	await ev(`document.querySelector("#d-foot .foot-analyze").click();`);
	ok("the note panel opens", await until(`!document.getElementById("d-analyze").hidden`));
	await ev(`[...document.querySelectorAll("#d-analyze button")].find((b) => b.textContent === "Send to the agent").click();`);
	ok("Analyze again queues one reanalyze doc from the page", await fileUntil(() => actionFiles().filter((a) => a.itemId === "issue-24" && a.action === "reanalyze" && a.status === "queued" && a.text === "").length === 1));
	ok("the panel closes after sending", await until(`document.getElementById("d-analyze").hidden`));
	await closeItem();

	// Learning: the decision log behind a prefill button
	const decisions = () => JSON.parse(spawnSync(process.execPath, [GARY, "decisions", "--json"], { env: ENV, encoding: "utf8" }).stdout || "[]");
	ok("a prefill click logs the edited text through /api/decision", await fileUntil(() => decisions().some((e) => e.type === "edited_text" && e.itemId === "issue-21" && e.route?.type === "reply" && / \(edited\)$/.test(e.final))));
	ok("a prefill that is not the recommended route logs the alternative", await fileUntil(() => decisions().some((e) => e.type === "chose_alternative" && e.itemId === "pr-16" && e.chosen?.type === "merge")));

	// take_over on a contributor's PR carries the judged threads
	writeFileSync(itemFile("pr-14"), JSON.stringify(probe("pr", 14, "https://github.com/acme/widgets/pull/14", {
		hint: "Take over: fix the parameter name",
		threads: [
			{ id: "t1", author: "copilot-pull-request-reviewer", path: "config/zen52.json", line: 18, summary: "Parameter 2 is called ledIndicator in the manual", verdict: "valid" },
			{ id: "t2", author: "copilot-pull-request-reviewer", path: "config/zen52.json", line: 31, summary: "Add unsigned to parameter 5", verdict: "wrong" },
			{ id: "t3", author: "copilot-pull-request-reviewer", path: "config/zen52.json", line: 40, summary: "Mention the unit in the label", verdict: "optional" },
		],
		routes: [{ id: "r1", type: "take_over", as: "agent", title: "Take over: fix the parameter name", params: { mode: "push" }, recommended: true }],
	})));
	await until(`!!state.items.get("widgets/pr-14")`);
	await openItem("pr-14");
	ok("take_over lists the judged threads", await until(`document.querySelectorAll("#d-routes .card.open .decisions > li").length === 3`));
	ok("only the valid thread starts on Fix", await ev(`return [...document.querySelectorAll("#d-routes .card.open .decisions > li")].map((li) => li.querySelector('.seg[aria-pressed="true"]').textContent).join() === "Fix,Dismiss,Dismiss";`));
	await ev(`document.querySelectorAll("#d-routes .card.open .decisions > li")[1].querySelector('.seg[data-v="fix"]').click();`);
	await press("Take over");
	ok("the server queues take_over with the decisions", await fileUntil(() => actionFiles().some((a) => a.itemId === "pr-14" && a.action === "take_over" && a.status === "queued" && a.params.decisions?.map((d) => d.decision).join() === "fix,fix,dismiss")));
	ok("after the take-over is queued the PR shows the push banner and no second take-over", await until(`/The agent is changing this PR/.test(document.getElementById("d-fix").textContent) && !document.querySelector("#d-routes .card")`, 8000));
	await closeItem();

	// A stored take_over on the bot's own PR is shown and run as revise
	writeFileSync(itemFile("pr-17"), JSON.stringify(probe("pr", 17, "https://github.com/acme/widgets/pull/17", {
		author: "widgets-bot", authorType: "bot", hint: "Take over: drop the 0x00c8 file",
		threads: [{ id: "t1", author: "copilot-pull-request-reviewer", path: "config/a.json", line: 3, summary: "Use the manual's name", verdict: "valid" }],
		routes: [{ id: "r1", type: "take_over", as: "agent", title: "Take over: drop the 0x00c8 file", params: { mode: "push" }, text: "Drop the 0x00c8 file", recommended: true }],
	})));
	await until(`!!state.items.get("widgets/pr-17")`);
	await revealAll();
	ok("revise: the row of a stored take_over on a bot PR says Change", await until(`document.querySelector('.row[data-id="widgets/pr-17"] .r-hint')?.textContent === "Change: drop the 0x00c8 file"`));
	await openItem("pr-17");
	ok("revise: the card has the proposal as instructions, the Change button and who commits", await ev(`const c = document.querySelector("#d-routes .card.open"); return c.querySelector("textarea")?.value === "Drop the 0x00c8 file" && !!${cardButton("Change")} && /Commits as widgets-bot/.test(c.textContent);`));
	ok("revise: no take-over wording and no thread list on the card", await ev(`const c = document.querySelector("#d-routes .card.open"); return !/Take over|Continues in the contributor's PR/.test(c.textContent) && !c.querySelector(".decisions");`));
	await ev(`const ta = document.querySelector("#d-routes .card.open textarea"); ta.value = "Drop the 0x00c8 file only"; ta.dispatchEvent(new Event("input"));`);
	await press("Change");
	ok("the server queues revise with the edited instructions", await fileUntil(() => actionFiles().some((a) => a.itemId === "pr-17" && a.action === "revise" && a.route === "revise" && a.status === "queued" && a.text === "Drop the 0x00c8 file only" && JSON.stringify(a.params) === "{}")));
	ok("the stored item keeps its route type", json(itemFile("pr-17")).routes[0].type === "take_over");
	ok("after the revise is queued the PR shows the push banner and no second change", await until(`/The agent is changing this PR \\(your requested change/.test(document.getElementById("d-fix").textContent) && !document.querySelector("#d-routes .card")`, 8000));
	await closeItem();

	// "Not this": dismissing suggested routes
	writeFileSync(itemFile("issue-26"), JSON.stringify(probe("issue", 26, "https://github.com/acme/widgets/issues/26", {
		hint: "Close: feature request out of scope",
		routes: [
			{ id: "r1", type: "close", as: "me", title: "Close: feature request out of scope", params: { reason: "not_planned" }, recommended: true },
			{ id: "r2", type: "reply", as: "me", title: "Reply: ask for a use case", text: "Can you describe your use case?" },
		],
	})));
	writeFileSync(itemFile("issue-27"), JSON.stringify(probe("issue", 27, "https://github.com/acme/widgets/issues/27", {
		hint: "Close: answered", routes: [{ id: "r1", type: "close", as: "me", title: "Close: answered", params: { reason: "completed" }, recommended: true }],
	})));
	await until(`!!state.items.get("widgets/issue-27")`);
	await openItem("issue-26");
	await ev(`document.querySelectorAll("#d-routes .card")[0].querySelector(".card-x").click();`);
	await ev(`const i = document.querySelectorAll("#d-routes .card")[0].querySelector(".dismiss-box input"); i.value = "I asked for this feature"; i.dispatchEvent(new Event("input"));`);
	await ev(`[...document.querySelectorAll("#d-routes .card")[0].querySelectorAll(".dismiss-box button")].find((b) => b.textContent === "Dismiss suggestion").click();`);
	ok("dismiss_route removes the route and promotes the next", await fileUntil(() => { const d = json(itemFile("issue-26")); return d.routes.length === 1 && d.routes[0].id === "r2" && d.routes[0].recommended === true && d.dismissedRoutes?.[0]?.reason === "I asked for this feature"; }));
	ok("the dialog shows the remaining card, now recommended and open", await until(`document.querySelectorAll("#d-routes .card").length === 1 && /ask for a use case/.test(${openCardText})`, 8000));
	ok("the dismissal is in the decision log", decisions().some((e) => e.type === "dismissed_route" && e.itemId === "issue-26" && e.wasRecommended === true && e.reason === "I asked for this feature"));
	await openItem("issue-27");
	await ev(`document.querySelectorAll("#d-routes .card")[0].querySelector(".card-x").click();`);
	await ev(`[...document.querySelectorAll("#d-routes .card")[0].querySelectorAll(".dismiss-box button")].find((b) => b.textContent === "Dismiss suggestion").click();`);
	ok("after the last route the dialog says the agent proposes something else", await until(`/Suggestion dismissed\\. The agent will propose something else\\./.test(document.getElementById("d-routes").textContent)`));
	ok("the server queues a re-analysis and the item leaves the board", await fileUntil(() => actionFiles().some((a) => a.itemId === "issue-27" && a.action === "reanalyze" && a.status === "queued")) && await until(`!document.querySelector('.row[data-id="widgets/issue-27"]')`));
	ok("the dialog closes after a moment", await until(`!document.getElementById("detail").open`, 6000));

	// Rule proposals: accept appends to the profile file, dismiss records the reason
	const proposal = (id, extra) => ({ id, createdAt: new Date().toISOString(), why: "You did this three times.", evidence: [{ at: new Date().toISOString(), itemId: "issue-26", type: "dismissed_route", gist: "Dismissed closing a feature request." }], target: "profile", file: "rules/voice.md", heading: "", status: "open", decidedAt: null, reason: "", ...extra });
	mkdirSync(join(BOARD, "proposals"), { recursive: true });
	writeFileSync(join(BOARD, "proposals", "learn-2026-11-18-no-thanks.json"), JSON.stringify(proposal("learn-2026-11-18-no-thanks", { title: "Drop the opening thanks in log requests", text: "Start log requests with the request itself." })));
	writeFileSync(join(BOARD, "proposals", "learn-2026-11-18-keep-asked.json"), JSON.stringify(proposal("learn-2026-11-18-keep-asked", { title: "Keep feature requests the maintainer asked for", text: "Do not close requests a maintainer asked for." })));
	ok("open proposals show the lightbulb with their count", await until(`!document.getElementById("learn").hidden && document.getElementById("learn").textContent === "2"`, 8000));
	await ev(`document.getElementById("learn").click();`);
	const pcard = (title) => `[...document.querySelectorAll("#learn-dialog .pcard")].find((c) => c.textContent.includes(${JSON.stringify(title)}))`;
	ok("the proposals dialog lists both", await until(`document.querySelectorAll("#learn-dialog .pcard").length === 2`));
	await ev(`const ta = ${pcard("Drop the opening thanks")}.querySelector("textarea"); ta.value = "Start log requests with the request itself. Skip the thanks."; ta.dispatchEvent(new Event("input"));`);
	await ev(`[...${pcard("Drop the opening thanks")}.querySelectorAll(".card-actions button")].find((b) => b.textContent === "Add rule").click();`);
	ok("Add rule appends the edited text to the profile file", await fileUntil(() => readFileSync(join(PROFILE_COPY, "rules", "voice.md"), "utf8").includes("Start log requests with the request itself. Skip the thanks.")));
	ok("the proposal is accepted on disk", json(join(BOARD, "proposals", "learn-2026-11-18-no-thanks.json")).status === "accepted");
	ok("the card says where the rule went", await until(`/Added to rules\\/voice\\.md/.test(${pcard("Drop the opening thanks")}?.textContent ?? "")`));
	await ev(`[...${pcard("Keep feature requests")}.querySelectorAll(".card-actions button")].find((b) => b.textContent === "Not this").click();`);
	await ev(`const i = ${pcard("Keep feature requests")}.querySelector(".dismiss-box input"); i.value = "Too broad"; i.dispatchEvent(new Event("input"));`);
	await ev(`[...${pcard("Keep feature requests")}.querySelectorAll(".dismiss-box button")].find((b) => b.textContent === "Dismiss suggestion").click();`);
	ok("Not this dismisses the proposal with the reason", await fileUntil(() => { const p = json(join(BOARD, "proposals", "learn-2026-11-18-keep-asked.json")); return p.status === "dismissed" && p.reason === "Too broad"; }));
	ok("the dismissed card leaves the dialog", await until(`document.querySelectorAll("#learn-dialog .pcard").length === 1`));
	await ev(`document.getElementById("learn-close").click();`);
	ok("with nothing open the lightbulb hides", await until(`document.getElementById("learn").hidden`));

	// An item the agent could not analyze: one "open" route and a notice
	writeFileSync(itemFile("issue-28"), JSON.stringify(probe("issue", 28, "https://github.com/acme/widgets/issues/28", {
		hint: "Open: read it yourself", blocked: { reason: "safety_filter", at: new Date().toISOString() },
		routes: [{ id: "r1", type: "open", as: "me", title: "Open: read it yourself", recommended: true }],
	})));
	await until(`!!state.items.get("widgets/issue-28")`);
	await revealAll();
	ok("blocked: the row shows the not-analyzed icon", await until(`!!document.querySelector('.row[data-id="widgets/issue-28"] .r-meta svg[aria-label="Not analyzed by the agent"]')`));
	await openItem("issue-28");
	ok("blocked: the safety filter notice and one Open on GitHub row without dismiss", await ev(`return /safety filter/.test(document.querySelector("#d-routes .blocked-note")?.textContent ?? "") && document.querySelectorAll("#d-routes .card").length === 1 && !document.querySelector("#d-routes .card-x") && !!${rowButton(0, "Open on GitHub")};`));
	await ev(`window.__apiCalls = 0; ${rowButton(0, "Open on GitHub")}.click();`);
	ok("Open on GitHub opens the thread and runs nothing", await until(`window.__opened.includes("https://github.com/acme/widgets/issues/28")`) && await ev(`return window.__apiCalls === 0;`));
	await closeItem();

	// A smaller model did the analysis
	writeFileSync(itemFile("issue-30"), JSON.stringify(probe("issue", 30, "https://github.com/acme/widgets/issues/30", {
		hint: "Reply: thanks", analyzedBy: "fallback", routes: [{ id: "r1", type: "reply", as: "me", title: "Reply: thanks", recommended: true, text: "Thanks!" }],
	})));
	await until(`!!state.items.get("widgets/issue-30")`);
	await revealAll();
	ok("fallback: the row shows the smaller-model icon", await until(`!!document.querySelector('.row[data-id="widgets/issue-30"] .r-meta svg[aria-label^="The full analysis was stopped"]')`));
	await openItem("issue-30");
	ok("fallback: the dialog shows the Smaller model badge", await ev(`return [...document.querySelectorAll("#d-meta .sbadge")].some((b) => b.textContent === "Smaller model" && /Code-level conclusions need your check/.test(b.title));`));
	await closeItem();
	ok("the instance is named like the project, so the title has no tooltip", await ev(`return document.getElementById("board-title").title === "";`));

	// Format: a compact agent row that queues
	writeFileSync(itemFile("pr-13"), JSON.stringify(probe("pr", 13, "https://github.com/acme/widgets/pull/13", {
		hint: "Format: fix formatting and lint", reviewedSha: "b".repeat(40), autofix: { changes: true, files: 2, lines: 9, tools: ["prettier"] },
		routes: [{ id: "r1", type: "format", as: "agent", title: "Format: fix formatting and lint", recommended: true }],
	})));
	await until(`!!state.items.get("widgets/pr-13")`);
	await openItem("pr-13");
	ok("format: the served row has its button and its note", await ev(`return !!${rowButton(0, "Format & fix lint")} && /Does not take over the PR/.test(document.querySelector("#d-routes .compact-note")?.textContent ?? "");`));
	ok("autofix: the served badge", await ev(`return [...document.querySelectorAll("#d-meta .sbadge")].some((b) => b.textContent === "Autofix: 2 files");`));
	await ev(`${rowButton(0, "Format & fix lint")}.click();`);
	ok("format: the server queues it", await fileUntil(() => actionFiles().some((a) => a.itemId === "pr-13" && a.action === "format" && a.status === "queued")));
	ok("format: once queued, the push banner replaces the row", await until(`/The agent is changing this PR/.test(document.getElementById("d-fix").textContent) && !document.querySelector("#d-routes .card")`, 8000));
	await closeItem();

	// Broken settings: the server keeps the last valid ones, the page shows a banner until they are fixed
	const profileFile = join(PROFILE_COPY, "profile.json");
	const goodProfile = readFileSync(profileFile, "utf8");
	writeFileSync(profileFile, "{ not json");
	ok("invalid settings show a banner without a reload", await until(`/The settings of widgets are invalid/.test(document.getElementById("settings-notes").textContent) && !!document.querySelector("#settings-notes pre.settings-error")`, 10000));
	await openItem("issue-24");
	ok("the board keeps working on the last valid settings", await ev(`return document.querySelectorAll("#d-routes .card").length > 0;`));
	await closeItem();
	writeFileSync(profileFile, goodProfile);
	ok("fixed settings remove the banner", await until(`!document.querySelector("#settings-notes .settings-banner")`, 10000));

	// Label button next to a prefill, and the label checkbox on a bot post
	const LABEL = { add: ["needs-info"], remove: [] };
	writeFileSync(itemFile("issue-22"), JSON.stringify(probe("issue", 22, "https://github.com/acme/widgets/issues/22", {
		hint: "Ask: debug log", routes: [{ id: "r1", type: "request_logs", as: "me", title: "Ask: debug log", recommended: true, text: "Please attach a debug log.", params: { alsoLabel: LABEL } }],
	})));
	await until(`!!state.items.get("widgets/issue-22")`);
	await openItem("issue-22");
	const labelBtn = `document.querySelector("#d-routes .card.open .label-btn")`;
	ok("label: the prefill card has the label button", await until(`${labelBtn}?.textContent === "Add label: needs-info"`));
	await ev(`${labelBtn}.click();`);
	ok("label: the server sets exactly the route's label", await fileUntil(() => actionFiles().some((a) => a.itemId === "issue-22" && a.part === "label" && a.status === "done")));
	ok("label: the button reads Label added from the server's state", await until(`${labelBtn}?.textContent === "Label added" && ${labelBtn}.disabled`, 8000));
	await closeItem();
	await openItem("issue-22");
	ok("label: still done after reopening", await until(`${labelBtn}?.textContent === "Label added"`));
	await closeItem();
	writeFileSync(itemFile("issue-22"), JSON.stringify(probe("issue", 22, "https://github.com/acme/widgets/issues/22", {
		hint: "Ask: debug log", routes: [{ id: "r1", type: "request_logs", as: "bot", title: "Ask: debug log", recommended: true, text: "Please attach a debug log, please.", params: { alsoLabel: LABEL } }],
	})));
	await until(`state.items.get("widgets/issue-22")?.routes?.[0]?.as === "bot"`);
	await openItem("issue-22");
	ok("bot: the checkbox is on", await ev(`return document.querySelector("#d-routes .card.open .also-label input")?.checked === true;`));
	await press("Ask for a debug log");
	await until(`!!${cardButton("Confirm: ask for a debug log as widgets-bot")}`);
	await press("Confirm: ask for a debug log as widgets-bot");
	ok("bot: the post also sets the label", await fileUntil(() => actionFiles().some((a) => a.itemId === "issue-22" && a.part !== "label" && a.status === "done" && JSON.stringify(a.label ?? a).includes("needs-info"))));
	await closeItem();

	// Analyze again while an analysis is queued
	writeFileSync(join(BOARD, "actions", "issue-24-q.json"), JSON.stringify({ itemId: "issue-24", action: "reanalyze", status: "queued", via: "queue", createdAt: new Date().toISOString(), finishedAt: null, params: {}, text: "", result: "" }));
	await openItem("issue-24");
	ok("analyzing: the footer button reads Analyzing…", await until(`document.querySelector("#d-foot .foot-analyze")?.textContent === "Analyzing…"`, 8000));
	await closeItem();

	// The agent rewrites the open item; the list waits for the dialog
	await revealAll();
	await openItem("issue-24");
	const rowOf = (id) => `(document.querySelector('.row[data-id="widgets/${id}"]')?.closest("[id^=group-]")?.id ?? "none")`;
	const before26 = JSON.stringify(await ev(`return ${rowOf("issue-26")};`));
	await put("issue-24", { reviewedAt: new Date().toISOString(), hint: "Reply: thanks, it is fixed", routes: [{ id: "r1", type: "reply", as: "me", title: "Reply: thanks, it is fixed", recommended: true, text: "Thanks, this is fixed." }] });
	await put("issue-26", { section: "deferred" });
	ok("a rewrite shows the update line with the previous hint", await until(`!document.getElementById("d-updated").hidden && /Before: Reply: thanks/.test(document.getElementById("d-updated").textContent)`, 8000));
	ok("the list does not move while the dialog is open", await ev(`return ${rowOf("issue-26")} === ${before26};`));
	await closeItem();
	ok("closing applies the change", await until(`${rowOf("issue-26")} !== ${before26}`));

	// Answer button on a discussion's close
	writeFileSync(itemFile("disc-31"), JSON.stringify(probe("discussion", 31, "https://github.com/acme/widgets/discussions/31", {
		hint: "Close: answered", routes: [{ id: "r1", type: "close", as: "me", title: "Close: answered", recommended: true, text: "Thanks, answered below.",
			params: { alsoAnswer: { commentId: "DC_c1", url: "https://github.com/acme/widgets/discussions/31#c1", gist: "Use the backup command." } } }],
	})));
	await until(`!!state.items.get("widgets/disc-31")`);
	await openItem("disc-31");
	const answerBtn = `document.querySelector("#d-routes .card .answer-btn")`;
	ok("answer: the served card has Mark answer and the gist", await until(`${answerBtn}?.textContent === "Mark answer" && /Proposed answer: Use the backup command\./.test(document.querySelector("#d-routes .part-gist")?.textContent ?? "")`));
	await ev(`${answerBtn}.click();`);
	ok("answer: the server marks the answer", await fileUntil(() => actionFiles().some((a) => a.itemId === "disc-31" && a.part === "answer" && a.status === "done")));
	ok("answer: the button reads Answer marked", await until(`${answerBtn}?.textContent === "Answer marked" && ${answerBtn}.disabled`, 8000));
	await closeItem();

	// A fix in flight and a PR the agent is changing, from the stored item fields
	writeFileSync(itemFile("issue-33"), JSON.stringify(probe("issue", 33, "https://github.com/acme/widgets/issues/33", {
		hint: "Reply: fix in review",
		fix: { state: "draft", pr: { number: 14, url: "https://github.com/acme/widgets/pull/14", title: "fix: probe", isDraft: true, ci: "pending", author: "widgets-bot" }, startedBy: "routine", since: new Date().toISOString() },
		routes: [
			{ id: "r1", type: "reply", as: "me", title: "Reply: fix in review", recommended: true, text: "A fix is in review." },
			{ id: "r2", type: "follow_up", as: "agent", title: "Start fix: again", text: "" },
		],
	})));
	writeFileSync(itemFile("pr-15"), JSON.stringify(probe("pr", 15, "https://github.com/acme/widgets/pull/15", {
		hint: "Reply: on it", working: { kind: "push", route: "take_over", since: new Date().toISOString() },
		routes: [
			{ id: "r1", type: "reply", as: "me", title: "Reply: on it", recommended: true, text: "On it." },
			{ id: "r2", type: "merge", as: "me", title: "Merge: as is" },
			{ id: "r3", type: "review", as: "bot", title: "Approve: as is", params: { event: "approve", comments: [] }, text: "Thanks" },
			{ id: "r4", type: "drive", as: "agent", title: "Drive: rounds", params: { maxRounds: 2 } },
		],
	})));
	await until(`!!state.items.get("widgets/pr-15")`);
	await revealAll();
	ok("fix draft: the row chip on the title line", await until(`document.querySelector('.row[data-id="widgets/issue-33"] .r-titleline .agent-chip')?.textContent === "Fix: #14 draft"`));
	ok("push: the Agent working chip", await ev(`return document.querySelector('.row[data-id="widgets/pr-15"] .r-titleline .agent-chip')?.textContent === "Agent working";`));
	await openItem("issue-33");
	ok("fix draft: the banner and no fix route", await ev(`return /^Draft fix #14 is open: fix: probe\./.test(document.getElementById("d-fix").textContent) && ![...document.querySelectorAll("#d-routes .card")].some((c) => /Start fix/.test(c.textContent));`));
	await closeItem();
	await openItem("pr-15");
	ok("push: merge, approve and drive are hidden, the reply stays", await ev(`const t = [...document.querySelectorAll("#d-routes .card .card-head .r-hint")].map((e) => e.textContent).join("|"); return t === "Reply: on it";`));
	ok("push: the banner", await ev(`return /The agent is changing this PR \\(take over, started/.test(document.getElementById("d-fix").textContent);`));
	await closeItem();

	// A running fix takes its issue out of the plan, from the server's fix state
	mkdirSync(join(HOME, "state", "claims"), { recursive: true });
	const fixClaim = join(HOME, "state", "claims", "issue-33.fix.json");
	writeFileSync(fixClaim, JSON.stringify({ run: "run-hourly", at: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }));
	ok("fix parked: the server marks the fix and the row moves to the fix line", await until(`state.items.get("widgets/issue-33")?.fix?.parked === true && !document.querySelector('#board .group .row[data-id="widgets/issue-33"]') && !!document.querySelector('#fix-parked .handled-row[data-id="widgets/issue-33"]')`, 8000));
	ok("fix parked: the line counts it", await ev(`return document.querySelector("#fix-parked summary").textContent === "Has a fix in progress: 1 · automatic: 1 of 10" && !document.getElementById("fix-parked").hidden;`));
	await ev(`[...document.querySelectorAll('#fix-parked .handled-row[data-id="widgets/issue-33"] button')].find((b) => b.textContent === "Open").click();`);
	ok("fix parked: its dialog opens with the fix banner", await until(`document.getElementById("detail").open && detail.id === "widgets/issue-33" && /^A fix is running\\./.test(document.getElementById("d-fix").textContent)`));
	await closeItem();
	rmSync(fixClaim);
	ok("fix parked: the row is back when the fix no longer parks it", await until(`!!document.querySelector('#board .row[data-id="widgets/issue-33"]') && document.getElementById("fix-parked").hidden`, 8000));

	// An automatic review parks its PR until the snapshot shows that the contributor moved
	const autoFile = join(HOME, "state", "auto-reviews.json");
	const autoSha = "a".repeat(40);
	const autoAt = new Date(Date.now() - 60000).toISOString();
	// Any PR he has not handled, hidden or snoozed works
	const autoId = await ev(`return [...state.items].find(([k, d]) => d.kind === "pr" && !handledOf(k, d) && !isHiddenItem(d) && !isSnoozed(d) && !workingOf(d))?.[0].split("/")[1];`);
	const autoNumber = Number(autoId.split("-")[1]);
	const autoRow = `document.querySelector('#auto-waiting .handled-row[data-id="widgets/${autoId}"]')`;
	writeFileSync(autoFile, JSON.stringify({ [autoId]: { repo: "acme/widgets", number: autoNumber, author: "hubot", reviews: [{ sha: autoSha, at: autoAt, url: "https://github.com/acme/widgets/pull/1#pullrequestreview-9", run: "r", event: "request_changes", reason: "first", findings: [{ severity: "major", text: "The range allows 255." }], comments: 0, offered: null }] } }));
	ok("auto review: the server marks the PR as waiting and the row moves to the line", await until(`state.items.get("widgets/${autoId}")?.autoReview?.waiting === true && !document.querySelector('#board .group .row[data-id="widgets/${autoId}"]') && !!${autoRow}`, 8000));
	ok("auto review: the line counts it", await ev(`return document.querySelector("#auto-waiting summary").textContent === "Reviewed automatically, waiting: 1" && !document.getElementById("auto-waiting").hidden;`));
	await ev(`[...${autoRow}.querySelectorAll("button")].find((b) => b.textContent === "Open").click();`);
	ok("auto review: its dialog names the wait and what was asked", await until(`document.getElementById("detail").open && detail.id === "widgets/${autoId}" && /^Reviewed automatically, waiting for the contributor\\./.test(document.getElementById("d-auto").textContent) && document.querySelector("#d-auto li")?.textContent === "The range allows 255."`));
	await closeItem();
	const snapFile = join(HOME, "state", "snapshot.json");
	const snapBefore = existsSync(snapFile) ? readFileSync(snapFile, "utf8") : null;
	writeFileSync(snapFile, JSON.stringify({ fetchedAt: new Date().toISOString(), items: { ...(snapBefore ? JSON.parse(snapBefore).items : {}), [autoId]: { updatedAt: new Date().toISOString(), headSha: "b".repeat(40), autoReview: { lastAuthorAt: null, maintainerAt: null, reRequestedAt: null } } } }));
	ok("auto review: a new head in the snapshot brings the row back", await until(`state.items.get("widgets/${autoId}")?.autoReview?.changed?.join() === "pushed" && document.getElementById("auto-waiting").hidden`, 8000));
	rmSync(autoFile);
	if (snapBefore === null) rmSync(snapFile);
	else writeFileSync(snapFile, snapBefore);
	ok("auto review: without the record the item carries no state", await until(`!state.items.get("widgets/${autoId}")?.autoReview`, 8000));

	// The category and the sensitive files come from the snapshot, and the escalate button posts through the server
	{
		const before = existsSync(snapFile) ? readFileSync(snapFile, "utf8") : null;
		writeFileSync(itemFile("disc-32"), JSON.stringify(probe("discussion", 32, "https://github.com/acme/widgets/discussions/32", {
			hint: "Accept: track as an enhancement issue",
			routes: [{ id: "r1", type: "move", as: "me", title: "Accept: track as an enhancement issue", recommended: true, params: { to: "issue", issueKind: "enhancement" } }],
		})));
		writeFileSync(itemFile("pr-25"), JSON.stringify(probe("pr", 25, "https://github.com/acme/widgets/pull/25", { hint: "Merge: ready", routes: [{ id: "r1", type: "merge", as: "me", title: "Merge: ready", recommended: true }] })));
		writeFileSync(snapFile, JSON.stringify({ fetchedAt: new Date().toISOString(), items: {
			...(before ? JSON.parse(before).items : {}),
			"disc-32": { kind: "discussion", number: 32, category: "Feature Requests" },
			"pr-25": { kind: "pr", number: 25, sensitiveFiles: [".github/copilot-instructions.md", "a/package.json", "b/package.json", "c/package.json", "d/package.json", "e/package.json"] },
		} }));
		ok("category: the server serves it from the snapshot", await until(`state.items.get("widgets/disc-32")?.category === "Feature Requests"`, 8000));
		await openItem("disc-32");
		const escBtn = (text) => `[...document.querySelectorAll("#d-routes .card .card-actions button")].find((b) => b.textContent === ${JSON.stringify(text)})`;
		ok("category: the dialog shows it", await ev(`return document.querySelector("#d-meta .tag.category")?.textContent === "Feature Requests";`));
		ok("escalate: with escalateAs me the card has the post button and the copy button", await until(`!!${escBtn("Accept as an issue")} && !!${escBtn("Copy command, open GitHub")}`));
		await ev(`${escBtn("Accept as an issue")}.click();`);
		ok("escalate: the click asks to confirm the exact command", await until(`!!${escBtn("Confirm: post @widgets-bot escalate as you")}`));
		await ev(`${escBtn("Confirm: post @widgets-bot escalate as you")}.click();`);
		ok("escalate: the server records the post of the profile's command", await fileUntil(() => actionFiles().some((a) => a.itemId === "disc-32" && a.action === "escalate" && a.status === "done" && a.text === "@widgets-bot escalate" && a.as === "octocat")));
		ok("escalate: the card says Done and has no buttons left", await until(`/Done/.test(document.querySelector("#d-routes .card")?.textContent ?? "") && !document.querySelector("#d-routes .card .card-actions button")`, 8000));
		await closeItem();
		ok("escalate: the discussion leaves the plan", await until(`!document.querySelector('#board .group .row[data-id="widgets/disc-32"]')`, 8000));
		ok("sensitive: the server serves the first five files and the count", await until(`state.items.get("widgets/pr-25")?.sensitive?.files?.length === 5 && state.items.get("widgets/pr-25").sensitive.total === 6`, 8000));
		await openItem("pr-25");
		ok("sensitive: the dialog warns above the routes", await ev(`const b = document.getElementById("d-sensitive"); return !b.hidden && /^Touches sensitive files: \\.github\\/copilot-instructions\\.md, .* and 1 more\\. Gary does not push to this PR\\./.test(b.textContent);`));
		await closeItem();
		rmSync(itemFile("disc-32"));
		rmSync(itemFile("pr-25"));
		if (before === null) rmSync(snapFile);
		else writeFileSync(snapFile, before);
	}

	// The review rounds of a recorded fix PR show on the issue as each stage is written, without a triage run
	const fixesFile = join(HOME, "state", "fixes.json");
	writeFileSync(fixesFile, JSON.stringify({ "issue-33": [{ number: 14, url: "https://github.com/acme/widgets/pull/14", branch: "triage/issue-33", run: "r", startedBy: "routine", at: new Date().toISOString() }] }));
	const parkedChip = `document.querySelector('#fix-parked .handled-row[data-id="widgets/issue-33"] .agent-chip')?.textContent`;
	ok("fix rounds: a recorded fix PR parks the issue at once", await until(`/^Fix: #14 (draft|open)$/.test(${parkedChip} ?? "")`, 8000));
	ok("fix limit: the line counts the routine's fix against the limit", await ev(`return document.querySelector("#fix-parked summary").textContent === "Has a fix in progress: 1 · automatic: 1 of 10";`));
	mkdirSync(join(HOME, "state", "drive"), { recursive: true });
	const driveFile = join(HOME, "state", "drive", "pr-14.json");
	const driveDoc = { actionId: "pr-14-1", repo: "acme/widgets", number: 14, maxRounds: 3, by: "fix", fixFor: "issue-33", reviewBot: "copilot", rounds: [], reviewRequestedAt: new Date().toISOString() };
	writeFileSync(driveFile, JSON.stringify(driveDoc));
	ok("fix rounds: the chip names round 1 when the review is requested", await until(`/, Copilot round 1 of 3$/.test(${parkedChip} ?? "")`, 8000));
	writeFileSync(driveFile, JSON.stringify({ ...driveDoc, rounds: [{ n: 1, fixed: ["x"], dismissed: [], open: [] }] }));
	ok("fix rounds: the chip moves to round 2 when the round is recorded", await until(`/, Copilot round 2 of 3$/.test(${parkedChip} ?? "")`, 8000));
	rmSync(driveFile);
	ok("fix rounds: the stage goes when the rounds end", await until(`/^Fix: #14 (draft|open)$/.test(${parkedChip} ?? "")`, 8000));
	rmSync(fixesFile);
	ok("fix rounds: without the record the row is back", await until(`!!document.querySelector('#board .row[data-id="widgets/issue-33"]')`, 8000));

	// A handled item leaves the plan; Bring back clears the mark on the server
	await put("issue-33", { handled: { at: new Date().toISOString(), routeId: "r1", routeType: "reply", verified: "unchanged" } });
	ok("handled: the row leaves the groups and appears in the handled line", await until(`!document.querySelector('#board .group .row[data-id="widgets/issue-33"]') && !!document.querySelector('#handled .handled-row[data-id="widgets/issue-33"]')`, 8000));
	await ev(`[...document.querySelectorAll('#handled .handled-row[data-id="widgets/issue-33"] button')].find((b) => b.textContent === "Bring back").click();`);
	ok("Bring back clears handled on disk", await fileUntil(() => !json(itemFile("issue-33")).handled));
	ok("and the row is back", await until(`!document.querySelector('#handled .handled-row[data-id="widgets/issue-33"]') && !!document.querySelector('#board .row[data-id="widgets/issue-33"]')`, 8000));

	// Paused: gary pause and gary resume change the header live, server writes are refused calmly
	const gary = (...args) => spawnSync(process.execPath, [GARY, ...args], { env: ENV, encoding: "utf8" });
	writeFileSync(itemFile("issue-29"), JSON.stringify(probe("issue", 29, "https://github.com/acme/widgets/issues/29", {
		hint: "Ask: debug log",
		routes: [
			{ id: "r1", type: "request_logs", as: "bot", title: "Ask: debug log", recommended: true, text: "Please post a debug log." },
			{ id: "r2", type: "reply", as: "me", title: "Reply: thanks", text: "Thanks!" },
		],
	})));
	await until(`!!state.items.get("widgets/issue-29")`);
	await ev(`window.__marker = 3;`);
	gary("pause");
	ok("gary pause shows the marker without a reload", await until(`!document.getElementById("paused").hidden`, 8000) && await ev(`return window.__marker === 3;`));
	await openItem("issue-29");
	ok("paused: the bot button carries the paused hint", await until(`/paused/.test(document.querySelector("#d-routes .card.open .paused-hint")?.textContent ?? "")`));
	await press("Ask for a debug log");
	await until(`!!${cardButton("Confirm: ask for a debug log as widgets-bot")}`);
	await press("Confirm: ask for a debug log as widgets-bot");
	ok("paused: the refusal shows as information on the card", await until(`/Gary is paused\\. Nothing was sent\\./.test(document.querySelector("#d-routes .card.open .status.info")?.textContent ?? "") && !document.querySelector("#d-routes .card.open .status.failed")`, 8000));
	ok("paused: no action doc", !actionFiles().some((a) => a.itemId === "issue-29"));
	await closeItem();
	gary("resume");
	ok("gary resume hides the marker without a reload", await until(`document.getElementById("paused").hidden`, 8000) && await ev(`return window.__marker === 3;`));
	await openItem("issue-29");
	ok("resumed: no paused hint", await until(`!document.querySelector("#d-routes .paused-hint") && !!${cardButton("Ask for a debug log")}`));
	await closeItem();

	// Typed drafts survive a reload, and a rewritten draft drops them
	writeProbes();
	await sleep(700);
	await openItem("issue-21");
	await ev(`const ta = document.querySelector("#d-routes .card.open textarea"); ta.focus(); ta.value = "Draft kept across reloads"; ta.dispatchEvent(new Event("input"));`);
	await ev(`document.getElementById("d-close").click();`);
	await cmd("Page.reload");
	await sleep(500);
	await until(`document.querySelectorAll("#board .row").length > 0`);
	await until(`document.getElementById("conn").dataset.state === "connected"`);
	await openItem("issue-21");
	ok("draft restored after reload", await until(`document.querySelector("#d-routes .card.open textarea")?.value === "Draft kept across reloads"`));
	await closeItem();
	await put("issue-21", { reviewedAt: new Date().toISOString() });
	await sleep(700);
	await openItem("issue-21");
	ok("draft for an outdated hash is dropped", await until(`document.querySelector("#d-routes .card.open textarea")?.value === "A PR is welcome!"`));
	await closeItem();

	// Dismiss and snooze
	await openItem("issue-25");
	await until(`!!document.querySelector('#d-foot [aria-label="Snooze until new activity"]')`);
	await ev(`document.querySelector('#d-foot [aria-label="Snooze until new activity"]').click();`);
	ok("dismiss writes hidden", await fileUntil(() => json(itemFile("issue-25")).hidden === true));
	ok("dismiss closes the dialog", await until(`!document.getElementById("detail").open`));
	await openItem("issue-24");
	await ev(`document.querySelector('#d-foot [aria-label="Snooze 1 day"]').click();`);
	ok("snooze writes snoozedUntil", await fileUntil(() => Date.parse(json(itemFile("issue-24")).snoozedUntil) > Date.now()));
	ok("snooze closes the dialog", await until(`!document.getElementById("detail").open`));

	// Routine write through board-put keeps a click on hidden
	await put("issue-25", { title: "Rewritten by the routine", effortMinutes: 5 });
	ok("board-put merge keeps hidden: true", json(itemFile("issue-25")).hidden === true && json(itemFile("issue-25")).title === "Rewritten by the routine");

	// Dialog stays stable while the routine rewrites the open item
	await openItem("issue-21");
	await ev(`window.__ta = document.querySelector("#d-routes .card.open textarea"); __ta.focus(); __ta.value = "Typed by hand"; __ta.dispatchEvent(new Event("input")); __ta.setSelectionRange(2, 5);`);
	await put("issue-21", { title: "Title changed by the routine" });
	ok("dialog title updates from a file write", await until(`document.getElementById("detail-title").textContent === "Title changed by the routine"`));
	ok("textarea kept, focus and cursor kept", await ev(`return document.querySelector("#d-routes .card.open textarea") === __ta && document.activeElement === __ta && __ta.value === "Typed by hand" && __ta.selectionStart === 2 && __ta.selectionEnd === 5;`));
	rmSync(itemFile("issue-21"));
	ok("dialog closes when the item file is deleted", await until(`!document.getElementById("detail").open`));

	// Synthetic data written as files, like the routine does
	const iso = (ms) => new Date(Date.now() - ms).toISOString();
	const simple = (n, section, effort, priority, extra) => ({ kind: "issue", number: n, title: "Item " + n, url: "https://github.com/acme/widgets/issues/" + n, author: "user" + n, authorType: "contributor", section, effortMinutes: effort, priority, updatedAt: iso(n * 1000), routes: [{ id: "r0", type: "chore", as: "bot", title: "", params: { action: "update_branch" }, recommended: true }], ...extra });
	const setItems = (list) => {
		for (const n of readdirSync(join(BOARD, "items"))) rmSync(join(BOARD, "items", n));
		for (const [id, d] of list) writeFileSync(itemFile(id), JSON.stringify(d));
	};
	const setActions = (list) => {
		for (const n of readdirSync(join(BOARD, "actions"))) rmSync(join(BOARD, "actions", n));
		for (const [id, d] of list) writeFileSync(join(BOARD, "actions", id + ".json"), JSON.stringify(d));
	};
	const ids = (g) => ev(`return [...document.querySelectorAll("#group-${g} .row")].map((r) => r.dataset.id.replace("widgets/", "")).join(",");`);
	const settle = () => sleep(700);
	setActions([]);
	const future = new Date(Date.now() + 3 * 86400000).toISOString();
	setItems([["issue-1", simple(1, "active", 5, 1)], ["issue-2", simple(2, "easy", 5, 1)], ["issue-3", simple(3, "almost", 5, 1)], ["issue-4", simple(4, "review", 5, 1)], ["issue-5", simple(5, "deferred", 5, 1)], ["issue-6", simple(6, "hardware", 5, 1)], ["issue-7", simple(7, "active", 5, 1, { snoozedUntil: future })], ["issue-8", simple(8, "easy", 5, 1, { hidden: true })]]);
	await settle();
	ok("grouping by section", (await ids("quick")) === "issue-1,issue-2" && (await ids("after")) === "issue-3,issue-4" && (await ids("later")) === "issue-5,issue-6");
	await ev(`document.querySelector("#group-later .show-all").click();`);
	ok("snoozed item in third group", (await ids("later")) === "issue-5,issue-6,issue-7");
	ok("dismissed hidden by default", !(await ids("later")).includes("issue-8"));
	await ev(`state.reveal.clear(); render();`);

	setItems([["issue-1", simple(1, "active", 300, 1)], ["issue-2", simple(2, "almost", 120, 1)], ["issue-3", simple(3, "review", 45, 1)], ["issue-4", simple(4, "deferred", 15, 1)], ["issue-5", simple(5, "hardware", 30, 1)]]);
	await settle();
	ok("budget fill across groups with skip", (await ids("quick")) === "issue-1" && (await ids("after")) === "issue-3" && (await ids("later")) === "issue-4");

	setItems(Array.from({ length: 8 }, (_, i) => ["issue-" + (i + 1), simple(i + 1, "easy", 10, i + 1)]));
	await settle();
	ok("quick capped at 5", (await ids("quick")) === "issue-1,issue-2,issue-3,issue-4,issue-5");
	setItems(Array.from({ length: 8 }, (_, i) => ["issue-" + (i + 1), simple(i + 1, "easy", 10, i + 1, i === 0 ? { handled: { at: iso(60000), routeId: "r0", routeType: "chore", verified: null } } : {})]));
	await settle();
	ok("next planned item moves up", (await ids("quick")) === "issue-2,issue-3,issue-4,issue-5,issue-6");
	ok("handled time counts as spent", await ev(`return document.querySelector("#plan .sum").textContent === "10 min of 6 h";`));
	setItems(Array.from({ length: 8 }, (_, i) => ["issue-" + (i + 1), simple(i + 1, "easy", 10, i + 1)]));
	setActions([["issue-1-2", { itemId: "issue-1", action: "reanalyze", status: "done", via: "queue", createdAt: iso(60000), finishedAt: iso(30000), params: {}, text: "", result: "" }]]);
	await settle();
	ok("a finished re-analysis returns the item to its place by priority", (await ids("quick")) === "issue-1,issue-2,issue-3,issue-4,issue-5");
	setActions([]);

	setItems(Array.from({ length: 25 }, (_, i) => ["issue-" + (i + 1), simple(i + 1, "almost", 60, i + 1, i === 0 ? { hint: "Maybe reply that a PR is welcome" } : {})]));
	await settle();
	ok("afterwards shows the 6 planned rows", (await ids("after")).split(",").length === 6);
	await ev(`document.querySelector("#group-after .show-all").click();`);
	ok("show more reveals 10", (await ids("after")).split(",").length === 16);
	ok("hint shown", await ev(`return document.querySelector('.row[data-id="widgets/issue-1"] .r-hint')?.textContent === "Maybe reply that a PR is welcome";`));
	ok("no hint without hint", await ev(`return !document.querySelector('.row[data-id="widgets/issue-2"] .r-hint');`));
	ok("no duplicate rows", await ev(`const a = [...document.querySelectorAll("#board .row")].map((r) => r.dataset.id); return new Set(a).size === a.length;`));
	await ev(`state.reveal.clear(); render();`);

	const yday = iso(2 * 86400000);
	const prx = (n, extra) => simple(n, "easy", 1, n, { kind: "pr", ci: "passing", ...extra });
	setItems([
		["issue-1", simple(1, "easy", 1, 1)], ["issue-2", simple(2, "easy", 1, 2, { solved: true })], ["issue-4", simple(4, "easy", 1, 4)],
		["pr-6", prx(6, { mergeable: "mergeable", reviewDecision: "approved" })], ["pr-7", prx(7, { mergeable: "conflicting", reviewDecision: "changes_requested" })],
		["pr-8", prx(8, { reviewDecision: "pending" })], ["pr-9", prx(9, { isDraft: true })], ["pr-10", prx(10, {})],
		["disc-13", simple(13, "easy", 1, 13, { kind: "discussion" })], ["disc-14", simple(14, "easy", 1, 14, { kind: "discussion", isAnswered: true })], ["disc-15", simple(15, "easy", 1, 15, { kind: "discussion" })],
	]);
	setActions([
		["issue-4-1", { itemId: "issue-4", action: "close", params: { reason: "not_planned" }, status: "done", via: "mcp", createdAt: yday }],
		["pr-10-1", { itemId: "pr-10", action: "merge", params: {}, status: "done", via: "mcp", createdAt: yday }],
		["disc-15-1", { itemId: "disc-15", action: "close", params: {}, status: "done", via: "mcp", createdAt: yday }],
	]);
	await settle();
	await ev(`for (let i = 0; i < 4; i++) for (const b of document.querySelectorAll(".show-all")) if (!b.hidden) b.click();`);
	const labels = await ev(`const o = {}; for (const r of document.querySelectorAll("#board .row")) o[r.dataset.id.replace("widgets/", "")] = [r.querySelector(".r-kind svg").getAttribute("aria-label"), r.querySelector(".r-rev svg")?.getAttribute("aria-label") ?? ""]; return o;`);
	const expect = {
		"issue-1": ["Issue, open", ""], "issue-2": ["Issue, open", ""], "issue-4": ["Issue, closed as not planned", ""],
		"pr-6": ["Pull request, ready", "Review approved"], "pr-7": ["Pull request, has conflicts", "Changes requested"], "pr-8": ["Pull request, open", "Review pending"],
		"pr-9": ["Pull request, draft", ""], "pr-10": ["Pull request, merged", ""],
		"disc-13": ["Discussion, open", ""], "disc-14": ["Discussion, answered", ""], "disc-15": ["Discussion, closed", ""],
	};
	const bad = Object.entries(expect).filter(([id, v]) => JSON.stringify(labels[id]) !== JSON.stringify(v)).map(([id]) => id + "=" + JSON.stringify(labels[id]));
	ok("status icon mapping " + bad.join(" "), bad.length === 0);

	// Restore the real items for the screenshot
	setActions([]);
	setItems([]);
	writeFixtureItems();
	await settle();
	await ev(`state.reveal.clear(); render(); window.scrollTo(0, 0);`);
	await sleep(2500);
	ok("wrapped rows keep columns on the first title line", await ev(`const rows = [...document.querySelectorAll("#board .row")].filter((r) => r.querySelector(".r-title").getBoundingClientRect().height > 30);
		return rows.length > 0 && rows.every((r) => { const t = r.querySelector(".r-title").getBoundingClientRect().top; return [".r-num", ".r-cat", ".r-effort", ".r-age"].every((s) => Math.abs(r.querySelector(s).getBoundingClientRect().top - t) < 1.5); });`));
	ok("short category chips", await ev(`return [...document.querySelectorAll("#board .cat")].every((c) => ["Active", "Easy", "Almost", "Review", "Later", "Hardware", "Snoozed"].includes(c.textContent));`));
	if (SHOT) {
		const shot = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
		writeFileSync(SHOT, Buffer.from(shot.result.data, "base64"));
	}

	// Event stream drop switches the icon, reconnect restores it
	server.kill();
	ok("icon goes offline when the stream drops", await until(`document.getElementById("conn").dataset.state === "queued"`, 8000));
	await startServer();
	ok("reconnects automatically", await until(`document.getElementById("conn").dataset.state === "connected"`, 10000));
	ok("no script errors or CSP violations " + problems.join(" | "), problems.length === 0);
} catch (e) {
	results.push("ERROR " + e.stack);
} finally {
	console.log(results.filter((l) => !l.startsWith("PASS")).join("\n"));
	const pass = results.filter((l) => l.startsWith("PASS")).length;
	const failed = results.length - pass;
	console.log(`page (served): ${pass} passed, ${failed} failed`);
	process.exitCode = failed ? 1 : 0;
	ws.close();
	chrome.kill();
	server.kill();
	await sleep(300);
	removeDir(DIR);
}
