// gary chat: the maintainer's chat with Gary from the board. The master hands each message to the chat session in its
// harness, and the session answers here. Nothing here knows a harness or starts an agent.
//   gary chat brief <chatId> --message <id> --harness <h> [--new]
//     The first prompt for a new chat session, or the note for the chat's session when it has one. --new always prints
//     the first prompt, for a session that replaces an archived one.
//   gary chat start <chatId> --message <id> --harness <h> --session <id> [--link <url>] [--title <text>]
//     Records the session the master handed the message to, and marks the message sent.
//   gary chat reply <chatId> --message <id> --file <answer.md | ->
//     Stores Gary's answer. The board shows it at once.
//   gary chat fail <chatId> --message <id> --reason <text>
//     Marks the message failed, so the dialog says why no answer comes.
//   gary chat show <chatId> [--json] | list [--json]
import { readFileSync } from "node:fs";
import { chatBriefing, chatNote } from "./lib/chat-brief.mjs";
import { MAX_ANSWER, addReply, failMessage, markSent, readChat, readChats } from "./lib/chat.mjs";
import { ROOT, listInstances, modelsOf, rootDir } from "./lib/config.mjs";

const USAGE = "Usage: gary chat brief <chatId> --message <id> --harness <h> [--new] | start <chatId> --message <id> --harness <h> --session <id> [--link <url>] [--title <text>] | reply <chatId> --message <id> --file <file|-> | fail <chatId> --message <id> --reason <text> | show <chatId> [--json] | list [--json]";
const VALUES = ["--message", "--harness", "--session", "--link", "--title", "--file", "--reason"];
const FLAGS = ["--new", "--json"];

class Refused extends Error {}

function parse(argv) {
	const out = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (VALUES.includes(argv[i])) {
			if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
			out[argv[i].slice(2)] = argv[++i];
		} else if (FLAGS.includes(argv[i])) out[argv[i].slice(2)] = true;
		else if (argv[i].startsWith("--")) throw new Error(USAGE);
		else rest.push(argv[i]);
	}
	return { out, rest };
}

async function chatAndMessage(chatId, messageId) {
	if (!messageId) throw new Error("--message must name the message id from the queue line");
	const chat = await readChat(chatId);
	if (!chat) throw new Error(`There is no chat ${chatId}`);
	const message = chat.messages.find((m) => m.id === messageId && m.role === "user");
	if (!message) throw new Error(`The chat ${chatId} has no message ${messageId} of the maintainer`);
	return { chat, message };
}

async function brief(chatId, out) {
	if (!out.harness) throw new Error("--harness must name the harness, like t3code");
	const { chat, message } = await chatAndMessage(chatId, out.message);
	if (message.status !== "queued") throw new Refused(`The message is ${message.status} already. Nothing to hand on.`);
	const follow = !out.new && chat.session?.harness === out.harness && chat.session?.id;
	const instances = listInstances().map((i) => ({ name: i.name, kind: i.kind, paused: i.paused, valid: i.valid }));
	return {
		ok: true,
		chatId,
		messageId: message.id,
		title: `Gary chat: ${chat.title}`.slice(0, 80),
		session: chat.session,
		core: ROOT,
		model: modelsOf({}).models.master,
		...(follow ? { note: chatNote({ chat, message }) } : { briefing: chatBriefing({ chat, message, core: ROOT, root: rootDir(), instances }) }),
	};
}

function readAnswer(file) {
	if (!file) throw new Error("--file must name the answer file, or - for stdin");
	try {
		return readFileSync(file === "-" ? 0 : file, "utf8");
	} catch (e) {
		throw new Error(`Cannot read the answer ${file}: ${e.message}`);
	}
}

const refusing = async (fn) => {
	try {
		return await fn();
	} catch (e) {
		if (e.refused) throw new Refused(e.message);
		throw e;
	}
};

function listLine(c) {
	const last = c.messages.findLast((m) => m.role === "user");
	return `${c.id} ${c.updatedAt} ${last ? last.status : "empty"} ${c.session ? `${c.session.harness} ${c.session.id}` : "no session"} ${c.title}`;
}

export async function main(argv) {
	const [command, ...args] = argv;
	let outcome;
	try {
		const { out, rest } = parse(args);
		const one = () => {
			if (rest.length !== 1) throw new Error(USAGE);
			return rest[0];
		};
		if (command === "brief") outcome = await brief(one(), out);
		else if (command === "start") {
			const r = await refusing(() => markSent({ chatId: one(), messageId: out.message, harness: out.harness, session: { id: out.session, link: out.link, title: out.title } }));
			outcome = { ok: true, chatId: r.chat.id, messageId: r.message.id, status: r.message.status, session: r.chat.session };
		} else if (command === "reply") {
			const chatId = one();
			const text = readAnswer(out.file);
			const r = await refusing(() => addReply({ chatId, messageId: out.message, text }));
			outcome = { ok: true, chatId, messageId: r.message.id, replyId: r.reply.id, ...(text.length > MAX_ANSWER && { cut: true }) };
		} else if (command === "fail") {
			const r = await refusing(() => failMessage({ chatId: one(), messageId: out.message, reason: out.reason }));
			outcome = { ok: true, chatId: r.chat.id, messageId: r.message.id, status: "failed" };
		} else if (command === "show") {
			const chat = await readChat(one());
			if (!chat) throw new Error(`There is no chat ${rest[0]}`);
			outcome = out.json ? { ok: true, chat } : { ok: true, text: chat.messages.map((m) => `${m.at} ${m.role === "gary" ? "Gary" : `Maintainer (${m.status})`}:\n${m.text}${m.reason ? `\n[${m.reason}]` : ""}`).join("\n\n") || "The chat is empty." };
		} else if (command === "list") {
			const chats = await readChats();
			outcome = out.json ? { ok: true, chats: chats.map(({ messages, ...c }) => ({ ...c, messages: messages.length })) } : { ok: true, text: chats.map(listLine).join("\n") || "No chat yet." };
		} else throw new Error(USAGE);
	} catch (e) {
		outcome = { ok: false, ...(e instanceof Refused && { refused: true }), result: e.message };
	}
	if (typeof outcome.text === "string") console.log(outcome.text);
	else console.log(JSON.stringify(outcome));
	process.exitCode = outcome.ok ? 0 : outcome.refused ? 3 : 1;
}
