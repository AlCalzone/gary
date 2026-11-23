import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homePath, loadConfig, loadProfile, repoParts } from "./config.mjs";

const GH_TIMEOUT_MS = 60000;
const STDERR_TAIL = 500;
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const READ_ONLY_FLAGS = ["--jq", "-q", "--paginate", "--slurp", "-H", "--header", "-i", "--include", "--cache", "--silent", "--verbose", "-t", "--template", "--hostname"];

export const GRAPHQL_ARGS = ["api", "graphql", "--input", "-"];

export const READ_ONLY_MESSAGE = "This is a contributions instance. Gary writes nothing to GitHub for it: post the text on GitHub yourself.";

/** Whether the instance in scope is a contributions instance, which never writes to GitHub. */
function readOnlyInstance() {
	try {
		return loadConfig().kind === "contributions";
	} catch {
		// Without a resolvable instance nothing marks the call as read-only
		return false;
	}
}

/**
 * Which account `gh` acts as for writes:
 * "bot" with a configured bot, "own" without a bot but with allowOwnTokenPushes, "none" otherwise.
 */
export function accountMode() {
	const config = loadConfig();
	if (config.bot) return "bot";
	return config.allowOwnTokenPushes ? "own" : "none";
}

/** The login that writes run as, or null when no account may write. */
export function writeLogin() {
	const config = loadConfig();
	return { bot: config.bot?.login, own: config.me, none: null }[accountMode()];
}

let cachedToken;

function botToken() {
	const { bot } = loadConfig();
	const file = homePath(bot.tokenFile);
	if (cachedToken?.file !== file) {
		let token;
		try {
			token = readFileSync(file, "utf8").trim();
		} catch (e) {
			throw new Error(`Cannot read the bot token file ${file}: ${e.message}`);
		}
		if (!token) throw new Error(`Bot token file ${file} is empty`);
		cachedToken = { file, token };
	}
	return cachedToken.token;
}

function tail(text) {
	const t = (text ?? "").trim();
	return t.length > STDERR_TAIL ? "…" + t.slice(-STDERR_TAIL) : t;
}

/** Environment in which gh falls back to the login stored by `gh auth login`. */
function storedLoginEnv() {
	const env = { ...process.env, ...GH_ENV };
	for (const name of TOKEN_VARS) delete env[name];
	return env;
}

/**
 * Tells whether a gh invocation can change anything on GitHub.
 * Only `gh api` GET requests and GraphQL queries count as reads. Everything else counts as a write.
 */
export function isWrite(args, input) {
	if (args[0] !== "api") return true;
	const method = args.find((a, i) => args[i - 1] === "-X" || args[i - 1] === "--method") ?? args.find((a) => a.startsWith("--method="))?.slice(9);
	if (args[1] === "graphql") {
		let query = "";
		try {
			query = JSON.parse(input || "{}").query ?? "";
		} catch {
			return true;
		}
		return !/^\s*(query\b|\{)/.test(query);
	}
	if (method) return method.toUpperCase() !== "GET";
	// gh api sends a POST as soon as a field or body is given
	return args.slice(2).some((a) => a.startsWith("-") && !READ_ONLY_FLAGS.includes(a.split("=")[0]));
}

/** Reads the login behind the stored gh login ("stored") or behind the bot token ("bot"). Read-only. */
export async function readLogin(which) {
	const env = which === "bot" ? { ...process.env, ...GH_ENV, GH_TOKEN: botToken() } : storedLoginEnv();
	return (await run(["api", "user", "--jq", ".login"], "", env)).trim();
}

/**
 * The OAuth scopes of the stored gh login, from the X-OAuth-Scopes header of a read of the user, as a list.
 * null means GitHub sent no such header, like for a fine-grained token, so the scopes are unknown. Read-only.
 */
export async function storedScopes() {
	const out = await run(["api", "-i", "user"], "", storedLoginEnv());
	const line = out.split(/\r?\n/).find((l) => /^x-oauth-scopes:/i.test(l));
	if (!line) return null;
	return line.slice(line.indexOf(":") + 1).split(",").map((x) => x.trim()).filter(Boolean);
}

/** Checks that the stored gh login is `me` from config.json and returns it. */
export async function verifyOwnLogin() {
	let login;
	try {
		login = (await run(["api", "user", "--jq", ".login"], "", storedLoginEnv())).trim();
	} catch (e) {
		throw new Error(`Could not read your gh login: ${e.message}`);
	}
	const me = loadConfig().me;
	if (login.toLowerCase() !== me.toLowerCase()) {
		throw new Error(`The stored gh login is "${login}", but config.json names "${me}" as you. Nothing was sent.`);
	}
	return login;
}

/**
 * Throws unless the configured accounts allow a write. Writes run as the bot, or without a bot under your own
 * stored login only when allowOwnTokenPushes is true.
 */
export function assertWriteAllowed() {
	if (accountMode() === "none") {
		throw new Error("No bot account is configured and allowOwnTokenPushes is false, so the board cannot write to GitHub. Do this step on GitHub yourself.");
	}
}

/**
 * Runs the `gh` binary and resolves with its stdout. With a bot it runs as the bot.
 * Without a bot, reads use your stored login and writes follow `assertWriteAllowed` and `verifyOwnLogin`.
 * Rejects with an error carrying `stdout` and `stderr` when `gh` exits non-zero or runs longer than 60 s.
 */
export async function gh(args, { input } = {}) {
	if (accountMode() === "bot") return run(args, input, { ...process.env, ...GH_ENV, GH_TOKEN: botToken() });
	if (isWrite(args, input)) {
		assertWriteAllowed();
		await verifyOwnLogin();
	}
	return run(args, input, storedLoginEnv());
}

/**
 * Requests a Copilot review on a PR. By default it runs under your own stored `gh` login. With a bot configured
 * only this helper and `postEscalateCommand` reach that login. It runs only this fixed mutation, after checking that the login is `me`.
 * With `as: "bot"` the bot's token sends the same mutation.
 * With `dryRun` it runs only the login check and returns the invocation it would send.
 */
export async function requestCopilotReview(pullRequestId, { dryRun = false, as = "me" } = {}) {
	if (typeof pullRequestId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(pullRequestId)) {
		throw new Error("pullRequestId must be a node id");
	}
	if (as !== "me" && as !== "bot") throw new Error('as must be "me" or "bot"');
	if (as === "bot" && !loadConfig().bot) throw new Error("No bot account is configured, so the bot cannot request the review");
	const login = as === "bot" ? loadConfig().bot.login : await verifyOwnLogin();
	const env = as === "bot" ? { ...process.env, ...GH_ENV, GH_TOKEN: botToken() } : storedLoginEnv();
	const query = `mutation($id: ID!) { requestCopilotCodeReview(input: { pullRequestId: $id }) { success failureReason } }`;
	const body = { query, variables: { id: pullRequestId } };
	if (dryRun) return { dryRun: true, login, invocation: { command: ["gh", ...GRAPHQL_ARGS], as: login, stdin: body } };

	let stdout;
	try {
		stdout = await run(GRAPHQL_ARGS, JSON.stringify(body), env);
	} catch (e) {
		stdout = e.stdout;
		if (!stdout || e.timedOut) throw new Error(e.message);
	}
	const response = JSON.parse(stdout);
	if (response.errors?.length) throw new Error(response.errors.map((e) => e.message).join("; "));
	return { login, ...response.data.requestCopilotCodeReview };
}

/** Runs one GraphQL request under the stored gh login and returns `data`. */
async function ownGraphql(body) {
	let stdout;
	try {
		stdout = await run(GRAPHQL_ARGS, JSON.stringify(body), storedLoginEnv());
	} catch (e) {
		stdout = e.stdout;
		if (!stdout || e.timedOut) throw new Error(e.message);
	}
	let response;
	try {
		response = JSON.parse(stdout);
	} catch {
		throw new Error(`gh returned non-JSON output: ${stdout.slice(0, 500)}`);
	}
	if (response.errors?.length) throw new Error(response.errors.map((e) => e.message).join("; "));
	return response.data;
}

const MISSING_PERMISSION = /required scopes|not been granted|not accessible by|must have .*access|insufficient/i;

/**
 * Posts the profile's `botCommands.escalate` as a comment on a discussion, under your own stored `gh` login.
 * This is the only code that posts a bot command. The text comes from the profile and from nowhere else.
 * Call it only for a click on the board's escalate button.
 * Throws when the instance has no `escalateAs: "me"`, when the profile has no escalate command, when the stored
 * login is not `me`, when the discussion is closed, and when GitHub refuses the comment.
 * With `dryRun` it runs the checks and the reads, and returns the invocation it would send.
 */
export async function postEscalateCommand({ repo, number, dryRun = false }) {
	if (loadConfig().escalateAs !== "me") throw new Error('Posting the escalate command needs "escalateAs": "me" in config.json.');
	const command = loadProfile().botCommands?.escalate;
	if (typeof command !== "string" || !command.trim()) throw new Error("The profile has no escalate command.");
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("number must be a positive integer");
	const login = await verifyOwnLogin();
	const { owner, name } = repoParts(repo);
	const found = await ownGraphql({
		query: `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { discussion(number: $number) { id url closed category { name } } } }`,
		variables: { owner, name, number },
	});
	const discussion = found?.repository?.discussion;
	if (!discussion) throw new Error(`Discussion #${number} not found`);
	if (discussion.closed) throw new Error(`Discussion #${number} is closed.`);
	const body = {
		query: `mutation($id: ID!, $body: String!) { addDiscussionComment(input: { discussionId: $id, body: $body }) { comment { url } } }`,
		variables: { id: discussion.id, body: command },
	};
	if (dryRun) return { dryRun: true, login, command, invocation: { command: ["gh", ...GRAPHQL_ARGS], as: login, stdin: body } };
	let data;
	try {
		data = await ownGraphql(body);
	} catch (e) {
		if (MISSING_PERMISSION.test(e.message)) {
			throw new Error(`Your gh login ${login} may not comment on discussions of ${owner}/${name}. GitHub says: ${e.message}`);
		}
		throw e;
	}
	return { login, command, url: data?.addDiscussionComment?.comment?.url ?? discussion.url };
}

function run(args, input, env) {
	// Every write of every helper passes here, so no code path can write for a contributions instance
	if (isWrite(args, input) && readOnlyInstance()) return Promise.reject(new Error(READ_ONLY_MESSAGE));
	return new Promise((resolve, reject) => {
		const child = execFile(
			"gh",
			args,
			{ env, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: GH_TIMEOUT_MS, killSignal: "SIGKILL" },
			(error, stdout, stderr) => {
				if (error) {
					error.stdout = stdout;
					error.stderr = stderr;
					error.timedOut = error.killed === true;
					const reason = error.timedOut ? `gh timed out after ${GH_TIMEOUT_MS / 1000} s` : `gh exited with ${error.code}`;
					error.message = tail(stderr) ? `${reason}: ${tail(stderr)}` : reason;
					reject(error);
				} else {
					resolve(stdout);
				}
			},
		);
		child.stdin.end(input ?? "");
	});
}

/** Runs one GraphQL request and returns `data`. Throws on transport or GraphQL errors. */
export async function graphql(query, variables = {}) {
	const input = JSON.stringify({ query, variables });
	let stdout;
	try {
		stdout = await gh(GRAPHQL_ARGS, { input });
	} catch (e) {
		// gh exits non-zero on GraphQL errors but still prints the response body
		stdout = e.stdout;
		if (!stdout || e.timedOut) throw new Error(e.message);
	}
	let response;
	try {
		response = JSON.parse(stdout);
	} catch {
		throw new Error(`gh returned non-JSON output: ${stdout.slice(0, 500)}`);
	}
	if (response.errors?.length) {
		throw new Error(response.errors.map((e) => e.message).join("; "));
	}
	return response.data;
}

const projectAccess = new Map();

/**
 * Whether the token the snapshot reads with may read GitHub Projects, which needs the read:project scope.
 * Resolves `{ ok: true }` or `{ ok: false, reason }`. One small query per process and repository.
 */
export function canReadProjects(repo = loadProfile().repo) {
	if (!projectAccess.has(repo)) {
		const { owner, name } = repoParts(repo);
		projectAccess.set(repo, graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { projectsV2(first: 1) { totalCount } } }`, { owner, name })
			.then(() => ({ ok: true }))
			.catch((e) => ({ ok: false, reason: MISSING_PERMISSION.test(e.message) ? "the token lacks the read:project scope" : e.message })));
	}
	return projectAccess.get(repo);
}
