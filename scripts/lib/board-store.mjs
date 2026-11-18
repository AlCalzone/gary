import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDir } from "./config.mjs";

export const ID_PATTERN = /^(pr|issue|disc)-\d+(-\d+)?$/;
export const COLLECTIONS = ["items", "actions"];

export function boardDir() {
	return join(stateDir(), "board");
}

/** The token file sits next to the board directory, so a test copy of the board gets its own token. */
export function tokenFile(dir = boardDir()) {
	return join(dirname(dir), "server-token");
}

/** Resolves `items/<id>`, `actions/<id>` or `meta` to its file, or returns null for anything else. */
export function docPath(dir, path) {
	if (path === "meta") return join(dir, "meta.json");
	const m = /^(items|actions)\/(.+)$/.exec(typeof path === "string" ? path : "");
	if (!m || !ID_PATTERN.test(m[2])) return null;
	return join(dir, m[1], m[2] + ".json");
}

export async function readJson(file) {
	try {
		const v = JSON.parse(await readFile(file, "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

/** Writes through a temp file in the same directory and a rename, so readers never see a partial file. */
export async function writeAtomic(file, data) {
	const tmp = join(dirname(file), `.${randomBytes(6).toString("hex")}.tmp`);
	await writeFile(tmp, JSON.stringify(data, null, "\t") + "\n");
	try {
		await rename(tmp, file);
	} catch (e) {
		await unlink(tmp).catch(() => {});
		throw e;
	}
}

/** Merges `patch` into `cur`. A `null` value removes the field. */
export function mergeFields(cur, patch) {
	const next = { ...cur };
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) delete next[k];
		else next[k] = v;
	}
	return next;
}

/**
 * Applies one write to a board document.
 * `set` replaces, `update` merges into an existing doc, `merge` merges and creates a missing doc
 * with `null` removing a field, `delete` removes the file.
 * Returns `[status, body]` like an HTTP reply.
 */
export async function applyWrite(dir, { op, path, data }) {
	const file = docPath(dir, path);
	if (!file) return [400, { error: "Only items/<id>, actions/<id> and meta can be written." }];
	if (path === "meta" && op !== "set") return [400, { error: "meta only supports set." }];
	if (op === "delete") {
		if (!path.startsWith("items/")) return [400, { error: "Only items can be deleted." }];
		await unlink(file).catch((e) => {
			if (e.code !== "ENOENT") throw e;
		});
		return [200, { ok: true }];
	}
	if (!["set", "update", "merge"].includes(op)) return [400, { error: "op must be set, update, merge or delete." }];
	if (!data || typeof data !== "object" || Array.isArray(data)) return [400, { error: "data must be an object." }];
	let next = data;
	if (op !== "set") {
		const cur = await readJson(file);
		if (!cur && op === "update") return [404, { error: `${path} does not exist.` }];
		next = op === "update" ? { ...cur, ...data } : mergeFields(cur ?? {}, data);
	}
	await writeAtomic(file, next);
	return [200, { ok: true }];
}
