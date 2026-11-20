// The decision log, rule proposals and applying an accepted proposal. See "Learning" in SPEC.md.
import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { ID_PATTERN, PROPOSAL_ID, writeAtomic } from "./board-store.mjs";
import { normalizeCategory } from "./categories.mjs";
import { CONFIG_DEFAULTS, checkConfig, instanceDir, instanceName, loadInstance, personalFile } from "./config.mjs";

const run = promisify(execFile);
const MAX_LOG_TEXT = 8000;
const MAX_TITLE = 60;
const MAX_RULE = 20000;
const PROPOSAL_STATUS = ["open", "accepted", "dismissed"];
const PROFILE_FILE = /^(rules|templates)\/[A-Za-z0-9._-]+\.md$/;
// The settings a proposal may change, each with the values it may set
export const PROPOSAL_SETTINGS = { fastTier: ["on", "shadow"] };
const SETTING_FIELDS = ["id", "createdAt", "kind", "setting", "title", "stats", "differences", "reasons", "status", "decidedAt", "reason", "note"];
const SETTING_REASONS = ["agreement", "overrides"];
const MAX_DIFFERENCES = 50;

const stateOf = (instance = instanceName()) => join(instanceDir(instance), "state");
export const decisionsFile = (instance) => join(stateOf(instance), "decisions.jsonl");
export const learnFile = (instance) => join(stateOf(instance), "learn.json");

export const cut = (text) => (typeof text === "string" && text.length > MAX_LOG_TEXT ? text.slice(0, MAX_LOG_TEXT) : text ?? "");

/** The item facts every log entry carries. */
export function itemSummary(item) {
	return {
		kind: item?.kind,
		authorType: item?.authorType,
		category: normalizeCategory(item ?? {}).category,
		labels: Array.isArray(item?.labels) ? item.labels : [],
		title: item?.title ?? "",
		// `gary shadow report` groups the maintainer's decisions by the tier that classified the item
		classifiedBy: item?.classifiedBy ?? null,
		reviewDepth: item?.reviewDepth ?? null,
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

const isCount = (v) => Number.isInteger(v) && v >= 0;
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isGithubUrl = (v) => typeof v === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull|discussions)\/\d+$/.test(v);

export const isSettingProposal = (p) => p?.kind === "setting";

// Proposals written before categories name a `section` in place of the `category`
function answerProblems(a, at) {
	if (!isPlainObject(a)) return [`${at} must be { category, recommendedType }`];
	const errors = [];
	for (const key of Object.keys(a)) if (!["category", "section", "recommendedType"].includes(key)) errors.push(`${at} has the unknown field "${key}"`);
	const keys = ["recommendedType", Object.hasOwn(a, "section") ? "section" : "category"];
	for (const key of keys) {
		if (a[key] !== null && !(isString(a[key]) && a[key].length <= 40)) errors.push(`${at}.${key} must be null or a string of at most 40 characters`);
	}
	return errors;
}

// Stats written before categories count `sameSection`. They are checked as `sameCategory`
function oldStats(s) {
	if (!isPlainObject(s)) return s;
	const rename = (o) => (isPlainObject(o) && Object.hasOwn(o, "sameSection") && !Object.hasOwn(o, "sameCategory") ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k === "sameSection" ? "sameCategory" : k, v])) : o);
	const out = rename(s);
	return isPlainObject(out.recent) ? { ...out, recent: rename(out.recent) } : out;
}

function statsProblems(p) {
	const s = oldStats(p.stats);
	if (!isPlainObject(s)) return ["stats must be { pairs, handedUp, answered, sameCategory, sameRouteType }"];
	const errors = [];
	const known = ["pairs", "handedUp", "answered", "sameCategory", "sameRouteType", "recent", "overrides"];
	for (const key of Object.keys(s)) if (!known.includes(key)) errors.push(`stats has the unknown field "${key}"`);
	const counts = ["pairs", "handedUp", "answered", "sameCategory", "sameRouteType"];
	if (!counts.every((k) => isCount(s[k]))) errors.push(`stats.${counts.join(", stats.")} must be whole numbers`);
	else {
		if (s.handedUp + s.answered !== s.pairs) errors.push("stats.handedUp and stats.answered must add up to stats.pairs");
		if (s.sameCategory > s.answered || s.sameRouteType > s.answered) errors.push("stats.sameCategory and stats.sameRouteType cannot exceed stats.answered");
	}
	const reasons = p.reasons;
	if (p.setting?.value !== "shadow") {
		if (reasons !== undefined) errors.push("reasons belongs only to a proposal that switches back");
		return errors;
	}
	if (!Array.isArray(reasons) || !reasons.length || new Set(reasons).size !== reasons.length || !reasons.every((r) => SETTING_REASONS.includes(r))) {
		errors.push(`reasons must list at least one of ${SETTING_REASONS.join(", ")}`);
		return errors;
	}
	if (reasons.includes("agreement")) {
		const r = s.recent;
		if (!isPlainObject(r) || !isCount(r.answered) || !isCount(r.sameCategory) || !isCount(r.needed) || r.sameCategory > r.answered || r.needed > r.answered || r.answered < 1) {
			errors.push("stats.recent must be { answered, sameCategory, needed } for the reason agreement");
		}
	}
	if (reasons.includes("overrides")) {
		const tier = (t) => isPlainObject(t) && isCount(t.items) && isCount(t.changed) && t.changed <= t.items && t.items >= 1;
		if (!isPlainObject(s.overrides) || !tier(s.overrides.fast) || !tier(s.overrides.standard)) errors.push("stats.overrides must be { fast: { items, changed }, standard: { items, changed } } for the reason overrides");
	}
	return errors;
}

function settingProblems(p) {
	const errors = [];
	for (const key of Object.keys(p)) if (!SETTING_FIELDS.includes(key)) errors.push(`a setting proposal has no field "${key}"`);
	const s = p.setting;
	if (!isPlainObject(s) || Object.keys(s).some((k) => !["key", "value"].includes(k)) || !Object.hasOwn(PROPOSAL_SETTINGS, s.key ?? "")) {
		errors.push(`setting must be { key, value } with one of the keys ${Object.keys(PROPOSAL_SETTINGS).join(", ")}`);
	} else if (!PROPOSAL_SETTINGS[s.key].includes(s.value)) {
		errors.push(`setting.value for ${s.key} must be one of ${PROPOSAL_SETTINGS[s.key].join(", ")}`);
	}
	errors.push(...statsProblems(p));
	const d = p.differences;
	if (!Array.isArray(d) || d.length > MAX_DIFFERENCES) errors.push(`differences must be a list of at most ${MAX_DIFFERENCES} { itemId, runs, fast, standard }`);
	else {
		d.forEach((x, i) => {
			const at = `differences[${i}]`;
			if (!isPlainObject(x)) return errors.push(`${at} must be an object`);
			for (const key of Object.keys(x)) if (!["itemId", "number", "url", "runs", "fast", "standard"].includes(key)) errors.push(`${at} has the unknown field "${key}"`);
			if (typeof x.itemId !== "string" || !ID_PATTERN.test(x.itemId)) errors.push(`${at}.itemId must be an item id`);
			if (!Number.isInteger(x.runs) || x.runs < 1) errors.push(`${at}.runs must be a whole number from 1`);
			if (x.number !== undefined && !(Number.isInteger(x.number) && x.number > 0)) errors.push(`${at}.number must be the item's number`);
			if (x.url !== undefined && !isGithubUrl(x.url)) errors.push(`${at}.url must be the item's GitHub URL`);
			errors.push(...answerProblems(x.fast, `${at}.fast`), ...answerProblems(x.standard, `${at}.standard`));
		});
	}
	if (p.note !== undefined && typeof p.note !== "string") errors.push("note must be a string");
	return errors;
}

/** Returns the problems of one proposal doc. A doc with `kind: "setting"` is a setting proposal, one without `kind` a rule proposal. */
export function validateProposal(id, p) {
	const errors = [];
	if (!p || typeof p !== "object" || Array.isArray(p)) return ["the proposal must be a JSON object"];
	if (!PROPOSAL_ID.test(id ?? "")) errors.push("the id must match ^[a-z0-9-]{1,80}$");
	if (p.id !== id) errors.push(`id "${p.id}" differs from the file name ${id}`);
	if (!isIso(p.createdAt)) errors.push("createdAt must be an ISO time");
	if (!isString(p.title) || p.title.length > MAX_TITLE) errors.push(`title is required, at most ${MAX_TITLE} characters`);
	if (p.kind !== undefined && p.kind !== "setting") errors.push('kind must be "setting", or absent for a rule proposal');
	if (isSettingProposal(p)) errors.push(...settingProblems(p));
	else {
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
	}
	if (!PROPOSAL_STATUS.includes(p.status)) errors.push(`status must be one of ${PROPOSAL_STATUS.join(", ")}`);
	if (p.decidedAt !== undefined && p.decidedAt !== null && !isIso(p.decidedAt)) errors.push("decidedAt must be null or an ISO time");
	if (p.reason !== undefined && typeof p.reason !== "string") errors.push("reason must be a string");
	return errors;
}

/**
 * Sets the one setting of a setting proposal in the instance's config.json. Throws when the proposal is invalid,
 * when the config cannot be read or when it would be invalid afterwards. Other keys, their order and the
 * indentation stay as they are. Returns `{ file, key, value, from, changed }`. `changed` is false when the
 * config already had the value, and then nothing is written.
 */
export async function applySetting(p, instance = instanceName()) {
	const problems = validateProposal(p?.id, p);
	if (!isSettingProposal(p) || problems.length) throw new Error(`This proposal is invalid and was not applied: ${(problems.length ? problems : ["it changes no setting"]).join(", ")}.`);
	const { key, value } = p.setting;
	// A config.json that links into a dotfiles repository must stay a link
	const file = await realpath(join(instanceDir(instance), "config.json"));
	const text = await readFile(file, "utf8");
	let data;
	try {
		data = JSON.parse(text);
	} catch (e) {
		throw new Error(`${file} is not valid JSON, so nothing was changed: ${e.message}`);
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} must hold a JSON object, so nothing was changed.`);
	const from = data[key] ?? CONFIG_DEFAULTS[key];
	if (from === value) return { file, key, value, from, changed: false };
	const next = { ...data, [key]: value };
	const { errors } = checkConfig(next);
	if (errors.length) throw new Error(`${file} would be invalid, so nothing was changed: ${errors.join(", ")}.`);
	const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "\t";
	await writeAtomic(file, JSON.stringify(next, null, indent) + "\n", { raw: true });
	return { file, key, value, from, changed: true };
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

