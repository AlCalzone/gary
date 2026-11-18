// Resolves where everything lives and loads the two settings files.
//   core:    this tool's own directory, found from this file
//   home:    $GARY_HOME, default ~/.config/gary, holds config.json, personal.md and state/
//   profile: the project directory named by `profile` in config.json, holds profile.json, rules/ and templates/
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const REPO_NAME = /^[\w.-]{1,100}$/;

export const CONFIG_DEFAULTS = {
	bot: null,
	allowOwnTokenPushes: false,
	port: 7878,
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

export function homeDir() {
	return resolve(expandHome(process.env.GARY_HOME || "~/.config/gary"));
}

export const configFile = () => join(homeDir(), "config.json");
export const stateDir = () => join(homeDir(), "state");
export const personalFile = () => join(homeDir(), "personal.md");

/** Resolves a path from config.json: `~` expands, a relative path is relative to home. */
export function homePath(path) {
	const p = expandHome(path);
	return isAbsolute(p) ? p : resolve(homeDir(), p);
}

export class SettingsError extends Error {}

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
	for (const key of Object.keys(data)) check(errors, known.includes(key), `unknown field "${key}"`);
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
	check(errors, data.port === undefined || isInt(data.port, 1, 65535), `"port" must be a port number`);
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

let cachedConfig;
let cachedProfile;

/** Loads and validates config.json from home. Throws a SettingsError that names the file and every problem. */
export function loadConfig() {
	const file = configFile();
	if (cachedConfig?.file === file) return cachedConfig.value;
	const data = readSettings(file, "Config");
	const errors = validateConfig(data);
	if (errors.length) throw new SettingsError(`Config ${file} is invalid:\n- ${errors.join("\n- ")}`);
	const value = { ...CONFIG_DEFAULTS, ...data, bot: data.bot ?? null };
	cachedConfig = { file, value };
	return value;
}

export function profileDir() {
	return homePath(loadConfig().profile);
}

/** Loads and validates profile.json of the configured profile. */
export function loadProfile() {
	const file = join(profileDir(), "profile.json");
	if (cachedProfile?.file === file) return cachedProfile.value;
	const data = readSettings(file, "Profile");
	const errors = validateProfile(data);
	if (errors.length) throw new SettingsError(`Profile ${file} is invalid:\n- ${errors.join("\n- ")}`);
	const value = { ...PROFILE_DEFAULTS, ...data };
	cachedProfile = { file, value };
	return value;
}

export function repoParts() {
	const [owner, name] = loadProfile().repo.split("/");
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
	const out = { core: ROOT, home: homeDir(), profile: null, state: stateDir(), checkout: null, config: configFile(), personal: personalFile() };
	try {
		out.profile = profileDir();
		const { checkout } = loadConfig();
		if (checkout) out.checkout = homePath(checkout);
	} catch (e) {
		out.error = e.message;
	}
	return out;
}
