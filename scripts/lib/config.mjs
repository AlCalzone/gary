// Resolves where everything lives and loads the two settings files.
//   core:     this tool's own directory, found from this file
//   root:     $GARY_HOME, default ~/.config/gary, holds the shared personal.md and instances/
//   home:     the instance directory root/instances/<name>, holds config.json, an optional personal.md and state/
//   profile:  the project directory named by `profile` in config.json, holds profile.json, rules/ and templates/
// The instance comes from --instance, then GARY_INSTANCE, then the working directory, then the only instance.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const REPO_NAME = /^[\w.-]{1,100}$/;

export const INSTANCE_KINDS = ["maintainer"];
export const DEFAULT_PORT = 7878;

export const CONFIG_DEFAULTS = {
	kind: "maintainer",
	bot: null,
	allowOwnTokenPushes: false,
	activeWindowDays: 30,
	activeMaxWaitDays: 14,
	maxFullReviewsPerRun: 10,
	maxAutoFixesPerRun: 2,
	fastTier: "off",
};

export const FAST_TIERS = ["off", "shadow", "on"];

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

/** The server-wide settings in <root>/config.json: `{ port }`. */
export function rootConfig() {
	const file = rootConfigFile();
	const data = existsSync(file) && !hasFlatLayout() ? readSettings(file, "Root config") : {};
	const errors = [];
	for (const key of Object.keys(data)) check(errors, key === "port", `unknown field "${key}"`);
	check(errors, data.port === undefined || isInt(data.port, 1, 65535), `"port" must be a port number`);
	if (errors.length) throw new SettingsError(`Root config ${file} is invalid:\n- ${errors.join("\n- ")}`);
	return { port: data.port ?? DEFAULT_PORT };
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
		return JSON.parse(readFileSync(file, "utf8"));
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
	const profile = typeof config?.profile === "string" ? at(config.profile) : null;
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
		data = JSON.parse(readFileSync(file, "utf8"));
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
	const errors = [];
	const unknown = [];
	const known = ["profile", "me", "checkout", ...Object.keys(CONFIG_DEFAULTS)];
	for (const key of Object.keys(data)) {
		if (key === "port") errors.push('"port" belongs in the root config.json now. Run `gary migrate`');
		else check(unknown, known.includes(key), `unknown field "${key}"`);
	}
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
	for (const key of ["activeWindowDays", "activeMaxWaitDays", "maxFullReviewsPerRun", "maxAutoFixesPerRun"]) {
		check(errors, data[key] === undefined || isInt(data[key], 0, 3650), `"${key}" must be a whole number`);
	}
	check(errors, data.fastTier === undefined || FAST_TIERS.includes(data.fastTier), `"fastTier" must be one of ${FAST_TIERS.join(", ")}`);
	return { errors, unknown };
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

/** The problems in a profile.json object, split like checkConfig. */
export function checkProfile(data) {
	const errors = [];
	const unknown = [];
	const known = ["name", "repo", ...Object.keys(PROFILE_DEFAULTS)];
	for (const key of Object.keys(data)) check(unknown, known.includes(key), `unknown field "${key}"`);
	check(errors, typeof data.name === "string" && data.name.trim().length > 0 && data.name.length <= 60, `"name" must be the board title, at most 60 characters`);
	check(errors, typeof data.repo === "string" && REPO.test(data.repo), `"repo" must look like "owner/name"`);
	for (const key of ["maintainers", "botLogins"]) {
		check(errors, data[key] === undefined || isStringList(data[key], LOGIN), `"${key}" must be a list of GitHub logins`);
	}
	check(errors, data.reviewBots === undefined || isStringList(data.reviewBots, /^copilot$/), `"reviewBots" may only contain "copilot"`);
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

export const profileDirFor = (name) => instancePath(name, loadConfigFor(name).profile);

const profilePath = (name) => join(profileDirFor(name), "profile.json");

function readProfile(name) {
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
		files.push(profilePath(name));
	} catch {
		// Without a config there is no profile to name
	}
	for (const file of files) for (const w of unknownFields.get(file) ?? []) out.push(`${file}: ${w}`);
	return out;
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
	return {
		name,
		kind: config.kind,
		dir,
		state,
		board: join(state, "board"),
		config,
		profile,
		profileDir: profileDirFor(name),
		// A maintainer instance triages the one repository of its profile
		repos: [profile.repo],
		title: profile.name,
		checkout: config.checkout ? instancePath(name, config.checkout) : null,
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
		files.push(join(profileDirFor(name), "profile.json"));
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

/** The local clone for a repo of the instance, or null. */
export function checkoutFor(instance, repo) {
	const i = asInstance(instance);
	return allowedRepo(i, repo) ? i.checkout : null;
}

/** The profile's rules file of a topic for a repo of the instance, like rules/review.md, or null. */
export function rulesFor(instance, repo, topic) {
	const i = asInstance(instance);
	if (!allowedRepo(i, repo) || !/^[a-z0-9-]+$/.test(topic ?? "")) return null;
	return join(i.profileDir, "rules", `${topic}.md`);
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
		const { checkout } = loadConfig();
		if (checkout) out.checkout = homePath(checkout);
	} catch (e) {
		out.error = e.message;
	}
	return out;
}
