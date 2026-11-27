import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homePath, loadConfig, loadProfile, repoParts } from "./config.mjs";
import { profileReviewBots } from "./review-bots.mjs";

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

/** The permissions of the stored gh login ("stored") or the bot token ("bot") on `repo`, from one read. Read-only. */
export async function readRepoPermissions(which, repo) {
	const env = which === "bot" ? { ...process.env, ...GH_ENV, GH_TOKEN: botToken() } : storedLoginEnv();
	return JSON.parse(await run(["api", `repos/${repo}`], "", env)).permissions ?? null;
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
	if (readOnlyInstance()) throw new Error(READ_ONLY_MESSAGE);
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
 * The account a review bot is asked under: your stored `gh` login after the check that it is `me`, or the bot's token
 * with `as: "bot"`. Returns `{ login, env }`.
 */
async function askingAccount(as) {
	if (as !== "me" && as !== "bot") throw new Error('as must be "me" or "bot"');
	if (as === "bot" && !loadConfig().bot) throw new Error("No bot account is configured, so the bot cannot ask for the review");
	if (as === "bot") return { login: loadConfig().bot.login, env: { ...process.env, ...GH_ENV, GH_TOKEN: botToken() } };
	return { login: await verifyOwnLogin(), env: storedLoginEnv() };
}

/** Runs one GraphQL request with `env` and returns `data`. Throws on GraphQL errors. */
async function graphqlWith(body, env) {
	let stdout;
	try {
		stdout = await run(GRAPHQL_ARGS, JSON.stringify(body), env);
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

/**
 * Requests a Copilot review on a PR. By default it runs under your own stored `gh` login. With a bot configured
 * only the review bot helpers and `postEscalateCommand` reach that login. It runs only this fixed mutation, after checking that the login is `me`.
 * With `as: "bot"` the bot's token sends the same mutation.
 * With `dryRun` it runs only the login check and returns the invocation it would send.
 */
export async function requestCopilotReview(pullRequestId, { dryRun = false, as = "me" } = {}) {
	if (typeof pullRequestId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(pullRequestId)) {
		throw new Error("pullRequestId must be a node id");
	}
	const { login, env } = await askingAccount(as);
	const query = `mutation($id: ID!) { requestCopilotCodeReview(input: { pullRequestId: $id }) { success failureReason } }`;
	const body = { query, variables: { id: pullRequestId } };
	if (dryRun) return { dryRun: true, login, invocation: { command: ["gh", ...GRAPHQL_ARGS], as: login, stdin: body } };
	return { login, ...(await graphqlWith(body, env)).requestCopilotCodeReview };
}

/**
 * Requests the review of the review bot `botLogin` on a PR through REST `requested_reviewers`, under the account of
 * `as` like `requestCopilotReview`. The login must be one of the profile's review bots with `trigger: "request"`.
 * With `dryRun` it runs only the checks and returns the invocation it would send.
 */
export async function requestBotReview({ repo, number, botLogin, dryRun = false, as = "me" }) {
	const bot = profileReviewBots(loadProfile()).find((b) => b.trigger === "request" && b.key === String(botLogin ?? "").toLowerCase());
	if (!bot) throw new Error(`${botLogin} is no review bot of the profile that takes a review request`);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("number must be a positive integer");
	const { owner, name } = repoParts(repo);
	const { login, env } = await askingAccount(as);
	const args = ["api", `repos/${owner}/${name}/pulls/${number}/requested_reviewers`, "--method", "POST", "-f", `reviewers[]=${bot.login}`];
	if (dryRun) return { dryRun: true, login, invocation: { command: ["gh", ...args], as: login } };
	try {
		await run(args, "", env);
	} catch (e) {
		throw new Error(`GitHub did not request the review of ${bot.login}: ${e.message}`);
	}
	return { login, bot: bot.login };
}

/**
 * Posts the trigger comment of one review bot on a PR, exactly as the profile's `reviewBots` writes it.
 * Besides `postEscalateCommand` this is the only code that posts a bot command. `key` picks the bot. Nothing else goes
 * into the text. Call it only where Gary asks its review bots after a push: `gary fix-review start`, `gary pr-watch review`
 * and the server's request after an API edit.
 * It runs under your own stored `gh` login after the check that it is `me`, or with `as: "bot"` under the bot's token.
 * Throws when the profile has no such bot, when the PR is not open and when GitHub refuses the comment.
 * With `dryRun` it runs the checks and the read, and returns the invocation it would send.
 */
export async function postReviewTrigger({ repo, number, key, dryRun = false, as = "me" }) {
	if (readOnlyInstance()) throw new Error(READ_ONLY_MESSAGE);
	const bot = profileReviewBots(loadProfile()).find((b) => b.trigger === "comment" && b.key === key);
	if (!bot) throw new Error(`${key} is no review bot of the profile with a trigger comment`);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("number must be a positive integer");
	const { owner, name } = repoParts(repo);
	const { login, env } = await askingAccount(as);
	const found = await graphqlWith(
		{
			query: `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { __typename ... on PullRequest { id url state } } } }`,
			variables: { owner, name, number },
		},
		env,
	);
	const pr = found?.repository?.issueOrPullRequest;
	if (pr?.__typename !== "PullRequest") throw new Error(`PR #${number} not found`);
	if (pr.state !== "OPEN") throw new Error(`${pr.url} is not open`);
	const body = {
		query: `mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { commentEdge { node { url } } } }`,
		variables: { id: pr.id, body: bot.comment },
	};
	if (dryRun) return { dryRun: true, login, comment: bot.comment, invocation: { command: ["gh", ...GRAPHQL_ARGS], as: login, stdin: body } };
	const data = await graphqlWith(body, env);
	return { login, comment: bot.comment, url: data?.addComment?.commentEdge?.node?.url ?? pr.url };
}

/** Runs one GraphQL request under the stored gh login and returns `data`. */
const ownGraphql = (body) => graphqlWith(body, storedLoginEnv());

const MISSING_PERMISSION = /required scopes|not been granted|not accessible by|must have .*access|insufficient/i;

/**
 * Posts the profile's `botCommands.escalate` as a comment on a discussion, under your own stored `gh` login.
 * Besides `postReviewTrigger` this is the only code that posts a bot command. The text comes from the profile and from nowhere else.
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

/**
 * Marks the notification of one thread as done in the maintainer's own GitHub inbox, under the stored `gh` login.
 * It is the one request a contributions instance sends that changes anything, and nobody else sees its effect.
 * Call it only for a click on "Got it".
 * Throws without `clearNotifications: true` in config.json and when the stored login is not `me`.
 * Returns `{ found, wasUnread, id }`. A discussion is matched by its title, because its notification names no number.
 * With `dryRun` it runs the checks and the read, and sends nothing.
 */
export async function clearNotification({ repo, kind, number, title, dryRun = false }) {
	if (loadConfig().clearNotifications !== true) throw new Error('Clearing a notification needs "clearNotifications": true in config.json.');
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("number must be a positive integer");
	await verifyOwnLogin();
	const { owner, name } = repoParts(repo);
	const env = storedLoginEnv();
	const threads = JSON.parse(await run(["api", `repos/${owner}/${name}/notifications?all=true&per_page=100`], "", env));
	const type = { pr: "PullRequest", issue: "Issue", discussion: "Discussion" }[kind];
	const path = { pr: `/pulls/${number}`, issue: `/issues/${number}` }[kind];
	const hit = (Array.isArray(threads) ? threads : []).find((t) => t?.subject?.type === type && (path ? String(t.subject.url ?? "").endsWith(path) : t.subject.title === title));
	if (!hit) return { found: false };
	if (!/^\d+$/.test(String(hit.id))) throw new Error("GitHub returned a notification without a numeric id.");
	if (!dryRun) await run(["api", `notifications/threads/${hit.id}`, "--method", "DELETE"], "", env, { inbox: true });
	return { found: true, wasUnread: hit.unread === true, id: String(hit.id), ...(dryRun && { dryRun: true }) };
}

const PENDING_REVIEW_TARGET = `query PendingReviewTarget($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			id number state isDraft headRefOid url author { login }
			reviewRequests(first: 50) { nodes { requestedReviewer { __typename ... on User { login } } } }
			reviews(states: [PENDING], first: 5) { nodes { id url author { login } } } }
	}
}`;

const PENDING_REVIEW_MUTATION = `mutation($id: ID!, $body: String, $sha: GitObjectID, $threads: [DraftPullRequestReviewThread]) {
	addPullRequestReview(input: { pullRequestId: $id, body: $body, commitOID: $sha, threads: $threads }) { pullRequestReview { id url state } }
}`;

/** Runs one GraphQL request under the stored gh login and returns `data`. Throws on transport or GraphQL errors. */
async function storedGraphql(query, variables, flags) {
	let stdout;
	try {
		stdout = await run(GRAPHQL_ARGS, JSON.stringify({ query, variables }), storedLoginEnv(), flags);
	} catch (e) {
		stdout = e.stdout;
		if (!stdout || e.timedOut) throw new Error(e.message);
	}
	const response = JSON.parse(stdout);
	if (response.errors?.length) throw new Error(response.errors.map((e) => e.message).join("; "));
	return response.data;
}

/**
 * Creates a PENDING review on a PR under the maintainer's own stored `gh` login: the body and the inline comments,
 * pinned to `sha`. A pending review is visible only to its author until they submit it on GitHub, and GitHub picks the
 * verdict only on submit. Call it only for a click on the review draft's button.
 * `check(pr, files, login)` runs on the fresh PR and its changed files (`Map<path, patch | null>`) and throws to refuse.
 * Throws when the stored login is not `me` and when the login has a pending review on the PR already.
 * Returns `{ login, url, comments }`, or with `dryRun` the invocation it would send.
 */
export async function createPendingReview({ repo, number, sha, body, comments = [], check = () => {}, dryRun = false }) {
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("number must be a positive integer");
	if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error("sha must be the full head the draft read");
	const login = await verifyOwnLogin();
	const { owner, name } = repoParts(repo);
	const pr = (await storedGraphql(PENDING_REVIEW_TARGET, { owner, name, number }))?.repository?.pullRequest;
	if (!pr) throw new Error(`PR #${number} was not found in ${repo}.`);
	const mine = (pr.reviews?.nodes ?? []).find((r) => String(r?.author?.login).toLowerCase() === login.toLowerCase());
	if (mine) throw Object.assign(new Error("You already have a pending review on this PR. Finish or discard it on GitHub first. Gary does not change it."), { url: mine.url, existing: true });
	const pages = JSON.parse(await run(["api", `repos/${owner}/${name}/pulls/${number}/files?per_page=100`, "--paginate", "--slurp"], "", storedLoginEnv()));
	const files = new Map(pages.flat().map((f) => [f.filename, typeof f.patch === "string" ? f.patch : null]));
	check(pr, files, login);
	const threads = comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", ...(c.startLine !== undefined && { startLine: c.startLine, startSide: "RIGHT" }), body: c.text }));
	const variables = { id: pr.id, body: body || null, sha, threads: threads.length ? threads : null };
	if (dryRun) return { dryRun: true, login, invocation: { command: ["gh", ...GRAPHQL_ARGS], as: login, stdin: JSON.stringify({ query: PENDING_REVIEW_MUTATION, variables }) } };
	let data;
	try {
		data = await storedGraphql(PENDING_REVIEW_MUTATION, variables, { pendingReview: true });
	} catch (e) {
		if (/one pending review/i.test(e.message)) throw Object.assign(new Error("You already have a pending review on this PR. Finish or discard it on GitHub first. Gary does not change it."), { existing: true });
		throw e;
	}
	return { login, url: data?.addPullRequestReview?.pullRequestReview?.url ?? pr.url, comments: threads.length };
}

function run(args, input, env, { inbox = false, pendingReview = false } = {}) {
	// Every write of every helper passes here, so no code path can write for a contributions instance.
	// `inbox` is set only by `clearNotification`, and `pendingReview` only by `createPendingReview`, each for its one fixed request
	if (isWrite(args, input) && readOnlyInstance() && !inbox && !pendingReview) return Promise.reject(new Error(READ_ONLY_MESSAGE));
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
