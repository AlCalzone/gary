// JSON with `//` and `/* */` comments and trailing commas, for the files people edit by hand
import { readFileSync } from "node:fs";

/** Removes comments and trailing commas outside of strings, keeping every line break so error positions stay right. */
export function stripJsonc(text) {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			const start = i++;
			while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
			out += text.slice(start, ++i);
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			const stop = end < 0 ? text.length : end + 2;
			out += text.slice(i, stop).replace(/[^\n]/g, "");
			i = stop;
		} else {
			out += c;
			i++;
		}
	}
	// A comma that only whitespace separates from a closing bracket
	return out.replace(/,(\s*[}\]])/g, (m, rest, at) => (inString(out, at) ? m : rest));
}

function inString(text, at) {
	let open = false;
	for (let i = 0; i < at; i++) {
		if (text[i] === "\\" && open) i++;
		else if (text[i] === '"') open = !open;
	}
	return open;
}

export function parseJsonc(text) {
	return JSON.parse(stripJsonc(text));
}

export function readJsoncFile(file) {
	return parseJsonc(readFileSync(file, "utf8"));
}

/** Replaces the value of one top-level key in JSONC text and keeps every comment. The key must sit on a line of its own. */
export function setJsoncValue(text, key, value) {
	const re = new RegExp(`^(\\s*${JSON.stringify(key)}\\s*:\\s*)(.*?)(,?\\s*(?://.*)?)$`, "m");
	if (!re.test(text)) throw new Error(`The key ${key} is not on a line of its own.`);
	return text.replace(re, (m, head, old, tail) => head + JSON.stringify(value) + tail);
}
