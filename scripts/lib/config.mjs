// Resolves where everything lives and loads the two settings files.
//   core:     this tool's own directory, found from this file
//   root:     $GARY_HOME, default ~/.config/gary, holds the shared personal.md and instances/
//   home:     the instance directory root/instances/<name>, holds config.json, an optional personal.md and state/
//   profile:  the project directory named by `profile` in config.json, holds profile.json, rules/ and templates/
// The instance comes from --instance, then GARY_INSTANCE, then the working directory, then the only instance.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
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
};

export const PROFILE_DEFAULTS = {
	maintainers: [],
	botLogins: [],
	reviewBots: [],
	relatedRepos: [],
	sensitivePaths: [],
	autoLabels: [],
	botCommands: {},
	requiredTools: [],
};

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

export const instanceName = () => resolveInstance().name;
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

/** Returns the list of problems in a config.json object. An empty list means it is valid. */
export function validateConfig(data) {
	const errors = [];
	const known = ["profile", "me", "checkout", ...Object.keys(CONFIG_DEFAULTS)];
	for (const key of Object.keys(data)) {
		if (key === "port") errors.push('"port" belongs in the root config.json now. Run `gary migrate`');
		else check(errors, known.includes(key), `unknown field "${key}"`);
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
			for (const key of Object.keys(bot)) check(errors, ["login", "tokenFile"].includes(key), `unknown field "bot.${key}"`);
			check(errors, bot.login.toLowerCase() !== String(data.me).toLowerCase(), `"bot.login" must differ from "me"`);
		}
	}
	check(errors, data.allowOwnTokenPushes === undefined || typeof data.allowOwnTokenPushes === "boolean", `"allowOwnTokenPushes" must be true or false`);
	for (const key of ["activeWindowDays", "activeMaxWaitDays", "maxFullReviewsPerRun", "maxAutoFixesPerRun"]) {
		check(errors, data[key] === undefined || isInt(data[key], 0, 3650), `"${key}" must be a whole number`);
	}
	return errors;
}

/** Returns the list of problems in a profile.json object. An empty list means it is valid. */
export function validateProfile(data) {
	const errors = [];
	const known = ["name", "repo", ...Object.keys(PROFILE_DEFAULTS)];
	for (const key of Object.keys(data)) check(errors, known.includes(key), `unknown field "${key}"`);
	check(errors, typeof data.name === "string" && data.name.trim().length > 0 && data.name.length <= 60, `"name" must be the board title, at most 60 characters`);
	check(errors, typeof data.repo === "string" && REPO.test(data.repo), `"repo" must look like "owner/name"`);
	for (const key of ["maintainers", "botLogins"]) {
		check(errors, data[key] === undefined || isStringList(data[key], LOGIN), `"${key}" must be a list of GitHub logins`);
	}
	check(errors, data.reviewBots === undefined || isStringList(data.reviewBots, /^copilot$/), `"reviewBots" may only contain "copilot"`);
	check(errors, data.relatedRepos === undefined || isStringList(data.relatedRepos, REPO_NAME), `"relatedRepos" must be a list of repository names of the same owner`);
	for (const key of ["sensitivePaths", "autoLabels", "requiredTools"]) {
		check(errors, data[key] === undefined || isStringList(data[key]), `"${key}" must be a list of strings`);
	}
	const cmds = data.botCommands;
	check(
		errors,
		cmds === undefined || (cmds && typeof cmds === "object" && !Array.isArray(cmds) && Object.values(cmds).every((v) => typeof v === "string" && v.trim())),
		`"botCommands" must map command names to the text to post`,
	);
	return errors;
}

const configCache = new Map();
const profileCache = new Map();

/** Loads and validates one instance's config.json. Throws a SettingsError that names the file and every problem. */
export function loadConfigFor(name) {
	const file = join(instanceDir(name), "config.json");
	if (configCache.has(file)) return configCache.get(file);
	const data = readSettings(file, "Config");
	const errors = validateConfig(data);
	if (errors.length) throw new SettingsError(`Config ${file} is invalid:\n- ${errors.join("\n- ")}`);
	const value = { ...CONFIG_DEFAULTS, ...data, bot: data.bot ?? null };
	configCache.set(file, value);
	return value;
}

/** Resolves a path from an instance's config.json: `~` expands, a relative path is relative to the instance directory. */
export function instancePath(name, path) {
	const p = expandHome(path);
	return isAbsolute(p) ? p : resolve(instanceDir(name), p);
}

export const profileDirFor = (name) => instancePath(name, loadConfigFor(name).profile);

/** Loads and validates the profile.json of one instance. */
export function loadProfileFor(name) {
	const file = join(profileDirFor(name), "profile.json");
	if (profileCache.has(file)) return profileCache.get(file);
	const data = readSettings(file, "Profile");
	const errors = validateProfile(data);
	if (errors.length) throw new SettingsError(`Profile ${file} is invalid:\n- ${errors.join("\n- ")}`);
	const value = { ...PROFILE_DEFAULTS, ...data };
	profileCache.set(file, value);
	return value;
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
 * `{ name, kind, dir, state, board, config, profile, profileDir, repos, title, checkout, personal, paused }`
 */
export function loadInstance(name) {
	if (!INSTANCE_NAME.test(name ?? "")) throw new SettingsError(`"${name}" is not a valid instance name.`);
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
	};
}

/** Every instance under the root with its name, kind, repos, title, checkout and pause. Broken ones are skipped. */
export function listInstances() {
	return instanceNames().flatMap((name) => {
		try {
			const i = loadInstance(name);
			return [{ name, kind: i.kind, repos: i.repos, title: i.title, checkout: i.checkout, paused: i.paused }];
		} catch {
			return [];
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
