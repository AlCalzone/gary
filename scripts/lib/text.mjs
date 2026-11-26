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
