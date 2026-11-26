// Chat with Gary from the board. A chat is <root>/state/chat/<chatId>.json and belongs to the machine, not to an instance.
// At most one chat is active. "New chat" on the board archives it, and the next message starts a new one.
// The board server stores the maintainer's messages. `gary watch-queue --all` prints each queued one, and the master hands
// it to the chat session in its harness. The chat session answers with `gary chat reply`. Nothing here runs an agent.
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readJson, writeAtomic } from "./board-store.mjs";
import { rootStateDir } from "./config.mjs";

export const CHAT_ID = /^c-[a-z0-9]{6,40}$/;
export const MESSAGE_ID = /^m-[a-z0-9]{6,40}$/;
export const MAX_MESSAGE = 4000;
export const MAX_ANSWER = 20000;
export const MAX_REASON = 500;
// `MAX_MESSAGES` caps one chat, so a chat file stays small enough to send to the page on every change
export const MAX_MESSAGES = 200;
export const MAX_CHATS = 50;
// A queued message older than `PICKUP_MS` counts as not picked up, and a sent one without an answer after `ANSWER_MS` as late
export const PICKUP_MS = 2 * 60000;
export const ANSWER_MS = 10 * 60000;
// `WATCHER_FRESH_MS` sets how old the queue watcher's heartbeat may be while the master still counts as running
export const WATCHER_FRESH_MS = 3 * 60000;
export const USER_STATUSES = ["queued", "sent", "answered", "failed"];
const PENDING = new Set(["queued", "sent"]);
// The board opens only session links of these schemes
const LINK = /^(https:\/\/|t3-thread:\/\/|claude:\/\/)[^\s"'<>]{1,1000}$/;
const MAX_FIELD = 500;
const LOCK_STALE_MS = 10000;

export const chatDir = () => join(rootStateDir(), "chat");
export const chatFile = (chatId) => join(chatDir(), chatId + ".json");
export const watcherFile = () => join(rootStateDir(), "watch-queue.json");

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
const iso = (t = Date.now()) => new Date(t).toISOString();
const short = (v, max = MAX_FIELD) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function checkChatId(chatId) {
	if (!CHAT_ID.test(chatId ?? "")) throw new Error(`The chat id must match ${CHAT_ID}`);
}

/** Whether a message of the maintainer still waits for its answer. */
export const isPending = (m) => m?.role === "user" && PENDING.has(m.status);

/**
 * Runs `fn` while this process holds the lock file of the chat. The board server and `gary chat` both change chat files,
 * so every change of one goes through here.
 */
async function withChatLock(chatId, fn) {
	const lock = chatFile(chatId) + ".lock";
	await mkdir(chatDir(), { recursive: true });
	for (let i = 0; ; i++) {
		try {
			closeSync(openSync(lock, "wx"));
			break;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
			} catch {
				// Another process removed it in the meantime
			}
			if (i > 100) throw new Error(`The chat ${chatId} is locked by another process`);
			await sleep(20);
		}
	}
	try {
		return await fn();
	} finally {
		try {
			unlinkSync(lock);
		} catch {
			// Another process removed it as stale
		}
	}
}

/** The chat, or null. */
export async function readChat(chatId) {
	checkChatId(chatId);
	const chat = await readJson(chatFile(chatId));
	return chat && Array.isArray(chat.messages) ? chat : null;
}

/** Every chat, newest first. */
export async function readChats() {
	let names = [];
	try {
		names = (await readdir(chatDir())).filter((n) => n.endsWith(".json") && !n.startsWith(".") && CHAT_ID.test(n.slice(0, -5)));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const chats = (await Promise.all(names.map((n) => readChat(n.slice(0, -5))))).filter(Boolean);
	return chats.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** The one active chat, or null. A chat is active until `archiveActive` archives it. */
export async function activeChat() {
	return (await readChats()).find((c) => !c.archivedAt) ?? null;
}

/**
 * Archives every active chat and returns them. A message that still waits for its answer fails, because the maintainer
 * moved on. The chat's session stays recorded until `markSessionClosed`.
 */
export async function archiveActive(now = Date.now()) {
	const archived = [];
	for (const { id } of (await readChats()).filter((c) => !c.archivedAt)) {
		const chat = await withChatLock(id, async () => {
			const chat = await readChat(id);
			if (!chat || chat.archivedAt) return null;
			chat.archivedAt = iso(now);
			for (const m of chat.messages) {
				if (!isPending(m)) continue;
				m.status = "failed";
				m.reason = "You started a new chat before the answer came.";
				m.failedAt = iso(now);
			}
			await writeAtomic(chatFile(id), chat);
			return chat;
		});
		if (chat) archived.push(chat);
	}
	return archived;
}

/** The archived chats whose session the master has not closed yet: `[{ chatId, harness, session }]`. */
export async function archivedSessions() {
	return (await readChats()).filter((c) => c.archivedAt && c.session?.id && !c.session.closedAt).map((c) => ({ chatId: c.id, harness: c.session.harness, session: c.session.id }));
}

/**
 * The session of the newest archived chat that the master could not close, in the given harness: `{ chatId, session }`,
 * or null. A new chat may take it over.
 */
export async function reusableSession(harness) {
	const chat = (await readChats()).find((c) => c.archivedAt && c.session?.id && !c.session.closedAt && c.session.harness === harness);
	return chat ? { chatId: chat.id, session: chat.session } : null;
}

/** Records that the master closed the session of an archived chat. */
export async function markSessionClosed(chatId) {
	checkChatId(chatId);
	return withChatLock(chatId, async () => {
		const chat = await readChat(chatId);
		if (!chat) throw new Error(`There is no chat ${chatId}`);
		if (!chat.archivedAt) throw Object.assign(new Error("The chat is still active. Its session stays open."), { refused: true });
		if (chat.session && !chat.session.closedAt) {
			chat.session.closedAt = iso();
			await writeAtomic(chatFile(chatId), chat);
		}
		return chat;
	});
}

/** The queued messages of the maintainer in the active chat, oldest first: `[{ chatId, messageId, at }]`. */
export async function queuedMessages() {
	const out = [];
	for (const chat of (await readChats()).filter((c) => !c.archivedAt)) {
		for (const m of chat.messages) if (m.role === "user" && m.status === "queued") out.push({ chatId: chat.id, messageId: m.id, at: m.at });
	}
	return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Whether a message of the maintainer is late: queued past `PICKUP_MS` or sent past `ANSWER_MS`. */
export function lateness(m, now = Date.now()) {
	if (!isPending(m)) return null;
	if (m.status === "queued") return now - Date.parse(m.at) > PICKUP_MS ? "not-picked-up" : null;
	return now - Date.parse(m.sentAt ?? m.at) > ANSWER_MS ? "no-answer" : null;
}

async function pruneChats(keep) {
	const chats = await readChats();
	for (const c of chats.slice(MAX_CHATS)) {
		if (c.id === keep) continue;
		await unlink(chatFile(c.id)).catch(() => {});
	}
}

/**
 * Adds a message of the maintainer. Without `chatId` it goes to the active chat, or starts a new chat when none is
 * active. Throws with `refused: true` while an answer is pending and not late yet. A late pending message fails with a
 * reason, so the new one takes its place. An archived chat takes no message.
 */
export async function addUserMessage({ chatId = null, text, now = Date.now() }) {
	if (typeof text !== "string" || !text.trim()) throw Object.assign(new Error("Write a message first."), { refused: true });
	if (text.length > MAX_MESSAGE) throw Object.assign(new Error(`A message may have at most ${MAX_MESSAGE} characters.`), { refused: true });
	const active = chatId ? null : await activeChat();
	const started = !chatId && !active;
	const id = chatId ?? active?.id ?? newId("c");
	checkChatId(id);
	const chat = await withChatLock(id, async () => {
		const cur = await readJson(chatFile(id));
		if (cur?.archivedAt) throw Object.assign(new Error("This chat is archived. Send your message again to start a new one."), { refused: true, gone: true });
		if (chatId && !cur) throw Object.assign(new Error("This chat is gone. Start a new chat."), { refused: true, gone: true });
		const chat = cur ?? { id, createdAt: iso(now), updatedAt: iso(now), title: text.trim().split("\n")[0].slice(0, 80), session: null, messages: [] };
		const last = chat.messages.findLast((m) => m.role === "user");
		if (isPending(last)) {
			if (!lateness(last, now)) throw Object.assign(new Error("Gary is still answering your last message."), { refused: true, pending: true });
			last.reason = last.status === "queued" ? "The master session did not pick up this message." : "No answer came in time.";
			last.status = "failed";
			last.failedAt = iso(now);
		}
		if (chat.messages.length >= MAX_MESSAGES) throw Object.assign(new Error(`This chat has ${MAX_MESSAGES} messages. Start a new chat.`), { refused: true });
		chat.messages.push({ id: newId("m"), role: "user", text, at: iso(now), status: "queued" });
		chat.updatedAt = iso(now);
		await writeAtomic(chatFile(id), chat);
		return chat;
	});
	if (started) await pruneChats(id);
	return { chat, message: chat.messages.at(-1) };
}

async function changeMessage(chatId, messageId, fn) {
	checkChatId(chatId);
	if (!MESSAGE_ID.test(messageId ?? "")) throw new Error(`The message id must match ${MESSAGE_ID}`);
	return withChatLock(chatId, async () => {
		const chat = await readChat(chatId);
		if (!chat) throw new Error(`There is no chat ${chatId}`);
		const message = chat.messages.find((m) => m.id === messageId && m.role === "user");
		if (!message) throw new Error(`The chat ${chatId} has no message ${messageId} of the maintainer`);
		const out = await fn(chat, message);
		chat.updatedAt = iso();
		await writeAtomic(chatFile(chatId), chat);
		return { chat, message, ...out };
	});
}

/**
 * Records the chat session the master handed the message to, and marks the message sent. A different session replaces
 * the recorded one, for example after the old one was archived.
 */
export async function markSent({ chatId, messageId, harness, session }) {
	if (!short(harness, 40)) throw new Error("--harness must name the harness, like t3code");
	if (!short(session?.id)) throw new Error("--session must name the chat session's id");
	const sent = await changeMessage(chatId, messageId, (chat, message) => {
		if (chat.archivedAt) throw Object.assign(new Error("The chat is archived. Nothing to hand on."), { refused: true });
		if (message.status !== "queued" && message.status !== "sent") throw Object.assign(new Error(`The message is ${message.status} already. Nothing changed.`), { refused: true });
		const same = chat.session?.harness === harness && chat.session?.id === session.id;
		const link = typeof session.link === "string" && LINK.test(session.link) ? session.link : same ? chat.session.link ?? null : null;
		chat.session = { harness, id: short(session.id), link, title: short(session.title) ?? (same ? chat.session.title : null), startedAt: same ? chat.session.startedAt : iso() };
		message.status = "sent";
		message.sentAt = iso();
	});
	// An archived chat whose session now answers this chat has no session of its own left to close
	for (const old of (await readChats()).filter((c) => c.archivedAt && c.id !== chatId && c.session?.id === sent.chat.session.id && c.session.harness === harness && !c.session.closedAt)) {
		await withChatLock(old.id, async () => {
			const chat = await readChat(old.id);
			if (!chat?.session || chat.session.closedAt) return;
			chat.session.closedAt = iso();
			chat.session.reusedBy = chatId;
			await writeAtomic(chatFile(old.id), chat);
		});
	}
	return sent;
}

/** Stores Gary's answer to one message of the maintainer. A message that failed as late takes its answer too. */
export async function addReply({ chatId, messageId, text }) {
	if (typeof text !== "string" || !text.trim()) throw new Error("The answer is empty");
	const body = text.length > MAX_ANSWER ? text.slice(0, MAX_ANSWER - 1) + "…" : text;
	return changeMessage(chatId, messageId, (chat, message) => {
		if (message.status === "answered") throw Object.assign(new Error("The message has its answer already. Nothing changed."), { refused: true });
		message.status = "answered";
		message.answeredAt = iso();
		delete message.reason;
		const reply = { id: newId("m"), role: "gary", text: body, at: iso(), replyTo: messageId };
		chat.messages.push(reply);
		return { reply };
	});
}

/** Marks one message of the maintainer as failed with a reason the dialog shows. */
export async function failMessage({ chatId, messageId, reason }) {
	const why = short(reason, MAX_REASON);
	if (!why) throw new Error("--reason must say what failed");
	return changeMessage(chatId, messageId, (_chat, message) => {
		if (message.status === "answered") throw Object.assign(new Error("The message has its answer already. Nothing changed."), { refused: true });
		message.status = "failed";
		message.reason = why;
		message.failedAt = iso();
	});
}

/**
 * Writes the queue watcher's heartbeat, which tells the board that a master session follows the queue. `stopped` marks
 * the watcher's exit, so the board knows at once.
 */
export function writeHeartbeat({ now = Date.now(), stopped = false } = {}) {
	try {
		writeFileSync(watcherFile(), JSON.stringify({ pid: process.pid, at: iso(now), ...(stopped && { stopped: true }) }) + "\n");
	} catch {
		// The board then shows the master as not running
	}
}

/**
 * `{ running, at }`: whether a `gary watch-queue --all` wrote its heartbeat lately and did not stop. The pid is no proof,
 * because the watcher may run in a sandbox with its own process ids.
 */
export function masterState(now = Date.now()) {
	let beat = null;
	try {
		beat = JSON.parse(readFileSync(watcherFile(), "utf8"));
	} catch {
		return { running: false, at: null };
	}
	const at = Date.parse(beat?.at ?? "");
	if (!Number.isFinite(at)) return { running: false, at: null };
	return { running: now - at < WATCHER_FRESH_MS && beat.stopped !== true, at: iso(at) };
}
