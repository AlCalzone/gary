// Compares a reply the maintainer copied from the board with what they posted on GitHub afterwards.
// A different text becomes a `posted_text` entry in the decision log, so the learn pass sees the rewrite.
import { join } from "node:path";
import { boardDir, readJson, writeAtomic } from "./board-store.mjs";
import { instanceName, stateDir } from "./config.mjs";
import { cut, logDecision } from "./learning.mjs";

// A post later than this after the copy counts as unrelated to the draft
export const POSTED_WINDOW_MS = 2 * 60 * 60 * 1000;

const postedFile = () => join(stateDir(), "posted.json");
const sameText = (a, b) => String(a).replace(/\s+/g, " ").trim() === String(b).replace(/\s+/g, " ").trim();

/** The comments, replies and review thread comments `login` wrote in a raw thread node, oldest first, as `{ at, url, body }`. */
export function ownPosts(node, login) {
	const wanted = String(login ?? "").toLowerCase();
	const out = [];
	const add = (c) => {
		if (c?.createdAt && String(c.author?.login ?? "").toLowerCase() === wanted && typeof c.body === "string") out.push({ at: c.createdAt, url: c.url ?? null, body: c.body });
	};
	for (const c of (node.timelineComments ?? node.comments)?.nodes ?? []) {
		add(c);
		for (const r of c.replies?.nodes ?? []) add(r);
	}
	for (const t of node.reviewThreads?.nodes ?? []) for (const c of (t.allComments ?? t.comments)?.nodes ?? []) add(c);
	return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The newest copied draft of an item and the maintainer's first post inside the window after it, or null.
 * `opened` is the item's record in `<state>/opened.json`: per route id `{ at, text }`.
 */
export function postedAfterCopy(opened, posts) {
	const copies = Object.entries(opened ?? {}).filter(([, o]) => typeof o?.text === "string" && o.text.trim() && Number.isFinite(Date.parse(o.at)));
	if (!copies.length) return null;
	const [routeId, copy] = copies.reduce((x, y) => (Date.parse(y[1].at) > Date.parse(x[1].at) ? y : x));
	const from = Date.parse(copy.at);
	const post = posts.find((p) => Date.parse(p.at) > from && Date.parse(p.at) <= from + POSTED_WINDOW_MS);
	return post ? { routeId, copy, post } : null;
}

/**
 * Logs one `posted_text` decision per copied draft that the maintainer posted with other words.
 * `threads` are `[itemId, rawNode]` pairs of this instance. Each copy is judged once, also when the texts match.
 */
export async function logPostedTexts(threads, login) {
	const opened = await readJson(join(stateDir(), "opened.json"));
	if (!opened || !login) return;
	const seen = (await readJson(postedFile())) ?? {};
	let changed = false;
	for (const [itemId, node] of threads) {
		const found = postedAfterCopy(opened[itemId], ownPosts(node, login));
		if (!found || seen[itemId] === found.copy.at) continue;
		seen[itemId] = found.copy.at;
		changed = true;
		if (sameText(found.copy.text, found.post.body)) continue;
		const item = await readJson(join(boardDir(), "items", itemId + ".json"));
		const route = (Array.isArray(item?.routes) ? item.routes : []).find((r) => r?.id === found.routeId);
		await logDecision(instanceName(), "posted_text", itemId, item ?? {}, {
			...(route && { route: { type: route.type, title: route.title ?? "" } }),
			draft: cut(found.copy.text), final: cut(found.post.body), url: found.post.url,
		});
	}
	if (changed) await writeAtomic(postedFile(), seen);
}
