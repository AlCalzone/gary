// Checks on the text of a GitHub comment

/** The text of a comment without quoted lines, so a mention inside a quote is no mention. */
export const unquoted = (body) => String(body ?? "").split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").trim();

/** Whether a comment names `me` outside a quote. */
export function mentions(body, me) {
	if (!me) return false;
	return new RegExp(`(^|[^\\w-])@${me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(unquoted(body));
}

/** Whether the last line of a comment outside a quote ends in a question mark. */
export const endsInQuestion = (body) => /\?\s*$/.test(unquoted(body).split("\n").filter((l) => l.trim()).at(-1) ?? "");

// A mention of any account. Code spans are dropped first because they hold package names like `@types/node`
const ANY_MENTION = /(?:^|[^\w-])@[a-z\d]/i;

/**
 * Whether a comment asks `me` something: it names `me`, or its last line ends in a question mark.
 * A question in a comment that names only other people is theirs to answer.
 */
export function asksMe(body, me) {
	if (mentions(body, me)) return true;
	if (!endsInQuestion(body)) return false;
	return !ANY_MENTION.test(unquoted(body).replace(/`[^`\n]*`/g, ""));
}
