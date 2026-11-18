// Claims on work for one item, so two runs never fix, review or push to the same item at once.
// A claim is <state>/claims/<itemId>.<kind>.json with { run, at, expiresAt }.
import { randomBytes } from "node:crypto";
import { link, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ID_PATTERN, readJson, writeAtomic } from "./board-store.mjs";
import { instanceDir, instanceName } from "./config.mjs";

export const CLAIM_KINDS = ["fix", "review", "push"];
export const DEFAULT_TTL_MINUTES = 60;

// The agent action a queued board request runs, and the claim kind that covers it
export const ACTION_KINDS = {
	start_fix: "fix",
	full_review: "review",
	reanalyze: "review",
	take_over: "push",
	address_review: "push",
	drive: "push",
	format: "push",
};

export const claimsDir = (instance = instanceName()) => join(instanceDir(instance), "state", "claims");
const claimFile = (instance, itemId, kind) => join(claimsDir(instance), `${itemId}.${kind}.json`);
const isLive = (claim, now) => !!claim && Date.parse(claim.expiresAt) > now;

function check(itemId, kind, run) {
	if (!ID_PATTERN.test(itemId ?? "")) throw new Error(`The item id must match ${ID_PATTERN}`);
	if (!CLAIM_KINDS.includes(kind)) throw new Error(`The kind must be one of ${CLAIM_KINDS.join(", ")}`);
	if (typeof run !== "string" || !run.trim() || run.length > 200) throw new Error("--run must name the run");
}

/**
 * Takes the claim for `run`. Returns `{ ok: true, claim }`, or `{ ok: false, holder }` when another run holds
 * an unexpired claim. The same run takes it again with a new expiry. An expired claim is taken over.
 */
export async function takeClaim({ instance = instanceName(), itemId, kind, run, ttlMinutes = DEFAULT_TTL_MINUTES, now = Date.now() }) {
	check(itemId, kind, run);
	if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 24 * 60) throw new Error("--ttl must be 1 to 1440 minutes");
	const file = claimFile(instance, itemId, kind);
	await mkdir(claimsDir(instance), { recursive: true });
	const claim = { run, at: new Date(now).toISOString(), expiresAt: new Date(now + ttlMinutes * 60000).toISOString() };
	for (let attempt = 0; attempt < 3; attempt++) {
		// A hard link of a complete temp file creates the claim exclusively and never shows a partial file
		const tmp = join(claimsDir(instance), `.${randomBytes(6).toString("hex")}.tmp`);
		await writeFile(tmp, JSON.stringify(claim, null, "\t") + "\n");
		try {
			await link(tmp, file);
			return { ok: true, claim };
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
		} finally {
			await unlink(tmp).catch(() => {});
		}
		const held = await readJson(file);
		if (held?.run === run) {
			await writeAtomic(file, claim);
			return { ok: true, claim };
		}
		if (isLive(held, now)) return { ok: false, holder: held };
		// Move the expired claim aside first, so only one taker removes it
		const tomb = `${file}.${randomBytes(6).toString("hex")}.expired`;
		try {
			await rename(file, tomb);
		} catch (e) {
			if (e.code !== "ENOENT") throw e;
			continue;
		}
		const moved = await readJson(tomb);
		if (isLive(moved, now)) {
			// Another taker renewed it in between. Put it back unless a third run created a new one
			await link(tomb, file).catch(() => {});
			await unlink(tomb).catch(() => {});
			return { ok: false, holder: moved };
		}
		await unlink(tomb).catch(() => {});
	}
	return { ok: false, holder: await readJson(file) };
}

/** Removes the claim when `run` holds it. Returns `{ released, holder }`. */
export async function releaseClaim({ instance = instanceName(), itemId, kind, run }) {
	check(itemId, kind, run);
	const file = claimFile(instance, itemId, kind);
	const held = await readJson(file);
	if (!held) return { released: false, holder: null };
	if (held.run !== run) return { released: false, holder: held };
	await unlink(file).catch((e) => {
		if (e.code !== "ENOENT") throw e;
	});
	return { released: true, holder: held };
}

/** Every claim of the instance, `{ itemId, kind, run, at, expiresAt, expired }`, oldest first. */
export async function listClaims({ instance = instanceName(), now = Date.now() } = {}) {
	let names = [];
	try {
		names = await readdir(claimsDir(instance));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const out = [];
	for (const name of names) {
		const m = /^(.+)\.(fix|review|push)\.json$/.exec(name);
		if (!m || !ID_PATTERN.test(m[1])) continue;
		const c = await readJson(join(claimsDir(instance), name));
		if (!c) continue;
		out.push({ itemId: m[1], kind: m[2], run: c.run ?? null, at: c.at ?? null, expiresAt: c.expiresAt ?? null, expired: !isLive(c, now) });
	}
	return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
