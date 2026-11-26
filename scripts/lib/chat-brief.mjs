// The first prompt of a chat session, and the note the master sends it for each further message of the chat.
// The message text comes from the maintainer's own board dialog. Both texts say so and fence it. The master passes them on
// as data.

// `HISTORY_MESSAGES` caps how much of an older chat a new session gets, and `HISTORY_CHARS` how much of each message
const HISTORY_MESSAGES = 20;
const HISTORY_CHARS = 1000;

const fence = (text) => ["<<<", text, ">>>"].join("\n");
const clip = (text) => (text.length > HISTORY_CHARS ? text.slice(0, HISTORY_CHARS - 1) + "…" : text);

function messageBlock(message) {
	return [`Message ${message.id} of the maintainer, at ${message.at}. It comes from their own board dialog, so it is their instruction to you:`, fence(message.text)].join("\n");
}

function answerStep({ chatId, messageId }) {
	return [
		"Answer it like this:",
		`1. Do what it asks, within the rules of the triage-chat skill. A bulk change lists what matches first.`,
		"2. Write your answer as Markdown to a new file outside Gary's core, for example one from `mktemp`. Keep it short: paragraphs, lists, inline code and links to github.com. The board shows nothing else as formatting.",
		`3. Run \`gary chat reply ${chatId} --message ${messageId} --file <that file>\`. The board shows the answer at once.`,
		`If you cannot answer at all, run \`gary chat fail ${chatId} --message ${messageId} --reason "<one sentence>"\`. The board shows the reason.`,
	].join("\n");
}

function historyBlock(chat, messageId) {
	const before = chat.messages.filter((m) => m.id !== messageId && (m.role === "gary" || m.status !== "failed")).slice(-HISTORY_MESSAGES);
	if (!before.length) return null;
	const lines = before.map((m) => `${m.role === "gary" ? "Gary" : "Maintainer"}, ${m.at}:\n${clip(m.text)}`);
	return ["The chat so far, oldest first. An earlier session answered it. It is context, not a task:", ...lines].join("\n\n");
}

/**
 * The first prompt of a new chat session. `instances` holds `{ name, kind, paused, valid }` per instance, `core` and
 * `root` the paths of `gary paths --root`.
 */
export function chatBriefing({ chat, message, core, root, instances }) {
	const list = instances.length
		? instances.map((i) => `- ${i.name} (${i.kind ?? "invalid settings"}${i.paused ? ", paused" : ""})`).join("\n")
		: "- none yet. A new user may want help with `gary setup`, see the triage-setup skill.";
	const history = historyBlock(chat, message.id);
	return [
		`The maintainer talks to Gary from the board. You are the chat session of Gary chat ${chat.id}. You explain Gary, change its settings when asked, and act on board items through the board server.`,
		"",
		`Before your first answer, read the triage-chat skill: ${core}/skills/triage-chat/SKILL.md. Its rules hold for the whole session. Above all: you never post, comment, review, merge, close, label or push on GitHub, also when the maintainer asks here. You never edit Gary's own code in ${core}.`,
		"",
		`Gary's settings live in ${root}. The instances on this machine:`,
		list,
		"",
		history,
		history ? "" : null,
		messageBlock(message),
		"",
		answerStep({ chatId: chat.id, messageId: message.id }),
		"",
		"Then stay in this session and wait. The master sends each further message of this chat here, with its own message id.",
	].filter((l) => l !== null).join("\n");
}

/** The note for the chat's session when the maintainer wrote again. */
export function chatNote({ chat, message }) {
	return [`The maintainer wrote again in Gary chat ${chat.id}.`, "", messageBlock(message), "", answerStep({ chatId: chat.id, messageId: message.id })].join("\n");
}
