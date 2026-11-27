// Resolves where everything lives and loads the two settings files.
//   core:     this tool's own directory, found from this file
//   root:     $GARY_HOME, default ~/.config/gary, holds the shared personal.md and instances/
//   home:     the instance directory root/instances/<name>, holds config.json, an optional personal.md and state/
//   profile:  the project directory named by `profile` in config.json, holds profile.json, rules/ and templates/
// The instance comes from --instance, then GARY_INSTANCE, then the working directory, then the only instance.
import { readJsoncFile } from "./jsonc.mjs";
import { activeReviewBots, checkReviewBots, profileReviewBots, reviewTriggerComments } from "./review-bots.mjs";
import { checkReviewConfig } from "./local-review.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const REPO_NAME = /^[\w.-]{1,100}$/;

export const INSTANCE_KINDS = ["maintainer", "contributions"];
export const DEFAULT_PORT = 7878;

// A contributions instance follows the maintainer's own threads outside the repos of their maintainer instances.
// It has no profile, no bot and no checkout, and Gary writes nothing to GitHub for it
export const CONTRIBUTIONS_DEFAULTS = { title: "Contributions", include: [], exclude: [], activeWindowDays: 30, activeMaxWaitDays: 14, maxItems: 150, clearNotifications: false, mergeReminderDays: 14, mergeReminderDaysFor: {}, checkoutRoots: [] };
// The review drafts for PRs that request the maintainer's review that start without a click: per run, waiting at once,
// and the PR size above which none does
export const REVIEW_DRAFT_DEFAULTS = { maxAutoReviewDraftsPerRun: 0, maxPendingAutoReviewDrafts: 5, reviewDraftMaxLines: 800 };
export const REVIEW_DRAFT_COUNT_MAX = 50;
export const REVIEW_DRAFT_MAX_LINES_MAX = 100000;
export const CONTRIBUTIONS_FIELDS = ["kind", "me", "models", "tab", "review", ...Object.keys(CONTRIBUTIONS_DEFAULTS), ...Object.keys(REVIEW_DRAFT_DEFAULTS)];
// How the instance's tab looks on the board: `{ icon, color, background, favorite }`. `background` also tints the page in that color, and a favorite comes before the other tabs
export const TAB_ICONS = ["zap", "home", "star", "globe", "heart", "user", "shield", "bot", "sparkles", "wrench", "lightbulb", "plug", "eye", "pr", "issue", "discussion", "commit", "comments"];
export const TAB_COLORS = ["orange", "blue", "green", "purple", "rose", "gray"];

// The image files a tab icon may be, with the content type the board server sends
export const TAB_ICON_TYPES = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
export const TAB_ICON_MAX_BYTES = 1024 * 1024;
const isIconFile = (v) => typeof v === "string" && v.length <= 500 && Object.hasOwn(TAB_ICON_TYPES, extname(v).toLowerCase());

/** The image file a config's `tab.icon` names, as `{ file, type }`, or null for a built-in icon or none. A relative path starts at the instance's directory. */
export function tabIconFile(config, dir) {
	const icon = config?.tab?.icon;
	if (!isIconFile(icon)) return null;
	const path = expandHome(icon);
	return { file: isAbsolute(path) ? path : resolve(dir, path), type: TAB_ICON_TYPES[extname(icon).toLowerCase()] };
}

function checkTab(errors, unknown, tab) {
	if (tab === undefined) return;
	if (!tab || typeof tab !== "object" || Array.isArray(tab)) return void errors.push('"tab" must be { "icon", "color", "background", "favorite" }');
	for (const key of Object.keys(tab)) if (!["icon", "color", "background", "favorite"].includes(key)) unknown.push(`unknown field "tab.${key}"`);
	if (tab.icon !== undefined && !TAB_ICONS.includes(tab.icon) && !isIconFile(tab.icon)) errors.push(`"tab.icon" must be an image file (${Object.keys(TAB_ICON_TYPES).join(", ")}) or one of ${TAB_ICONS.join(", ")}`);
	if (tab.color !== undefined && !TAB_COLORS.includes(tab.color) && !/^#[0-9a-f]{6}$/i.test(String(tab.color))) errors.push(`"tab.color" must be a color like #0071bc or one of ${TAB_COLORS.join(", ")}`);
	if (tab.background !== undefined && typeof tab.background !== "boolean") errors.push('"tab.background" must be true or false');
	if (tab.favorite !== undefined && typeof tab.favorite !== "boolean") errors.push('"tab.favorite" must be true or false');
	if (tab.background === true && tab.color === undefined) errors.push('"tab.background" needs "tab.color"');
}
export const MAX_ITEMS_RANGE = [10, 500];
// `MAX_CHECKOUT_ROOTS` caps the directories a contributions instance searches for clones of a PR's repo
export const MAX_CHECKOUT_ROOTS = 20;
// `owner/name` or `owner/*`
const REPO_GLOB = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?:\*|[\w.-]{1,100})$/;
const MAX_REPO_GLOBS = 200;

/** Whether an instance config is of the contributions kind. */
export const isContributions = (config) => config?.kind === "contributions";

/** Whether `repo` (owner/name) matches a glob of `include` or `exclude`, compared without regard to case. */
export function repoMatches(repo, glob) {
	const [owner, name] = String(repo ?? "").toLowerCase().split("/");
	const [gOwner, gName] = String(glob ?? "").toLowerCase().split("/");
	return !!owner && !!name && owner === gOwner && (gName === "*" || gName === name);
}

export const CONFIG_DEFAULTS = {
	kind: "maintainer",
	bot: null,
	allowOwnTokenPushes: false,
	activeWindowDays: 30,
	activeMaxWaitDays: 14,
	maxFullReviewsPerRun: 10,
	maxAutoFixesPerRun: 2,
	maxPendingAutoFixes: 10,
	fastTier: "off",
	escalateAs: "prefill",
};

// Who posts the profile's escalate command on a discussion: the server under the maintainer's login, or the maintainer themself after a copy
export const ESCALATE_AS = ["me", "prefill"];

// `fixReview.reviewer` is still read: "copilot" asks the default bots, "off" turns the fix rounds off like `maxRounds: 0`
export const FIX_REVIEWERS = ["copilot", "off"];
export const FIX_REVIEW_REQUESTERS = ["me", "bot"];
export const FIX_REVIEW_DEFAULTS = { requestAs: "me", maxRounds: 3, markReady: true };
const FIX_REVIEW_FIELDS = ["reviewer", ...Object.keys(FIX_REVIEW_DEFAULTS)];

/** The GitHub review bots Gary asks after a push on this instance, normalized. */
export const reviewBotsOf = (config, profile) => activeReviewBots(config, profile).bots;

/**
 * The review rounds a fix PR of Gary gets on its own: `{ on, bots, requestAs, maxRounds, markReady, reason, noReviewBot }`.
 * `on` is false when the config turns them off or when the rounds cannot run, and `reason` then says why.
 * `noReviewBot` is true when only the missing review bot stops the rounds. The fix PR then goes straight to ready.
 * `maxRounds: 0` and the older `reviewer: "off"` turn only these rounds off. The rounds after a later push stay.
 */
export function fixReviewOf(config, profile) {
	const given = config.fixReview ?? {};
	const set = { ...FIX_REVIEW_DEFAULTS, ...given };
	delete set.reviewer;
	const bots = reviewBotsOf(config, profile);
	const off = (reason, extra = {}) => ({ ...set, on: false, bots, reason, noReviewBot: false, ...extra });
	if (given.reviewer === "off") return off("fixReview.reviewer is off in config.json");
	if (set.maxRounds === 0) return off("fixReview.maxRounds is 0 in config.json");
	if (!config.bot && config.allowOwnTokenPushes !== true) return off("no account may push: there is no bot and allowOwnTokenPushes is false");
	if (!bots.length) return off(profileReviewBots(profile).length ? "no review bot is picked: review.github in config.json names none of the profile's" : "the profile lists no review bot", { noReviewBot: true });
	if (set.requestAs === "bot" && !config.bot) return off('fixReview.requestAs is "bot", but no bot is configured');
	return { ...set, on: true, bots, reason: null, noReviewBot: false };
}

export const FAST_TIERS = ["off", "shadow", "on"];

// `master` and `worker` are sessions. The other roles are subagents a worker starts
export const MODEL_ROLES = ["master", "worker", "review", "standard", "fast"];
export const MODEL_ALIASES = ["haiku", "sonnet", "opus", "fable"];
export const MODEL_DEFAULTS = { master: "sonnet", worker: "sonnet", review: "opus", standard: "sonnet", fast: "haiku" };
const MODEL_ID = /^claude-[a-z0-9-]+$/;
// A session starts with `claude --model`, which takes a full model id. A subagent start takes an alias only
const SESSION_ROLES = ["master", "worker"];
// `fable` has no place in this order, so a comparison with it never says "smaller"
const MODEL_SIZE = { haiku: 0, sonnet: 1, opus: 2 };

/** Collects the problems of a `models` object. `where` is "root" for the root config and "instance" for an instance config. */
function checkModels(models, where, errors, unknown) {
	if (models === undefined) return;
	if (!models || typeof models !== "object" || Array.isArray(models)) {
		errors.push(`"models" must map a role (${MODEL_ROLES.join(", ")}) to a model`);
		return;
	}
	for (const [role, value] of Object.entries(models)) {
		if (!MODEL_ROLES.includes(role)) unknown.push(`unknown field "models.${role}"`);
		else if (role === "master" && where === "instance") errors.push(`"models.master" belongs in the root config.json, because one master session serves every instance`);
		else if (SESSION_ROLES.includes(role)) check(errors, MODEL_ALIASES.includes(value) || (typeof value === "string" && MODEL_ID.test(value)), `"models.${role}" must be one of ${MODEL_ALIASES.join(", ")}, or a full model id that matches ${MODEL_ID}`);
		else check(errors, MODEL_ALIASES.includes(value), `"models.${role}" must be one of ${MODEL_ALIASES.join(", ")}. A subagent start takes no full model id`);
	}
}

/**
 * The model of every role for one instance config: `{ models, sources, fallback }`.
 * The instance's `models` win over the root config's, and those over the defaults. `sources` names the layer per role:
 * "instance", "root" or "default". `fallback` is the model of the one retry after a safety filter stopped a `review`
 * subagent: `{ model, relation }` with the `standard` model and "smaller" or "other", or null when both roles
 * use the same model and a retry would change nothing.
 */
export function modelsOf(config, root = rootConfig()) {
	const models = {};
	const sources = {};
	for (const role of MODEL_ROLES) {
		const layer = config?.models?.[role] !== undefined ? "instance" : root.models?.[role] !== undefined ? "root" : "default";
		sources[role] = layer;
		models[role] = layer === "instance" ? config.models[role] : layer === "root" ? root.models[role] : MODEL_DEFAULTS[role];
	}
	const { review, standard } = models;
	const fallback = review === standard ? null : { model: standard, relation: MODEL_SIZE[standard] < MODEL_SIZE[review] ? "smaller" : "other" };
	return { models, sources, fallback };
}

/** The models of one instance, see modelsOf. */
export const modelsFor = (name) => modelsOf(loadConfigFor(name));

// The kinds of PR that may get the one automatic first review. `config` means the PR only touches the profile's autoReviewPaths.config
export const AUTO_REVIEW_KINDS = ["config"];
export const AUTO_REVIEW_DEFAULTS = { enabled: false, kinds: ["config"], maxPerRun: 3 };

/**
 * The automatic first review on contributor PRs: `{ enabled, kinds, maxPerRun, reason }`.
 * `enabled` is false when the config does not turn it on or when it cannot run, and `reason` then says why.
 * `kinds` holds only the kinds the profile names paths for.
 */
export function autoReviewOf(config, profile) {
	const set = { ...AUTO_REVIEW_DEFAULTS, ...(config.autoReview ?? {}) };
	const off = (reason) => ({ ...set, enabled: false, reason });
	if (set.enabled !== true) return off(config.autoReview ? "autoReview.enabled is false in config.json" : null);
	if (!config.bot && config.allowOwnTokenPushes !== true) return off("no account may post a review: there is no bot and allowOwnTokenPushes is false");
	if (set.maxPerRun === 0) return off("autoReview.maxPerRun is 0");
	const kinds = set.kinds.filter((k) => (profile.autoReviewPaths?.[k] ?? []).length > 0);
	if (!kinds.length) return off(`the profile names no autoReviewPaths for ${set.kinds.join(", ") || "any kind"}`);
	return { ...set, kinds, reason: null };
}

/**
 * Whether Gary links fix PRs to the issues escalated discussions became: `{ enabled, bot, pattern, reason }`.
 * `pattern` finds the issue number in the comment that `bot` posts. `reason` says why it is off.
 */
export function escalationOf(config, profile) {
	const pattern = profile.escalateResult ?? null;
	const bot = config.bot?.login ?? null;
	const reason = !pattern ? "the profile has no escalateResult" : !bot ? "no bot is configured. Only the bot's comment names the issue" : null;
	return { enabled: !reason, bot, pattern, reason };
}

export const PROFILE_DEFAULTS = {
	maintainers: [],
	botLogins: [],
	reviewBots: [],
	relatedRepos: [],
	sensitivePaths: [],
	autoLabels: [],
	botCommands: {},
	requiredTools: [],
	automatedComments: [],
	aiAuthors: [],
	autoReviewPaths: {},
	formatCommand: null,
	autofixCommands: [],
	autofixSetup: null,
	commitFormat: null,
	mergeMethod: "squash",
	escalateResult: null,
	dueDateFields: ["Due", "Due date", "Target date", "Deadline", "End date"],
};

// The longest comment text an automatedComments pattern runs against. It bounds the cost of a slow pattern
export const AUTOMATED_TEXT_LIMIT = 20000;
const MAX_PATTERN = 500;

export function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function rootDir() {
	return resolve(expandHome(process.env.GARY_HOME || "~/.config/gary"));
}

export const instancesDir = () => join(rootDir(), "instances");
export const instanceDir = (name) => join(instancesDir(), name);
export const rootConfigFile = () => join(rootDir(), "config.json");
export const rootStateDir = () => join(rootDir(), "state");

/** The layout from before instances kept an instance config, with a `profile`, in the root. */
export function hasFlatLayout() {
	const data = readJsonSync(rootConfigFile());
	return !!data && typeof data === "object" && "profile" in data;
}

/** The machine-wide settings in <root>/config.json: `{ port, models, sessionsDir }`. `models` holds only the roles the file sets. */
export function rootConfig() {
	const file = rootConfigFile();
	const data = existsSync(file) && !hasFlatLayout() ? readSettings(file, "Root config") : {};
	const errors = [];
	for (const key of Object.keys(data)) check(errors, ["port", "models", "sessionsDir"].includes(key), `unknown field "${key}"`);
	check(errors, data.port === undefined || isInt(data.port, 1, 65535), `"port" must be a port number`);
	check(errors, data.sessionsDir === undefined || (typeof data.sessionsDir === "string" && data.sessionsDir.length > 0), `"sessionsDir" must name the directory of the Claude Code session transcripts`);
	checkModels(data.models, "root", errors, errors);
	if (errors.length) throw new SettingsError(`Root config ${file} is invalid:\n- ${errors.join("\n- ")}`);
	return { port: data.port ?? DEFAULT_PORT, models: data.models ?? {}, ...(data.sessionsDir && { sessionsDir: data.sessionsDir }) };
}

export class SettingsError extends Error {}

let explicitName = null;
let resolved = null;

/** Sets the instance from --instance. It wins over GARY_INSTANCE and the working directory. */
export function setInstance(name) {
	explicitName = name;
	resolved = null;
}
export const explicitInstance = () => explicitName;

/** Names of the instances under the root that have a config.json, sorted. */
export function instanceNames() {
	let names = [];
	try {
		names = readdirSync(instancesDir());
	} catch {
		return [];
	}
	return names.filter((n) => INSTANCE_NAME.test(n) && existsSync(join(instanceDir(n), "config.json"))).sort();
}

function readJsonSync(file) {
	try {
		return file.endsWith("profile.json") ? readJsoncFile(file) : JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

const realOrNull = (p) => {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
};

function git(cwd, args) {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim();
	} catch {
		return null;
	}
}

/** "owner/repo" in lower case from a GitHub remote in https or ssh form, or null. */
export function remoteRepo(url) {
	const m = /^(?:https?:\/\/(?:[^@/]+@)?[^/]+\/|ssh:\/\/[^/]+\/|[^@\s]+@[^:]+:)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec((url ?? "").trim());
	return m ? m[1].toLowerCase() : null;
}

/** What an instance's config and profile say about the repo it belongs to. Unreadable parts stay null. */
export function instanceFacts(name) {
	const dir = instanceDir(name);
	const config = readJsonSync(join(dir, "config.json"));
	const at = (p) => (isAbsolute(expandHome(p)) ? expandHome(p) : resolve(dir, expandHome(p)));
	const profile = typeof config?.profile === "string" && !isContributions(config) ? at(config.profile) : null;
	const repo = profile ? readJsonSync(join(profile, "profile.json"))?.repo ?? null : null;
	const checkout = typeof config?.checkout === "string" ? at(config.checkout) : null;
	return { name, dir, config, repo, checkout };
}

/** The instances the directory belongs to: inside a checkout, a worktree of it, or a clone whose origin is the repo. */
export function matchDirectory(cwd, names = instanceNames()) {
	const here = realOrNull(cwd);
	if (!here) return [];
	const common = (dir) => {
		const out = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		return out ? realOrNull(out) : null;
	};
	const hereCommon = common(here);
	const hereRepo = remoteRepo(git(here, ["remote", "get-url", "origin"]));
	return names.filter((name) => {
		const f = instanceFacts(name);
		const checkout = f.checkout ? realOrNull(f.checkout) : null;
		if (checkout && (here === checkout || here.startsWith(checkout + sep))) return true;
		if (checkout && hereCommon && common(checkout) === hereCommon) return true;
		return !!(hereRepo && f.repo && hereRepo === f.repo.toLowerCase());
	});
}

function listing(names) {
	return names.map((n) => `${n} (${instanceFacts(n).repo ?? "no repo"})`).join(", ");
}

/**
 * The instance every command acts on: --instance, then GARY_INSTANCE, then the working directory,
 * then the only instance. Throws a SettingsError that lists the instances otherwise.
 */
export function resolveInstance({ cwd = process.cwd() } = {}) {
	if (resolved) return resolved;
	const root = rootDir();
	const names = instanceNames();
	const pick = (name, via) => {
		if (!INSTANCE_NAME.test(name ?? "")) throw new SettingsError(`"${name}" is not a valid instance name.`);
		if (!names.includes(name)) {
			throw new SettingsError(`There is no instance "${name}" in ${root}.${names.length ? ` Instances: ${listing(names)}.` : " Run `gary setup` first."}`);
		}
		resolved = { name, via };
		return resolved;
	};
	if (explicitName) return pick(explicitName, "--instance");
	if (process.env.GARY_INSTANCE) return pick(process.env.GARY_INSTANCE, "GARY_INSTANCE");
	if (!names.length) {
		throw new SettingsError(
			hasFlatLayout()
				? `${root} still has the layout from before instances. Run \`gary setup\` once to move it into ${instancesDir()}.`
				: `There is no Gary instance in ${root}. Run \`gary setup\` first.`,
		);
	}
	const matches = matchDirectory(cwd, names);
	if (matches.length === 1) return pick(matches[0], "directory");
	const hint = `Instances: ${listing(names)}. Pass --instance <name> or set GARY_INSTANCE.`;
	if (matches.length > 1) throw new SettingsError(`The directory ${cwd} matches several instances: ${matches.join(", ")}. ${hint}`);
	if (names.length === 1) return pick(names[0], "only instance");
	throw new SettingsError(`The directory ${cwd} belongs to no instance. ${hint}`);
}

// One board server serves every instance, so code it calls runs inside withInstance
const scope = new AsyncLocalStorage();

/** Runs `fn` with `name` as the instance, for everything it calls, also across awaits. */
export const withInstance = (name, fn) => scope.run(name, fn);

/** The instance of the current scope, or the resolved one. */
export const instanceName = () => scope.getStore() ?? resolveInstance().name;
export function homeDir() {
	return instanceDir(instanceName());
}

export const configFile = () => join(homeDir(), "config.json");
export const stateDir = () => join(homeDir(), "state");
/** The shared personal.md in the root. Accepted personal rule proposals go here. */
export const personalFile = () => join(rootDir(), "personal.md");
/** Personal rules in reading order: the shared file first, then the instance's own when it exists. */
export const personalFiles = () => [personalFile(), ...(existsSync(join(homeDir(), "personal.md")) ? [join(homeDir(), "personal.md")] : [])];

/** Resolves a path from config.json: `~` expands, a relative path is relative to the instance directory. */
export function homePath(path) {
	const p = expandHome(path);
	return isAbsolute(p) ? p : resolve(homeDir(), p);
}

function readSettings(file, what) {
	if (!existsSync(file)) {
		throw new SettingsError(`${what} ${file} does not exist. Run \`gary setup\` first.`);
	}
	let data;
	try {
		// A profile.json may carry comments. A config.json may not, because accepted setting proposals rewrite it
		data = file.endsWith("profile.json") ? readJsoncFile(file) : JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		throw new SettingsError(`${what} ${file} is not valid JSON: ${e.message}`);
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new SettingsError(`${what} ${file} must hold a JSON object`);
	return data;
}

function check(errors, cond, message) {
	if (!cond) errors.push(message);
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isStringList = (v, pattern) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0 && (!pattern || pattern.test(s)));

/**
 * The problems in a config.json object, split in two: `errors` make it invalid, `unknown` names fields this
 * version of Gary does not know. Setup and doctor refuse both, so typos get caught. At run time unknown fields
 * are only warnings, so a config written for a newer Gary does not take the board down.
 */
export function checkConfig(data) {
	if (isContributions(data)) return checkContributionsConfig(data);
	const errors = [];
	const unknown = [];
	const known = ["profile", "me", "checkout", "fixReview", "review", "autoReview", "models", "tab", ...Object.keys(CONFIG_DEFAULTS)];
	for (const key of Object.keys(data)) {
		if (key === "port") errors.push('"port" belongs in the root config.json now. Run `gary migrate`');
		else check(unknown, known.includes(key), `unknown field "${key}"`);
	}
	checkTab(errors, unknown, data.tab);
	check(errors, data.kind === undefined || INSTANCE_KINDS.includes(data.kind), `"kind" must be one of ${INSTANCE_KINDS.join(", ")}`);
	check(errors, typeof data.profile === "string" && data.profile.length > 0, `"profile" must name the project profile directory`);
	check(errors, typeof data.me === "string" && LOGIN.test(data.me), `"me" must be your GitHub login`);
	check(errors, data.checkout === undefined || (typeof data.checkout === "string" && data.checkout.length > 0), `"checkout" must name your local clone of the repository`);
	const bot = data.bot ?? null;
	if (bot !== null) {
		const ok = typeof bot === "object" && !Array.isArray(bot) && typeof bot.login === "string" && LOGIN.test(bot.login) && typeof bot.tokenFile === "string" && bot.tokenFile.length > 0;
		check(errors, ok, `"bot" must be null or { "login": "<bot login>", "tokenFile": "<path to its token>" }`);
		if (ok) {
			for (const key of Object.keys(bot)) check(unknown, ["login", "tokenFile"].includes(key), `unknown field "bot.${key}"`);
			check(errors, bot.login.toLowerCase() !== String(data.me).toLowerCase(), `"bot.login" must differ from "me"`);
		}
	}
	check(errors, data.allowOwnTokenPushes === undefined || typeof data.allowOwnTokenPushes === "boolean", `"allowOwnTokenPushes" must be true or false`);
	for (const key of ["activeWindowDays", "activeMaxWaitDays", "maxFullReviewsPerRun", "maxAutoFixesPerRun", "maxPendingAutoFixes"]) {
		check(errors, data[key] === undefined || isInt(data[key], 0, 3650), `"${key}" must be a whole number`);
	}
	check(errors, data.fastTier === undefined || FAST_TIERS.includes(data.fastTier), `"fastTier" must be one of ${FAST_TIERS.join(", ")}`);
	check(errors, data.escalateAs === undefined || ESCALATE_AS.includes(data.escalateAs), `"escalateAs" must be one of ${ESCALATE_AS.join(", ")}`);
	const fr = data.fixReview;
	if (fr !== undefined) {
		if (!fr || typeof fr !== "object" || Array.isArray(fr)) {
			errors.push(`"fixReview" must be { "requestAs", "maxRounds", "markReady" }`);
		} else {
			for (const key of Object.keys(fr)) check(unknown, FIX_REVIEW_FIELDS.includes(key), `unknown field "fixReview.${key}"`);
			check(errors, fr.reviewer === undefined || FIX_REVIEWERS.includes(fr.reviewer), `"fixReview.reviewer" must be one of ${FIX_REVIEWERS.join(", ")}`);
			check(errors, fr.requestAs === undefined || FIX_REVIEW_REQUESTERS.includes(fr.requestAs), `"fixReview.requestAs" must be one of ${FIX_REVIEW_REQUESTERS.join(", ")}`);
			check(errors, fr.maxRounds === undefined || isInt(fr.maxRounds, 0, 3), `"fixReview.maxRounds" must be 0, 1, 2 or 3`);
			check(errors, fr.markReady === undefined || typeof fr.markReady === "boolean", `"fixReview.markReady" must be true or false`);
		}
	}
	const ar = data.autoReview;
	if (ar !== undefined) {
		if (!ar || typeof ar !== "object" || Array.isArray(ar)) {
			errors.push(`"autoReview" must be { "enabled", "kinds", "maxPerRun" }`);
		} else {
			for (const key of Object.keys(ar)) check(unknown, Object.keys(AUTO_REVIEW_DEFAULTS).includes(key), `unknown field "autoReview.${key}"`);
			check(errors, ar.enabled === undefined || typeof ar.enabled === "boolean", `"autoReview.enabled" must be true or false`);
			check(errors, ar.kinds === undefined || (Array.isArray(ar.kinds) && ar.kinds.every((k) => AUTO_REVIEW_KINDS.includes(k))), `"autoReview.kinds" must be a list with only ${AUTO_REVIEW_KINDS.join(", ")}`);
			check(errors, ar.maxPerRun === undefined || isInt(ar.maxPerRun, 0, 50), `"autoReview.maxPerRun" must be a whole number from 0 to 50`);
		}
	}
	checkReviewConfig(data.review, "maintainer", errors, unknown);
	checkModels(data.models, "instance", errors, unknown);
	return { errors, unknown };
}

// Fields of a maintainer instance that mean nothing without a profile, a bot or a checkout
const MAINTAINER_ONLY = ["profile", "checkout", "bot", "allowOwnTokenPushes", "maxFullReviewsPerRun", "maxAutoFixesPerRun", "maxPendingAutoFixes", "fixReview", "fastTier", "escalateAs", "autoReview"];

/** The problems in the config.json of a contributions instance, split like checkConfig. */
function checkContributionsConfig(data) {
	const errors = [];
	const unknown = [];
	for (const key of Object.keys(data)) {
		if (key === "port") errors.push('"port" belongs in the root config.json now. Run `gary migrate`');
		else if (MAINTAINER_ONLY.includes(key)) errors.push(`"${key}" is only for maintainer instances. A contributions instance has no profile, bot or checkout`);
		else check(unknown, CONTRIBUTIONS_FIELDS.includes(key), `unknown field "${key}"`);
	}
	checkTab(errors, unknown, data.tab);
	check(errors, typeof data.me === "string" && LOGIN.test(data.me), `"me" must be your GitHub login`);
	check(errors, data.title === undefined || (typeof data.title === "string" && data.title.trim().length > 0 && data.title.length <= 60), `"title" must be the tab title, at most 60 characters`);
	for (const key of ["include", "exclude"]) {
		const v = data[key];
		check(errors, v === undefined || (Array.isArray(v) && v.length <= MAX_REPO_GLOBS && v.every((g) => typeof g === "string" && REPO_GLOB.test(g))), `"${key}" must be a list of at most ${MAX_REPO_GLOBS} repositories like "owner/name" or "owner/*"`);
	}
	for (const key of ["activeWindowDays", "activeMaxWaitDays"]) check(errors, data[key] === undefined || isInt(data[key], 1, 3650), `"${key}" must be a whole number of days`);
	const [min, max] = MAX_ITEMS_RANGE;
	check(errors, data.maxItems === undefined || isInt(data.maxItems, min, max), `"maxItems" must be a whole number from ${min} to ${max}`);
	check(errors, data.mergeReminderDays === undefined || isInt(data.mergeReminderDays, 1, 3650), `"mergeReminderDays" must be a whole number of days`);
	const perRepo = data.mergeReminderDaysFor;
	check(
		errors,
		perRepo === undefined || (perRepo && typeof perRepo === "object" && !Array.isArray(perRepo) && Object.keys(perRepo).length <= MAX_REPO_GLOBS && Object.entries(perRepo).every(([g, d]) => REPO_GLOB.test(g) && isInt(d, 1, 3650))),
		`"mergeReminderDaysFor" must map repositories like "owner/name" or "owner/*" to a whole number of days`,
	);
	check(errors, data.clearNotifications === undefined || typeof data.clearNotifications === "boolean", `"clearNotifications" must be true or false`);
	const roots = data.checkoutRoots;
	check(
		errors,
		roots === undefined || (Array.isArray(roots) && roots.length <= MAX_CHECKOUT_ROOTS && roots.every((r) => typeof r === "string" && (isAbsolute(r) || r === "~" || r.startsWith("~/")))),
		`"checkoutRoots" must be a list of at most ${MAX_CHECKOUT_ROOTS} directories, each an absolute path or a path that starts with ~/`,
	);
	checkReviewDrafts(data, errors);
	checkReviewConfig(data.review, "contributions", errors, unknown);
	checkModels(data.models, "instance", errors, unknown);
	return { errors, unknown };
}

function checkReviewDrafts(data, errors) {
	check(errors, data.maxAutoReviewDraftsPerRun === undefined || isInt(data.maxAutoReviewDraftsPerRun, 0, REVIEW_DRAFT_COUNT_MAX), `"maxAutoReviewDraftsPerRun" must be a whole number from 0 to ${REVIEW_DRAFT_COUNT_MAX}. 0 starts no review draft without your click`);
	check(errors, data.maxPendingAutoReviewDrafts === undefined || isInt(data.maxPendingAutoReviewDrafts, 0, REVIEW_DRAFT_COUNT_MAX), `"maxPendingAutoReviewDrafts" must be a whole number from 0 to ${REVIEW_DRAFT_COUNT_MAX}`);
	check(errors, data.reviewDraftMaxLines === undefined || isInt(data.reviewDraftMaxLines, 1, REVIEW_DRAFT_MAX_LINES_MAX), `"reviewDraftMaxLines" must be a whole number of changed lines from 1 to ${REVIEW_DRAFT_MAX_LINES_MAX}`);
}

/** Every problem in a config.json object, unknown fields included. An empty list means it is valid. */
export function validateConfig(data) {
	const { errors, unknown } = checkConfig(data);
	return [...unknown, ...errors];
}

// Nested quantifiers like (a+)+ can backtrack for a very long time
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

function checkAutomatedComments(list, errors, unknown) {
	if (list === undefined) return;
	if (!Array.isArray(list)) return errors.push(`"automatedComments" must be a list of { "name", "pattern", "origin" }`);
	list.forEach((entry, i) => {
		const at = `automatedComments[${i}]`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return errors.push(`"${at}" must be an object`);
		for (const key of Object.keys(entry)) check(unknown, ["name", "pattern", "origin"].includes(key), `unknown field "automatedComments[${i}].${key}"`);
		check(errors, typeof entry.name === "string" && entry.name.trim().length > 0, `"${at}.name" must name the pattern`);
		check(errors, entry.origin === undefined || typeof entry.origin === "string", `"${at}.origin" must be a string`);
		if (typeof entry.pattern !== "string" || !entry.pattern.length || entry.pattern.length > MAX_PATTERN) {
			return errors.push(`"${at}.pattern" must be a regular expression of at most ${MAX_PATTERN} characters`);
		}
		try {
			new RegExp(entry.pattern);
		} catch (e) {
			return errors.push(`"${at}.pattern" is not a valid regular expression: ${e.message}`);
		}
		check(errors, !NESTED_QUANTIFIER.test(entry.pattern), `"${at}.pattern" nests quantifiers, which can make matching very slow`);
	});
}

function checkEscalateResult(pattern, errors) {
	if (pattern === undefined || pattern === null) return;
	if (typeof pattern !== "string" || !pattern.trim() || pattern.length > MAX_PATTERN) {
		return errors.push(`"escalateResult" must be a regular expression of at most ${MAX_PATTERN} characters`);
	}
	let groups;
	try {
		new RegExp(pattern);
		// Append an empty alternative so the match lists every group of the pattern
		groups = new RegExp(`${pattern}|`).exec("").length - 1;
	} catch (e) {
		return errors.push(`"escalateResult" is not a valid regular expression: ${e.message}`);
	}
	check(errors, groups === 1, `"escalateResult" must have exactly one capture group, for the issue number`);
	check(errors, !NESTED_QUANTIFIER.test(pattern), `"escalateResult" nests quantifiers, which can make matching very slow`);
}

// `COMMIT_FORMATS` lists the formats an API edit's commit message can follow. A `commitFormat` of null asks for one plain line
export const COMMIT_FORMATS = ["conventional"];
export const PROFILE_MERGE_METHODS = ["squash", "merge", "rebase"];

export const MAX_AUTOFIX_COMMANDS = 10;
const MAX_COMMAND = 500;
const isCommand = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_COMMAND && !/[\n\r]/.test(v);

const isGlobList = (v) => Array.isArray(v) && v.length > 0 && v.length <= 20 && v.every((g) => typeof g === "string" && g.trim().length > 0 && g.length <= 200);
// A string runs for every changed file. The object form limits the command to the files its globs match
function isAutofixCommand(v) {
	if (isCommand(v)) return true;
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	return Object.keys(v).every((k) => k === "run" || k === "files") && isCommand(v.run) && isGlobList(v.files);
}

function checkAutofix(data, errors) {
	const cmds = data.autofixCommands;
	check(
		errors,
		cmds === undefined || (Array.isArray(cmds) && cmds.length <= MAX_AUTOFIX_COMMANDS && cmds.every(isAutofixCommand)),
		`"autofixCommands" must be a list of at most ${MAX_AUTOFIX_COMMANDS} entries. An entry is a one-line shell command of at most ${MAX_COMMAND} characters, or { "run": <command>, "files": [<glob>, …] }`,
	);
	const setup = data.autofixSetup;
	check(errors, setup === undefined || setup === null || isCommand(setup), `"autofixSetup" must be null or one shell command on one line, at most ${MAX_COMMAND} characters`);
	check(errors, setup === undefined || setup === null || (Array.isArray(cmds) && cmds.length > 0), `"autofixSetup" needs "autofixCommands" to run after it`);
}

/** The problems in a profile.json object, split like checkConfig. */
export function checkProfile(data) {
	const errors = [];
	const unknown = [];
	const known = ["name", "repo", ...Object.keys(PROFILE_DEFAULTS)];
	for (const key of Object.keys(data)) {
		// The local reviewers run commands, so only the instance's own config.json may name them
		if (key === "review") errors.push(`"review" belongs in the instance's config.json. A profile cannot name reviewers, because a local reviewer can run a command on your machine`);
		else check(unknown, known.includes(key), `unknown field "${key}"`);
	}
	check(errors, typeof data.name === "string" && data.name.trim().length > 0 && data.name.length <= 60, `"name" must be the board title, at most 60 characters`);
	check(errors, typeof data.repo === "string" && REPO.test(data.repo), `"repo" must look like "owner/name"`);
	for (const key of ["maintainers", "botLogins"]) {
		check(errors, data[key] === undefined || isStringList(data[key], LOGIN), `"${key}" must be a list of GitHub logins`);
	}
	checkReviewBots(data.reviewBots, errors, unknown, data.botCommands);
	check(errors, data.relatedRepos === undefined || isStringList(data.relatedRepos, REPO_NAME), `"relatedRepos" must be a list of repository names of the same owner`);
	for (const key of ["sensitivePaths", "autoLabels", "requiredTools", "aiAuthors"]) {
		check(errors, data[key] === undefined || isStringList(data[key]), `"${key}" must be a list of strings`);
	}
	const cmds = data.botCommands;
	check(
		errors,
		cmds === undefined || (cmds && typeof cmds === "object" && !Array.isArray(cmds) && Object.values(cmds).every((v) => typeof v === "string" && v.trim())),
		`"botCommands" must map command names to the text to post`,
	);
	checkAutomatedComments(data.automatedComments, errors, unknown);
	checkEscalateResult(data.escalateResult, errors);
	const paths = data.autoReviewPaths;
	if (paths !== undefined) {
		if (!paths || typeof paths !== "object" || Array.isArray(paths)) errors.push(`"autoReviewPaths" must map a kind to a list of globs, like { "config": ["data/devices/**"] }`);
		else {
			for (const [kind, globs] of Object.entries(paths)) {
				if (!AUTO_REVIEW_KINDS.includes(kind)) unknown.push(`unknown field "autoReviewPaths.${kind}"`);
				else check(errors, isStringList(globs), `"autoReviewPaths.${kind}" must be a list of globs`);
			}
		}
	}
	const due = data.dueDateFields;
	check(errors, due === undefined || (isStringList(due) && due.length <= 20 && due.every((f) => f.trim().length > 0 && f.length <= 100)), `"dueDateFields" must be a list of at most 20 project field names, each at most 100 characters`);
	const cmd = data.formatCommand;
	check(errors, cmd === undefined || cmd === null || (typeof cmd === "string" && cmd.trim().length > 0 && cmd.length <= 200 && !/[`\n\r]/.test(cmd)), `"formatCommand" must be the one-line command a contributor runs to format, at most 200 characters, without backticks`);
	checkAutofix(data, errors);
	check(errors, data.mergeMethod === undefined || PROFILE_MERGE_METHODS.includes(data.mergeMethod), `"mergeMethod" must be one of ${PROFILE_MERGE_METHODS.map((m) => `"${m}"`).join(", ")}`);
	check(errors, data.commitFormat === undefined || data.commitFormat === null || COMMIT_FORMATS.includes(data.commitFormat), `"commitFormat" must be null or one of ${COMMIT_FORMATS.map((f) => `"${f}"`).join(", ")}`);
	return { errors, unknown };
}

/** Every problem in a profile.json object, unknown fields included. An empty list means it is valid. */
export function validateProfile(data) {
	const { errors, unknown } = checkProfile(data);
	return [...unknown, ...errors];
}

// The caches check the file's mtime, so an edited config or profile applies on the next call, also in the server.
// They hold failures too, so a broken file is not parsed again on every call
const configCache = new Map();
const profileCache = new Map();
// The last valid settings per file. A long-running process keeps using them while the file is broken
const lastGood = new Map();
// Unknown fields per file, from the last load
const unknownFields = new Map();

function cached(cache, file, load) {
	let mtime = null;
	try {
		const st = statSync(file);
		mtime = `${st.mtimeMs}:${st.size}`;
	} catch {
		// A missing file goes to load(), which names it in its error
	}
	const hit = cache.get(file);
	if (hit && mtime !== null && hit.mtime === mtime) {
		if (hit.error) throw hit.error;
		return hit.value;
	}
	try {
		const value = load();
		cache.set(file, { mtime, value });
		lastGood.set(file, value);
		return value;
	} catch (error) {
		cache.set(file, { mtime, error });
		throw error;
	}
}

/** The current settings of a file, or its last valid ones when it broke since. Only a file never valid throws. */
function withFallback(file, load) {
	try {
		return load();
	} catch (e) {
		if (e instanceof SettingsError && lastGood.has(file)) return lastGood.get(file);
		throw e;
	}
}

const configPath = (name) => join(instanceDir(name), "config.json");

function readConfig(name) {
	const file = configPath(name);
	return cached(configCache, file, () => {
		const data = readSettings(file, "Config");
		const { errors, unknown } = checkConfig(data);
		unknownFields.set(file, unknown);
		if (errors.length) throw new SettingsError(`Config ${file} is invalid:\n- ${errors.join("\n- ")}`);
		if (isContributions(data)) return { ...CONTRIBUTIONS_DEFAULTS, ...REVIEW_DRAFT_DEFAULTS, ...data, bot: null, allowOwnTokenPushes: false, fastTier: "off", escalateAs: "prefill" };
		return { ...CONFIG_DEFAULTS, ...data, bot: data.bot ?? null };
	});
}

/**
 * Loads and validates one instance's config.json. Throws a SettingsError that names the file and every problem,
 * unless this process loaded a valid version before: then that one is returned and loadInstance names the error.
 */
export function loadConfigFor(name) {
	return withFallback(configPath(name), () => readConfig(name));
}

/** Resolves a path from an instance's config.json: `~` expands, a relative path is relative to the instance directory. */
export function instancePath(name, path) {
	const p = expandHome(path);
	return isAbsolute(p) ? p : resolve(instanceDir(name), p);
}

/** The profile directory of an instance, or null for a contributions instance, which has none. */
export const profileDirFor = (name) => {
	const config = loadConfigFor(name);
	return isContributions(config) ? null : instancePath(name, config.profile);
};

const profilePath = (name) => join(profileDirFor(name), "profile.json");

// The profile code reads for a contributions instance. It names no repo, maintainers, labels or commands
const contributionsProfile = (config) => ({ ...PROFILE_DEFAULTS, name: config.title, repo: null });

function readProfile(name) {
	const config = loadConfigFor(name);
	if (isContributions(config)) return contributionsProfile(config);
	const file = profilePath(name);
	return cached(profileCache, file, () => {
		const data = readSettings(file, "Profile");
		const { errors, unknown } = checkProfile(data);
		unknownFields.set(file, unknown);
		if (errors.length) throw new SettingsError(`Profile ${file} is invalid:\n- ${errors.join("\n- ")}`);
		return { ...PROFILE_DEFAULTS, ...data };
	});
}

/** Loads and validates the profile.json of one instance, with the same fallback as loadConfigFor. */
export function loadProfileFor(name) {
	const config = loadConfigFor(name);
	if (isContributions(config)) return contributionsProfile(config);
	return withFallback(profilePath(name), () => readProfile(name));
}

/**
 * Why the instance's settings on disk are not valid right now, or null. Unknown fields do not count.
 * While this is set, loadInstance serves the last valid settings.
 */
export function settingsErrorFor(name) {
	try {
		readConfig(name);
		readProfile(name);
		return null;
	} catch (e) {
		if (e instanceof SettingsError) return e.message;
		throw e;
	}
}

/** The unknown fields of the instance's config and profile, with the file each is in. */
export function settingsWarningsFor(name) {
	const out = [];
	const files = [configPath(name)];
	try {
		if (profileDirFor(name)) files.push(profilePath(name));
	} catch {
		// Without a config there is no profile to name
	}
	for (const file of files) for (const w of unknownFields.get(file) ?? []) out.push(`${file}: ${w}`);
	return out;
}

/**
 * The trigger comments of the review bots of every maintainer instance, trimmed and in lower case. A contributions
 * instance has no profile, so its checks use these. An instance whose settings do not load adds none.
 */
export function allReviewTriggers() {
	const out = new Set();
	for (const name of instanceNames()) {
		try {
			if (isContributions(loadConfigFor(name))) continue;
			for (const c of reviewTriggerComments(loadProfileFor(name))) if (c.trim()) out.add(c.trim().toLowerCase());
		} catch {
			continue;
		}
	}
	return [...out];
}

/** The resolved instance's config. */
export const loadConfig = () => loadConfigFor(instanceName());
export const profileDir = () => profileDirFor(instanceName());
/** The resolved instance's profile. */
export const loadProfile = () => loadProfileFor(instanceName());

function pausedIn(state) {
	return readJsonSync(join(state, "control.json"))?.paused === true;
}

/**
 * Everything about one instance: settings, profile and paths. It does not depend on the resolved instance.
 * `{ name, kind, dir, state, board, config, profile, profileDir, repos, title, checkout, personal, paused }`,
 * plus `settingsError` when the files on disk broke after this process last loaded them, and `settingsWarnings`
 * for unknown fields. Settings that were never valid in this process throw.
 */
export function loadInstance(name) {
	if (!INSTANCE_NAME.test(name ?? "")) throw new SettingsError(`"${name}" is not a valid instance name.`);
	const settingsError = settingsErrorFor(name);
	const settingsWarnings = settingsWarningsFor(name);
	const config = loadConfigFor(name);
	const profile = loadProfileFor(name);
	const dir = instanceDir(name);
	const state = join(dir, "state");
	const own = join(dir, "personal.md");
	const contributions = isContributions(config);
	return {
		name,
		kind: config.kind,
		dir,
		state,
		board: join(state, "board"),
		config,
		profile,
		profileDir: profileDirFor(name),
		// A maintainer instance triages the one repository of its profile. A contributions instance covers the repos its snapshot found
		repos: contributions ? contributionRepos(name, state) : [profile.repo],
		title: profile.name,
		checkout: !contributions && config.checkout ? instancePath(name, config.checkout) : null,
		personal: [personalFile(), ...(existsSync(own) ? [own] : [])],
		paused: pausedIn(state),
		...(settingsError && { settingsError }),
		...(settingsWarnings.length && { settingsWarnings }),
	};
}

/**
 * The files whose change alters what loadInstance returns: the instance's config.json and its profile.json.
 * A server that watches them can push a fresh board event. The profile may live outside the root.
 */
export function instanceSettingsFiles(name) {
	const files = [join(instanceDir(name), "config.json")];
	try {
		const dir = profileDirFor(name);
		if (dir) files.push(join(dir, "profile.json"));
	} catch {
		// Without a readable config there is no profile to watch yet
	}
	return files;
}

/**
 * Every instance under the root with its name, kind, repos, title, checkout and pause, and `settingsError` and
 * `settingsWarnings` when there are any. An instance never valid in this process has `valid: false`, no repos
 * and its error, so nothing serves items for it.
 */
export function listInstances() {
	return instanceNames().map((name) => {
		try {
			const i = loadInstance(name);
			return {
				name, kind: i.kind, repos: i.repos, title: i.title, checkout: i.checkout, paused: i.paused, valid: true,
				...(i.settingsError && { settingsError: i.settingsError }),
				...(i.settingsWarnings && { settingsWarnings: i.settingsWarnings }),
			};
		} catch (e) {
			return { name, kind: null, repos: [], title: name, checkout: null, paused: false, valid: false, settingsError: e.message };
		}
	});
}

const asInstance = (instance) => (typeof instance === "string" ? loadInstance(instance) : instance);

/** Whether `repo` (owner/name) is one of the instance's allowed repos. `instance` is a name or a loaded instance. */
export function allowedRepo(instance, repo) {
	if (typeof repo !== "string") return false;
	return asInstance(instance).repos.some((r) => r.toLowerCase() === repo.toLowerCase());
}

/** The local clone for a repo of the instance, or null. A contributions instance has none. */
export function checkoutFor(instance, repo) {
	const i = asInstance(instance);
	return allowedRepo(i, repo) ? i.checkout : null;
}

/** The profile's rules file of a topic for a repo of the instance, like rules/review.md, or null. A contributions instance has none. */
export function rulesFor(instance, repo, topic) {
	const i = asInstance(instance);
	if (!i.profileDir || !allowedRepo(i, repo) || !/^[a-z0-9-]+$/.test(topic ?? "")) return null;
	return join(i.profileDir, "rules", `${topic}.md`);
}

/**
 * The repos of every maintainer instance on this machine, in lower case. A contributions instance never covers them.
 * It reads the files without validating them, so a broken instance still keeps its repo out.
 */
export function maintainerRepos(names = instanceNames()) {
	const out = new Set();
	for (const n of names) {
		const f = instanceFacts(n);
		if (f.config && !isContributions(f.config) && typeof f.repo === "string") out.add(f.repo.toLowerCase());
	}
	return out;
}

// The repos per snapshot file, keyed by path, mtime and size
const snapshotRepos = new Map();

function reposOfSnapshot(file) {
	let key;
	try {
		const st = statSync(file);
		key = `${st.mtimeMs}:${st.size}`;
	} catch {
		return [];
	}
	const hit = snapshotRepos.get(file);
	if (hit?.key === key) return hit.repos;
	const items = readJsonSync(file)?.items;
	const repos = [...new Set(Object.values(items && typeof items === "object" ? items : {}).map((e) => e?.repo).filter((r) => typeof r === "string" && REPO.test(r)))];
	snapshotRepos.set(file, { key, repos });
	return repos;
}

/**
 * The repos a contributions instance may name: those of its staged and its committed snapshot, minus every repo of a
 * maintainer instance on this machine. Sorted, in the case the snapshot has.
 */
export function contributionRepos(name, state = join(instanceDir(name), "state")) {
	const blocked = maintainerRepos(instanceNames().filter((n) => n !== name));
	const all = [...reposOfSnapshot(join(state, "snapshot.pending.json")), ...reposOfSnapshot(join(state, "snapshot.json"))];
	const seen = new Map();
	for (const r of all) if (!blocked.has(r.toLowerCase()) && !seen.has(r.toLowerCase())) seen.set(r.toLowerCase(), r);
	return [...seen.values()].sort();
}

/** The reference of an item across repos: owner/name#number. */
export const itemRef = (item) => `${item.repo}#${item.number}`;

/** Owner and name of a repo, by default the resolved instance's one repo. */
export function repoParts(repo = loadProfile().repo) {
	const [owner, name] = repo.split("/");
	return { owner, name };
}

/** Logins that count as maintainers: the profile's list plus `me`. */
export function maintainerLogins() {
	return [...new Set([...loadProfile().maintainers, loadConfig().me].map((l) => l.toLowerCase()))];
}

/** Logins shown as bot: the profile's list plus the configured bot account. GitHub Apps count as bots too. */
export function botLogins() {
	const bot = loadConfig().bot?.login;
	return [...new Set([...loadProfile().botLogins, ...(bot ? [bot] : [])].map((l) => l.toLowerCase()))];
}

export function paths() {
	const out = { instance: null, root: rootDir(), home: null, config: null, personal: [personalFile()], profile: null, state: null, checkout: null, core: ROOT };
	try {
		out.instance = instanceName();
		out.home = homeDir();
		out.config = configFile();
		out.personal = personalFiles();
		out.state = stateDir();
		out.profile = profileDir();
		const { checkout, kind } = loadConfig();
		if (checkout && kind !== "contributions") out.checkout = homePath(checkout);
	} catch (e) {
		out.error = e.message;
	}
	return out;
}
