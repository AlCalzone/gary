// The page shim of server/server.mjs across server restarts: reconnect, refetch, reload on a new page version or token.
// The shim runs in a vm context with an EventSource built on fetch, which ends for good after an HTTP error like a browser's.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import vm from "node:vm";
import { ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("server-shim");
const T = tempDir();
const PORT = await freePort();
const { root, home, env } = makeHome(T, { port: PORT });
const BOARD = join(home, "state", "board");
const base = `http://127.0.0.1:${PORT}`;
const item = (number) => ({ kind: "issue", repo: "acme/widgets", number, title: `Item ${number}`, reviewedAt: "2026-11-17T14:00:00Z", routes: [] });
writeFileSync(join(BOARD, "items", "issue-21.json"), JSON.stringify(item(21)));
const PAGE = join(ROOT, "board", "board.html");
const OTHER_PAGE = join(T, "board.html");
writeFileSync(OTHER_PAGE, readFileSync(PAGE, "utf8") + "\n<!-- another version -->\n");

let child = null;
process.on("exit", () => child?.kill("SIGTERM"));

async function start(pageFile = PAGE) {
	child = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--port", String(PORT), "--page-file", pageFile], { env, stdio: ["ignore", "inherit", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await sleep(100);
	if (!stderr.includes(" on http://127.0.0.1:")) console.log(stderr);
}

async function stop() {
	const exited = new Promise((r) => child.once("exit", r));
	child.kill("SIGTERM");
	await exited;
	child = null;
}

const waitFor = async (test, ms = 20000) => {
	for (let i = 0; i < ms / 50; i++) {
		if (test()) return true;
		await sleep(50);
	}
	return false;
};

await start();
const html = await (await fetch(base + "/")).text();
const script = /<script>\n("use strict";\n\(\(\) => \{\n {2}const TOKEN[\s\S]*?)<\/script>/.exec(html)?.[1];
t.check("the page carries the shim with its version", !!script && /const VERSION = "[0-9a-f]{16}"/.test(script));

// A browser-like EventSource: an HTTP error ends it in the closed state
const sources = [];
class FakeEventSource {
	constructor(url) {
		this.readyState = 0;
		this.listeners = new Map();
		this.ctrl = new AbortController();
		sources.push(this);
		this.run(base + url);
	}
	addEventListener(type, fn) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(fn);
	}
	fire(type, data) {
		for (const fn of this.listeners.get(type) ?? []) fn({ data, target: this });
	}
	close() {
		this.readyState = 2;
		this.ctrl.abort();
	}
	async run(url) {
		try {
			const res = await fetch(url, { signal: this.ctrl.signal });
			if (res.status !== 200) {
				this.status = res.status;
				this.readyState = 2;
				return this.fire("error");
			}
			this.readyState = 1;
			this.fire("open");
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
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
					if (event && data !== undefined) this.fire(event, data);
				}
			}
		} catch {
			// Aborted or the connection dropped
		}
		if (this.readyState !== 2) {
			this.readyState = 0;
			this.fire("error");
		}
	}
}

const fetches = [];
const target = new EventTarget();
let reloads = 0;
target.addEventListener("board:reload", () => reloads++);
const ctx = {
	EventSource: FakeEventSource,
	Event,
	CustomEvent,
	fetch: async (path, opts) => {
		const res = await fetch(base + path, opts);
		fetches.push({ path, status: res.status });
		return res;
	},
	setTimeout,
	queueMicrotask,
	encodeURIComponent,
	console,
	addEventListener: target.addEventListener.bind(target),
	dispatchEvent: target.dispatchEvent.bind(target),
	setServer: () => {},
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(script, ctx);
const db = await ctx.claude.use("db");
let ids = [];
db.collection("items").onSnapshot((snap) => (ids = snap.docs.map((d) => d.id)));
t.check("the first snapshot holds the stored item", await waitFor(() => ids.includes("widgets/issue-21")), ids);
t.check("one connection and no reload at first", sources.length === 1 && reloads === 0, { sources: sources.length, reloads });

// The chat goes through board.chat, and a changed chat arrives as the window event board:chat
const board = await ctx.claude.use("board");
const chats = [];
target.addEventListener("board:chat", (e) => chats.push(e.detail));
const sent = await board.chat({ op: "send", text: "Explain my settings" });
t.check("board.chat sends a message and answers the stored chat", sent.ok === true && sent.chat.messages[0].text === "Explain my settings" && typeof sent.master?.running === "boolean", sent);
t.check("the changed chat arrives as board:chat with the master state", await waitFor(() => chats.some((d) => d.chat.id === sent.chat.id && d.master)), chats);
const again = await board.chat({ op: "send", chatId: sent.chat.id, text: "Hello?" });
t.check("board.chat passes a refusal on with its reason", again.ok === false && again.pending === true && /still answering/.test(again.result), again);

// A restart on the same page and token: reconnect and refetch, no reload
await stop();
writeFileSync(join(BOARD, "items", "issue-22.json"), JSON.stringify(item(22)));
const before = fetches.filter((f) => f.path === "/api/state").length;
await start();
t.check("the shim reconnects after a restart", await waitFor(() => sources.length >= 2 && sources.at(-1).readyState === 1), sources.map((s) => s.readyState));
t.check("it refetched /api/state", fetches.filter((f) => f.path === "/api/state").length > before, fetches);
t.check("the item written while it was down arrives", await waitFor(() => ids.includes("widgets/issue-22")), ids);
t.check("the same page version does not reload", reloads === 0, reloads);

// A restart with another page version reloads
await stop();
await start(OTHER_PAGE);
t.check("a new page version asks for a reload", await waitFor(() => reloads > 0), reloads);

// A restart with a new token: the old token gets 401, and that reloads too
await stop();
rmSync(join(root, "state", "server-token"));
reloads = 0;
await start();
t.check("a new token asks for a reload", await waitFor(() => reloads > 0), { reloads, last: sources.at(-1)?.status });
t.check("the old token got 401 from the server", fetches.some((f) => f.status === 401), fetches.slice(-3));

await stop();
removeDir(T);
t.done();
process.exit(process.exitCode ?? 0);
