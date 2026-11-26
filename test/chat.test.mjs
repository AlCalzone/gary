// Chat with Gary: the chat store, `gary chat`, the queue line and heartbeat of `gary watch-queue --all`, the server's
// /api/chat with its event, and `gary board` against the running server. Runs offline, and no agent starts.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("chat");
const T = tempDir();
const port = await freePort();
const { home, root, env } = makeHome(T, { port });
process.env.GARY_HOME = root;
const chatLib = await import("../scripts/lib/chat.mjs");
const { ANSWER_MS, MAX_MESSAGE, PICKUP_MS, addReply, addUserMessage, chatDir, failMessage, lateness, markSent, masterState, queuedMessages, readChat, readChats, watcherFile } = chatLib;

const gary = (args, input) => spawnSync(process.execPath, [GARY, ...args], { env, encoding: "utf8", input });
const json = (r) => {
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { unparsed: r.stdout + r.stderr };
	}
};
const lines = (r) => r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const refused = async (fn) => {
	try {
		await fn();
		return null;
	} catch (e) {
		return e;
	}
};
const file = (name, text) => {
	const f = join(T, name);
	writeFileSync(f, text);
	return f;
};

try {
	// ---------- the store ----------
	const first = await addUserMessage({ text: "Explain my settings\nplease" });
	const c1 = first.chat;
	t.check("a message without a chat starts one, queued, with the first line as title", /^c-[a-z0-9]+$/.test(c1.id) && c1.title === "Explain my settings" && c1.session === null && first.message.status === "queued" && /^m-[a-z0-9]+$/.test(first.message.id) && first.message.role === "user", c1);
	t.check("the chat lives in the root's state, not in an instance", existsSync(join(root, "state", "chat", c1.id + ".json")) && !existsSync(join(home, "state", "chat")));
	let e = await refused(() => addUserMessage({ chatId: c1.id, text: "And now?" }));
	t.check("a second message waits while the answer is pending", e?.refused === true && e.pending === true && /still answering/.test(e.message), e?.message);
	e = await refused(() => addUserMessage({ text: "   " }));
	t.check("an empty message is refused", e?.refused === true && /Write a message/.test(e.message));
	e = await refused(() => addUserMessage({ text: "x".repeat(MAX_MESSAGE + 1) }));
	t.check("a message over the limit is refused", e?.refused === true && /at most 4000/.test(e.message));
	e = await refused(() => addUserMessage({ chatId: "c-gone000000", text: "hi" }));
	t.check("a message to a chat that is gone is refused", e?.gone === true);
	e = await refused(() => addUserMessage({ chatId: "../etc", text: "hi" }));
	t.check("a chat id outside the pattern is an error", e && !e.refused && /chat id must match/.test(e.message));
	t.check("the queue lists the queued message", (await queuedMessages()).some((q) => q.chatId === c1.id && q.messageId === first.message.id));

	const now = Date.now();
	t.check("a queued message is late after the pickup time, a sent one after the answer time",
		lateness({ role: "user", status: "queued", at: new Date(now - PICKUP_MS - 1000).toISOString() }, now) === "not-picked-up"
		&& lateness({ role: "user", status: "queued", at: new Date(now - 1000).toISOString() }, now) === null
		&& lateness({ role: "user", status: "sent", at: new Date(now - ANSWER_MS * 2).toISOString(), sentAt: new Date(now - ANSWER_MS - 1000).toISOString() }, now) === "no-answer"
		&& lateness({ role: "user", status: "answered", at: new Date(0).toISOString() }, now) === null);

	e = await refused(() => markSent({ chatId: c1.id, messageId: first.message.id, harness: "t3code", session: {} }));
	t.check("marking sent needs the session", /--session/.test(e?.message ?? ""));
	const sent = await markSent({ chatId: c1.id, messageId: first.message.id, harness: "t3code", session: { id: "thread-9", link: "javascript:alert(1)", title: "Gary chat" } });
	t.check("marking sent records the session and drops a link of another scheme", sent.message.status === "sent" && typeof sent.message.sentAt === "string" && sent.chat.session.id === "thread-9" && sent.chat.session.link === null && sent.chat.session.harness === "t3code", sent.chat.session);
	const replied = await addReply({ chatId: c1.id, messageId: first.message.id, text: "You have one instance, **widgets**." });
	const afterReply = await readChat(c1.id);
	t.check("a reply answers the message and adds Gary's message after it", afterReply.messages.length === 2 && afterReply.messages[0].status === "answered" && afterReply.messages[1].role === "gary" && afterReply.messages[1].replyTo === first.message.id && afterReply.messages[1].id === replied.reply.id);
	e = await refused(() => addReply({ chatId: c1.id, messageId: first.message.id, text: "again" }));
	t.check("a second reply to the same message is refused", e?.refused === true);
	e = await refused(() => addReply({ chatId: c1.id, messageId: replied.reply.id, text: "x" }));
	t.check("a reply names a message of the maintainer", /no message/.test(e?.message ?? ""));

	// A late message makes room for the next one and fails with a reason
	const second = await addUserMessage({ chatId: c1.id, text: "Snooze everything from dependabot for 3 days" });
	const later = Date.now() + PICKUP_MS + 5000;
	const third = await addUserMessage({ chatId: c1.id, text: "Hello?", now: later });
	const c1now = await readChat(c1.id);
	const old = c1now.messages.find((m) => m.id === second.message.id);
	t.check("a message the master did not pick up fails when the next one comes", old.status === "failed" && /did not pick up/.test(old.reason) && third.message.status === "queued", old);
	await failMessage({ chatId: c1.id, messageId: third.message.id, reason: "No T3 project holds the core." });
	t.check("a failed message keeps its reason", (await readChat(c1.id)).messages.at(-1).reason === "No T3 project holds the core.");
	const lateReply = await addReply({ chatId: c1.id, messageId: second.message.id, text: "Done after all." });
	t.check("a late answer still lands and clears the reason", lateReply.message.status === "answered" && lateReply.message.reason === undefined);

	// A stale lock from a dead process does not block
	writeFileSync(join(chatDir(), c1.id + ".json.lock"), "");
	utimesSync(join(chatDir(), c1.id + ".json.lock"), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
	t.check("a stale lock is taken over", (await addUserMessage({ chatId: c1.id, text: "After the lock" })).message.status === "queued");

	// ---------- gary chat ----------
	const c2 = (await addUserMessage({ text: "Mark all FYI items for merged PRs as Got it" })).chat;
	const m2 = c2.messages[0].id;
	let r = gary(["chat", "brief", c2.id, "--message", m2, "--harness", "t3code"]);
	let b = json(r);
	t.check("brief prints the first prompt for a chat without a session", r.status === 0 && typeof b.briefing === "string" && b.note === undefined && b.session === null && b.core === ROOT && b.model === "sonnet" && b.title === "Gary chat: Mark all FYI items for merged PRs as Got it", b);
	t.check("the briefing points to the skill, names the hard limits and fences the message", b.briefing.includes(`${ROOT}/skills/triage-chat/SKILL.md`) && /never post, comment, review, merge, close, label or push/.test(b.briefing)
		&& b.briefing.includes("<<<\nMark all FYI items for merged PRs as Got it\n>>>") && b.briefing.includes(`gary chat reply ${c2.id} --message ${m2} --file`) && b.briefing.includes(`gary chat fail ${c2.id} --message ${m2}`) && /- widgets \(maintainer\)/.test(b.briefing), b.briefing);
	r = gary(["chat", "brief", c2.id, "--message", m2]);
	t.check("brief needs the harness", r.status === 1 && /--harness/.test(json(r).result));
	r = gary(["chat", "start", c2.id, "--message", m2, "--harness", "t3code", "--session", "thread-2", "--link", "t3-thread://thread-2", "--title", "Gary chat: Mark all"]);
	t.check("start records the session and marks the message sent", r.status === 0 && json(r).status === "sent" && json(r).session.link === "t3-thread://thread-2", json(r));
	r = gary(["chat", "brief", c2.id, "--message", m2, "--harness", "t3code"]);
	t.check("brief refuses a message that is no longer queued, with exit 3", r.status === 3 && json(r).refused === true && /sent already/.test(json(r).result));
	r = gary(["chat", "reply", c2.id, "--message", m2, "--file", "-"], "These 2 match:\n\n- `mine/other.lib.pr-8`\n");
	t.check("reply reads the answer from stdin", r.status === 0 && json(r).replyId && (await readChat(c2.id)).messages[1].text.startsWith("These 2 match"), r.stdout + r.stderr);
	r = gary(["chat", "reply", c2.id, "--message", m2, "--file", file("a.md", "again")]);
	t.check("reply twice exits 3", r.status === 3);

	const m3 = (await addUserMessage({ chatId: c2.id, text: "Now do it" })).message.id;
	r = gary(["chat", "brief", c2.id, "--message", m3, "--harness", "t3code"]);
	b = json(r);
	t.check("a follow-up gets the short note for the recorded session", r.status === 0 && typeof b.note === "string" && b.briefing === undefined && b.session.id === "thread-2" && b.note.includes("<<<\nNow do it\n>>>") && b.note.includes(`--message ${m3}`), b);
	r = gary(["chat", "brief", c2.id, "--message", m3, "--harness", "claude-desktop"]);
	t.check("a session of another harness gets the first prompt", typeof json(r).briefing === "string");
	r = gary(["chat", "brief", c2.id, "--message", m3, "--harness", "t3code", "--new"]);
	b = json(r);
	t.check("--new gets the first prompt with the chat so far", typeof b.briefing === "string" && /The chat so far/.test(b.briefing) && b.briefing.includes("Maintainer, ") && b.briefing.includes("These 2 match") && b.briefing.indexOf("The chat so far") < b.briefing.indexOf("<<<\nNow do it"), b.briefing);
	r = gary(["chat", "fail", c2.id, "--message", m3, "--reason", "Gary runs in a terminal, which cannot start a session."]);
	t.check("fail marks the message failed", r.status === 0 && (await readChat(c2.id)).messages.at(-1).status === "failed");
	r = gary(["chat", "fail", c2.id, "--message", m3]);
	t.check("fail needs a reason", r.status === 1 && /--reason/.test(json(r).result));
	r = gary(["chat", "show", c2.id]);
	t.check("show prints the chat as text", r.status === 0 && /Maintainer \(answered\):\nMark all FYI/.test(r.stdout) && /Gary:\nThese 2 match/.test(r.stdout) && /\[Gary runs in a terminal/.test(r.stdout), r.stdout);
	r = gary(["chat", "list", "--json"]);
	t.check("list prints every chat, newest first, without the messages", r.status === 0 && json(r).chats.length === 2 && json(r).chats[0].id === c2.id && typeof json(r).chats[0].messages === "number", json(r));
	r = gary(["help"]);
	t.check("the help lists gary chat and gary board", /^\s+chat\s/m.test(r.stdout) && /^\s+board\s/m.test(r.stdout));

	// ---------- the queue ----------
	const c3 = (await addUserMessage({ text: "Explain the Quick & Easy group" })).chat;
	r = gary(["watch-queue", "--all", "--once"]);
	let q = lines(r).filter((l) => l.action === "chat");
	t.check("watch-queue --all prints each queued chat message once, oldest first", q.length === 2 && q.every((l) => l.instance === null && l.itemId === null && l.id === l.messageId) && q.at(-1).chatId === c3.id && q.at(-1).messageId === c3.messages[0].id, q);
	r = gary(["watch-queue", "--once"]);
	t.check("watch-queue for one instance prints no chat line", !lines(r).some((l) => l.action === "chat"));
	gary(["pause"]);
	r = gary(["watch-queue", "--all", "--once"]);
	t.check("a chat message prints while the instances are paused", lines(r).filter((l) => l.action === "chat").length === 2);
	gary(["resume"]);
	t.check("--once writes no heartbeat", !existsSync(watcherFile()));
	t.check("without a heartbeat the master counts as not running", masterState().running === false);
	const watcher = spawn(process.execPath, [GARY, "watch-queue", "--all"], { env, stdio: ["ignore", "pipe", "ignore"] });
	let watched = "";
	watcher.stdout.on("data", (d) => (watched += d));
	for (let i = 0; i < 50 && !existsSync(watcherFile()); i++) await sleep(100);
	t.check("watch-queue --all writes a heartbeat that counts as a running master", masterState().running === true);
	const c4 = (await addUserMessage({ text: "Hi Gary" })).chat;
	for (let i = 0; i < 50 && !watched.includes(c4.id); i++) await sleep(100);
	t.check("a new chat message prints within seconds", watched.includes(`"chatId":"${c4.id}"`), watched);
	watcher.kill("SIGTERM");
	await new Promise((res) => watcher.on("exit", res));
	t.check("a watcher that stopped marks its heartbeat, which then does not count", JSON.parse(readFileSync(watcherFile(), "utf8")).stopped === true && masterState().running === false);
	writeFileSync(watcherFile(), JSON.stringify({ pid: 1, at: new Date().toISOString() }));
	t.check("a fresh heartbeat counts whatever its pid", masterState().running === true);
	writeFileSync(watcherFile(), JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 10 * 60000).toISOString() }));
	t.check("an old heartbeat does not count", masterState().running === false);
	writeFileSync(watcherFile(), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

	// ---------- the board server ----------
	writeFileSync(join(home, "state", "board", "items", "issue-21.json"), JSON.stringify({ kind: "issue", repo: "acme/widgets", number: 21, title: "LED blinks", url: "https://github.com/acme/widgets/issues/21", author: "someone", authorType: "contributor", category: "act", priority: 1, effortMinutes: 5, reviewDepth: "quick", state: "s", routes: [{ id: "r1", type: "follow_up", as: "agent", title: "Start fix", text: "x" }, { id: "r2", type: "reply", as: "me", title: "Reply", text: "y" }] }));
	const child = spawn(process.execPath, [join(ROOT, "server", "server.mjs"), "--dry-run", "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	try {
		for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await sleep(100);
		const TOKEN = readFileSync(join(root, "state", "server-token"), "utf8").trim();
		const api = async (body, headers = {}) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "X-Board-Token": TOKEN, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
			return { status: res.status, data: await res.json() };
		};
		let a = await api({ op: "get" });
		t.check("get without a chat id answers the newest chat and the master state", a.status === 200 && a.data.ok === true && a.data.chat?.id === c4.id && a.data.master.running === true, a.data);
		a = await api({ op: "get", chatId: c1.id });
		t.check("get with a chat id answers that chat", a.data.chat?.id === c1.id);
		a = await api({ op: "status" });
		t.check("status answers only the master state", a.status === 200 && a.data.ok === true && a.data.master.running === true && a.data.chat === undefined);
		a = await api({ op: "get", chatId: "nope" });
		t.check("a chat id outside the pattern is refused", a.status === 400);
		a = await api({ op: "get" }, { "X-Board-Token": "0".repeat(64) });
		t.check("the chat needs the board token", a.status === 401);
		const evil = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "X-Board-Token": TOKEN, "Content-Type": "application/json", Origin: "http://evil.example" }, body: "{}" });
		t.check("a foreign origin is refused", evil.status === 403);

		// The event stream sends the chat when a reply lands
		const ctrl = new AbortController();
		const es = await fetch(`http://127.0.0.1:${port}/api/events?token=${TOKEN}`, { signal: ctrl.signal });
		let events = "";
		(async () => {
			const dec = new TextDecoder();
			try {
				for await (const chunk of es.body) events += dec.decode(chunk);
			} catch {
				// Aborted at the end
			}
		})();
		await sleep(300);
		a = await api({ op: "send", text: "Snooze everything from dependabot for 3 days" });
		const c5 = a.data.chat;
		t.check("send starts a chat and answers it with the queued message", a.status === 200 && a.data.ok === true && c5.messages.length === 1 && c5.messages[0].status === "queued" && c5.messages[0].text === "Snooze everything from dependabot for 3 days", a.data);
		a = await api({ op: "send", chatId: c5.id, text: "And the rest" });
		t.check("send refuses while the answer is pending, with 409", a.status === 409 && a.data.ok === false && a.data.pending === true, a.data);
		a = await api({ op: "send", text: "x".repeat(MAX_MESSAGE + 1) });
		t.check("send refuses a message over the limit", a.status === 200 && a.data.ok === false && /at most/.test(a.data.result));
		a = await api({ op: "send", text: 5 });
		t.check("send refuses a text that is no string", a.status === 400);
		a = await api({ op: "nope" });
		t.check("an unknown op is refused", a.status === 400);
		const m5 = c5.messages[0].id;
		gary(["chat", "start", c5.id, "--message", m5, "--harness", "t3code", "--session", "thread-5"]);
		gary(["chat", "reply", c5.id, "--message", m5, "--file", file("r5.md", "I snoozed 3 items.")]);
		for (let i = 0; i < 50 && !events.includes("I snoozed 3 items."); i++) await sleep(100);
		const chatEvent = events.split("\n\n").filter((b) => b.startsWith("event: chat")).map((b) => JSON.parse(b.split("\ndata: ")[1])).findLast((d) => d.chat.id === c5.id);
		t.check("the event stream pushes the chat with the answer and the master state", chatEvent?.instance === null && chatEvent.chat.messages.at(-1).text === "I snoozed 3 items." && chatEvent.master?.running === true, events.slice(-600));
		ctrl.abort();

		// Six messages per minute from all pages together
		let last;
		for (let i = 0; i < 6; i++) last = await api({ op: "send", text: "spam " + i });
		t.check("send is limited per minute", last.status === 429 && typeof last.data.retryAfter === "number" && /Try again/.test(last.data.result), last);

		// The full logo for the dialog, in both themes
		const logo = await fetch(`http://127.0.0.1:${port}/logo-full.svg`);
		const dark = await fetch(`http://127.0.0.1:${port}/logo-full-dark.svg`);
		t.check("the server serves the full logo and its version for the dark theme", logo.status === 200 && logo.headers.get("content-type") === "image/svg+xml" && (await logo.text()) === readFileSync(join(ROOT, "logo.svg"), "utf8")
			&& dark.status === 200 && (await dark.text()) === readFileSync(join(ROOT, "logo-outlined.svg"), "utf8"));

		// ---------- gary board ----------
		const board = (...args) => {
			const r = gary(["board", ...args]);
			return { status: r.status, out: (() => { try { return JSON.parse(r.stdout); } catch { return { text: r.stdout }; } })() };
		};
		const item = () => JSON.parse(readFileSync(join(home, "state", "board", "items", "issue-21.json"), "utf8"));
		const actions = () => readdirSync(join(home, "state", "board", "actions")).map((n) => JSON.parse(readFileSync(join(home, "state", "board", "actions", n), "utf8")));
		let o = board("list", "--json");
		t.check("list prints the served items with keys, state and routes", o.status === 0 && o.out.count === 1 && o.out.items[0].key === "widgets/issue-21" && o.out.items[0].state === "open" && o.out.items[0].routes.map((x) => x.id).join() === "r1,r2", o.out);
		t.check("list filters", board("list", "--category", "fyi", "--json").out.count === 0 && board("list", "--kind", "issue", "--json").out.count === 1);
		o = board("snooze", "widgets/issue-21", "--days", "3");
		const snoozed = item().snoozedUntil;
		t.check("snooze sets the snooze through the server and logs it", o.status === 0 && o.out.done === 1 && Date.parse(snoozed) > Date.now() + 2.9 * 86400000 && actions().some((x) => x.action === "snooze" && x.params.days === 3 && x.via === "chat" && x.status === "done"), o.out);
		t.check("snooze needs days from 1 to 90", board("snooze", "issue-21", "--days", "200").out.results[0].ok === false);
		o = board("hide", "issue-21");
		t.check("hide takes an item id of the resolved instance", o.status === 0 && item().hidden === true && actions().some((x) => x.action === "dismiss"));
		o = board("restore", "issue-21");
		t.check("restore ends the snooze and the hide", o.status === 0 && item().hidden === false && item().snoozedUntil === null);
		o = board("analyze", "issue-21", "--note", "Check the LED again");
		t.check("analyze queues Analyze again with the note", o.status === 0 && actions().some((x) => x.action === "reanalyze" && x.status === "queued" && x.text === "Check the LED again" && x.via === "queue"));
		o = board("review", "issue-21");
		t.check("review queues a full review", o.status === 0 && actions().some((x) => x.action === "full_review" && x.status === "queued"));
		o = board("dismiss-route", "issue-21", "--route", "r2", "--reason", "Not needed");
		t.check("dismiss-route runs the server's dismiss", o.status === 0 && item().routes.map((x) => x.id).join() === "r1" && item().dismissedRoutes?.some((d) => d.type === "reply" && d.reason === "Not needed"), [o.out, item().dismissedRoutes]);
		o = board("got-it", "issue-21");
		t.check("got-it on an item that is no fyi is refused by the server", o.status === 1 && /Only an FYI item/.test(o.out.results[0].result));
		o = board("hide", "widgets/issue-404");
		t.check("an item that does not exist is refused", o.status === 1 && /does not exist/.test(o.out.results[0].result), o.out);
		o = board("hide", "../x");
		t.check("a key outside the pattern is refused before any request", o.status === 1 && /no item key/.test(o.out.result));
	} finally {
		child.kill("SIGTERM");
		await new Promise((res) => child.on("exit", res));
	}
	const o = JSON.parse(gary(["board", "hide", "issue-21"]).stdout);
	const item21 = () => JSON.parse(readFileSync(join(home, "state", "board", "items", "issue-21.json"), "utf8"));
	t.check("without a running server gary board says so and writes nothing", o.ok === false && /does not answer/.test(o.results[0].result) && item21().hidden === false, o);
	t.check("readChats sees every chat", (await readChats()).length >= 5);
} finally {
	removeDir(T);
}
t.done();
