// The decision log, rule proposals and applying an accepted proposal. See "Learning" in SPEC.md.
import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { PROPOSAL_ID, writeAtomic } from "./board-store.mjs";
import { instanceDir, instanceName, loadInstance, personalFile } from "./config.mjs";

const run = promisify(execFile);
const MAX_LOG_TEXT = 8000;
const MAX_TITLE = 60;
const MAX_RULE = 20000;
const PROPOSAL_STATUS = ["open", "accepted", "dismissed"];
const PROFILE_FILE = /^(rules|templates)\/[A-Za-z0-9._-]+\.md$/;

const stateOf = (instance = instanceName()) => join(instanceDir(instance), "state");
export const decisionsFile = (instance) => join(stateOf(instance), "decisions.jsonl");
export const learnFile = (instance) => join(stateOf(instance), "learn.json");

export const cut = (text) => (typeof text === "string" && text.length > MAX_LOG_TEXT ? text.slice(0, MAX_LOG_TEXT) : text ?? "");

/** The item facts every log entry carries. */
export function itemSummary(item) {
	return {
		kind: item?.kind,
		authorType: item?.authorType,
		section: item?.section,
		labels: Array.isArray(item?.labels) ? item.labels : [],
		title: item?.title ?? "",
	};
}

// One append at a time, so lines never interleave
let appending = Promise.resolve();

/**
 * Appends one entry to an instance's decision log. Only the board server calls this.
 * Every entry carries the instance, its kind and the item's repo.
 */
export function logDecision(instance, type, itemId, item, fields = {}) {
	const file = decisionsFile(instance);
	let instanceKind = null;
	try {
		instanceKind = loadInstance(instance).kind;
	} catch {
		// A log entry is never lost over a broken config
	}
	const entry = { at: new Date().toISOString(), instance, instanceKind, repo: item?.repo ?? null, type, itemId, item: itemSummary(item), ...fields };
	const next = appending.then(async () => {
		await mkdir(dirname(file), { recursive: true });
		await appendFile(file, JSON.stringify(entry) + "\n");
	});
	appending = next.catch(() => {});
	return next;
}

/** Reads the log. With `since`, only entries whose `at` is later than it. Broken lines are skipped. */
export async function readDecisions({ since, instance } = {}) {
	const file = decisionsFile(instance);
	let text = "";
	try {
		text = await readFile(file, "utf8");
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const sinceMs = since ? Date.parse(since) : NaN;
	return text
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter((e) => e && (!Number.isFinite(sinceMs) || Date.parse(e.at) > sinceMs));
}

const isString = (v) => typeof v === "string" && v.trim().length > 0;
const isIso = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));

/** Returns the problems of one proposal doc. */
export function validateProposal(id, p) {
	const errors = [];
	if (!p || typeof p !== "object" || Array.isArray(p)) return ["the proposal must be a JSON object"];
	if (!PROPOSAL_ID.test(id ?? "")) errors.push("the id must match ^[a-z0-9-]{1,80}$");
	if (p.id !== id) errors.push(`id "${p.id}" differs from the file name ${id}`);
	if (!isIso(p.createdAt)) errors.push("createdAt must be an ISO time");
	if (!isString(p.title) || p.title.length > MAX_TITLE) errors.push(`title is required, at most ${MAX_TITLE} characters`);
	if (!isString(p.why)) errors.push("why is required");
	if (!Array.isArray(p.evidence) || !p.evidence.every((e) => e && typeof e === "object" && isString(e.itemId) && isString(e.type))) {
		errors.push("evidence must be a list of { at, itemId, type, gist }");
	}
	if (p.target === "profile") {
		if (!PROFILE_FILE.test(p.file ?? "")) errors.push("file must be rules/<topic>.md or templates/<name>.md for the profile");
	} else if (p.target === "personal") {
		if (p.file !== "personal.md") errors.push("file must be personal.md for target personal");
	} else errors.push('target must be "profile" or "personal"');
	if (p.heading !== undefined && p.heading !== null && typeof p.heading !== "string") errors.push("heading must be a string or null");
	if (!isString(p.text) || p.text.length > MAX_RULE) errors.push(`text is required, at most ${MAX_RULE} characters`);
	if (!PROPOSAL_STATUS.includes(p.status)) errors.push(`status must be one of ${PROPOSAL_STATUS.join(", ")}`);
	if (p.decidedAt !== undefined && p.decidedAt !== null && !isIso(p.decidedAt)) errors.push("decidedAt must be null or an ISO time");
	if (p.reason !== undefined && typeof p.reason !== "string") errors.push("reason must be a string");
	return errors;
}

/** Resolves the file a proposal of an instance targets. Throws when it would leave the allowed directories. */
export async function proposalTarget(p, instance = instanceName()) {
	if (p.target === "personal") {
		if (p.file !== "personal.md") throw new Error("A personal proposal can only target personal.md");
		return { file: personalFile(), repo: null };
	}
	if (!PROFILE_FILE.test(p.file ?? "")) throw new Error("A profile proposal must target rules/<topic>.md or templates/<name>.md");
	const profile = await realpath(loadInstance(instance).profileDir);
	const dir = join(profile, dirname(p.file));
	let realDir;
	try {
		realDir = await realpath(dir);
	} catch {
		throw new Error(`${dirname(p.file)}/ does not exist in the profile`);
	}
	if (realDir !== dir) throw new Error(`${dirname(p.file)}/ in the profile leads elsewhere`);
	return { file: join(dir, basename(p.file)), repo: profile };
}

/** Inserts `text` at the end of the section under `heading`, or at the end of the file. */
export function insertRule(content, heading, text) {
	const block = text.trim() + "\n";
	const lines = content.split("\n");
	const h = isString(heading) ? lines.findIndex((l) => l.trim() === heading.trim()) : -1;
	if (h < 0) return (content.trimEnd() ? content.trimEnd() + "\n\n" : "") + block;
	const level = /^#+/.exec(lines[h].trim())?.[0].length ?? 0;
	let end = lines.length;
	for (let i = h + 1; i < lines.length; i++) {
		const m = /^(#+)\s/.exec(lines[i]);
		if (m && (level === 0 || m[1].length <= level)) {
			end = i;
			break;
		}
	}
	const before = lines.slice(0, end).join("\n").trimEnd();
	const after = lines.slice(end).join("\n");
	return before + "\n\n" + block + (after ? "\n" + after : "");
}

/**
 * Appends an accepted proposal's text to its target file, and commits that one file when the profile is a git repo.
 * Returns `{ file, committed, warning }`.
 */
export async function applyProposal(p, text, instance = instanceName()) {
	const { file, repo } = await proposalTarget(p, instance);
	try {
		if ((await lstat(file)).isSymbolicLink()) throw new Error(`${p.file} is a symlink`);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	let content = "";
	try {
		content = await readFile(file, "utf8");
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	await writeAtomic(file, insertRule(content, p.heading, text), { raw: true });

	if (!repo) return { file, committed: false };
	let top;
	try {
		top = (await run("git", ["-C", repo, "rev-parse", "--show-toplevel"])).stdout.trim();
	} catch {
		return { file, committed: false };
	}
	const path = relative(await realpath(top), file);
	if (path.startsWith("..") || path.startsWith(sep)) return { file, committed: false };
	try {
		await run("git", ["-C", top, "-c", "core.hooksPath=/dev/null", "add", "--", path]);
		await run("git", ["-C", top, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", `Add rule: ${p.title}`, "--", path]);
		return { file, committed: true };
	} catch (e) {
		return { file, committed: false, warning: `The rule is written, but the commit failed: ${(e.stderr || e.message).trim().slice(0, 300)}` };
	}
}

/** Validates and writes the learn cursor of an instance. */
export async function writeLearn(data, instance = instanceName()) {
	const errors = [];
	if (!data || typeof data !== "object" || Array.isArray(data)) errors.push("learn.json must hold a JSON object");
	else {
		for (const key of Object.keys(data)) if (!["reviewedUntil", "lastLearnAt"].includes(key)) errors.push(`unknown field "${key}"`);
		for (const key of ["reviewedUntil", "lastLearnAt"]) {
			if (data[key] !== undefined && data[key] !== null && !isIso(data[key])) errors.push(`${key} must be an ISO time`);
		}
	}
	if (errors.length) return errors;
	await mkdir(stateOf(instance), { recursive: true });
	await writeAtomic(learnFile(instance), data);
	return [];
}

