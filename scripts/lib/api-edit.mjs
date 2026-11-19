// The API edit: a small text change committed to a PR's head branch through the GitHub API, without a checkout.
// It is the only push Gary makes to a PR that changes sensitive files. See "API edit" in SPEC.md.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, matchesGlob } from "node:path";
import { runAction } from "./actions.mjs";
import { allowedRepo, instanceName, loadInstance, repoParts, withInstance } from "./config.mjs";
import { PAUSED_MESSAGE, isPaused } from "./control.mjs";
import { GRAPHQL_ARGS, assertWriteAllowed, graphql, writeLogin } from "./gh.mjs";
import { API_EDIT_VIA, isObject } from "./routes.mjs";

/** The caps of one API edit. `lines` counts, per edit, the larger of the replaced and the new line count. */
export const API_EDIT_LIMITS = { edits: 5, files: 3, lines: 40, chars: 4000, path: 300, message: 72, note: 2000 };

const PARAM_KEYS = ["via", "mode", "edits", "message"];
const EDIT_KEYS = ["path", "original", "replacement"];
const COMMIT_TYPES = ["fix", "docs", "chore", "feat", "refactor", "test", "style", "perf"];
const MESSAGE_PATTERN = new RegExp(`^(${COMMIT_TYPES.join("|")})(\\([a-z0-9][a-z0-9 ._/-]*\\))?: \\S.*$`);
// A marker in the message makes GitHub skip the workflows of the push
const SKIP_CI = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks\s*:/i;
const CLOSING_KEYWORD = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s+\S*#\d+/i;
const REGULAR_FILE_MODE = 0o100644;
const SYMLINK_MODE = 0o120000;
const SHA = /^[0-9a-f]{40}$/;

const lineCount = (text) => text.split("\n").length;
const botCommandsOf = (profile) => Object.values(profile?.botCommands ?? {}).map((c) => String(c).trim().toLowerCase()).filter(Boolean);

/** Why the API edit may not touch `path`, or null. `.github/` is refused whatever the profile lists. */
export function editPathProblem(path, sensitivePaths = []) {
	if (typeof path !== "string" || !path) return "path must be a repository-relative file path";
	if (path.length > API_EDIT_LIMITS.path) return `path is longer than ${API_EDIT_LIMITS.path} characters`;
	if (/[\u0000-\u001f\u007f\\]/.test(path)) return "path must not contain control characters or backslashes";
	if (path.startsWith("/")) return "path must be relative to the repository root";
	const segments = path.split("/");
	if (segments.some((s) => s === "" || s === "." || s === "..")) return 'path must not contain "..", "." or empty segments';
	const lower = path.toLowerCase();
	if (lower === ".github" || lower.startsWith(".github/")) return "paths under .github/ are never edited through the API";
	if (segments[0].toLowerCase() === ".git") return "paths under .git/ are never edited";
	const hit = sensitivePaths.find((g) => matchesGlob(path, g) || matchesGlob(lower, g.toLowerCase()));
	if (hit) return `the path matches the profile's sensitivePaths (${hit})`;
	return null;
}

/** Why `message` cannot be the commit message, or null. It is one conventional commit line. */
export function commitMessageProblem(message, commands = []) {
	if (typeof message !== "string" || !message.trim()) return "params.message is required: the commit message, one conventional commit line";
	if (/[\r\n]/.test(message)) return "params.message must be one line";
	if (message.length > API_EDIT_LIMITS.message) return `params.message is longer than ${API_EDIT_LIMITS.message} characters`;
	if (!MESSAGE_PATTERN.test(message)) return `params.message must be a conventional commit like "docs: fix the Discord invite link", with one of ${COMMIT_TYPES.join(", ")}`;
	if (SKIP_CI.test(message)) return "params.message must not hold a marker that skips CI";
	if (message.includes("@")) return "params.message must not mention anyone";
	if (CLOSING_KEYWORD.test(message)) return "params.message must not hold a closing keyword for an issue";
	const hit = commands.find((c) => message.toLowerCase().includes(c));
	if (hit) return `params.message contains the bot command "${hit}"`;
	return null;
}

/**
 * The problems of a route's API edit params that show without GitHub: shape, paths, sizes and bot commands.
 * An empty list means the params pass. The code that commits runs it again before it reads anything.
 */
export function apiEditProblems(params, profile) {
	const L = API_EDIT_LIMITS;
	if (!isObject(params) || params.via !== API_EDIT_VIA) return [`params.via must be "${API_EDIT_VIA}"`];
	const problems = [];
	for (const key of Object.keys(params)) if (!PARAM_KEYS.includes(key)) problems.push(`unknown param "${key}"`);
	if (params.mode !== undefined && params.mode !== "push") problems.push('an API edit commits to the PR branch, so params.mode is "push" or absent');
	const commands = botCommandsOf(profile);
	const messageProblem = commitMessageProblem(params.message, commands);
	if (messageProblem) problems.push(messageProblem);
	const edits = params.edits;
	if (!Array.isArray(edits) || !edits.length) return [...problems, "params.edits must list at least one edit { path, original, replacement }"];
	if (edits.length > L.edits) problems.push(`params.edits has ${edits.length} edits, at most ${L.edits} are allowed`);
	const seen = new Set();
	let lines = 0;
	edits.forEach((e, i) => {
		const where = `edits[${i}]`;
		if (!isObject(e) || Object.keys(e).some((k) => !EDIT_KEYS.includes(k)) || EDIT_KEYS.some((k) => typeof e[k] !== "string")) {
			return problems.push(`${where} must be { path, original, replacement } with three strings`);
		}
		const pathProblem = editPathProblem(e.path, profile?.sensitivePaths ?? []);
		if (pathProblem) problems.push(`${where}: ${pathProblem}`);
		if (!e.original.trim()) problems.push(`${where}: original must hold the exact lines to replace`);
		if (!e.replacement.trim()) problems.push(`${where}: replacement must not be empty. An API edit replaces text and deletes nothing`);
		if (e.original === e.replacement) problems.push(`${where}: replacement equals original`);
		for (const key of ["original", "replacement"]) {
			if (e[key].length > L.chars) problems.push(`${where}: ${key} is longer than ${L.chars} characters`);
			if (e[key].includes("\u0000")) problems.push(`${where}: ${key} must be text`);
			if (/\r?\n$/.test(e[key])) problems.push(`${where}: ${key} holds whole lines without a line break at the end`);
		}
		for (const key of ["replacement", "path"]) {
			const hit = commands.find((c) => e[key].toLowerCase().includes(c));
			if (hit) problems.push(`${where}: ${key} contains the bot command "${hit}"`);
		}
		const key = `${e.path}\u0000${e.original}`;
		if (seen.has(key)) problems.push(`${where}: the same lines of ${e.path} are edited twice`);
		seen.add(key);
		lines += Math.max(lineCount(e.original), lineCount(e.replacement));
	});
	const files = new Set(edits.filter(isObject).map((e) => e.path));
	if (files.size > L.files) problems.push(`the edits change ${files.size} files, at most ${L.files} are allowed`);
	if (lines > L.lines) problems.push(`the edits change ${lines} lines, at most ${L.lines} are allowed`);
	return problems;
}

/** Thrown for every reason the edit is not committed. The message is shown to the maintainer. */
export class ApiEditRefusal extends Error {}

function occurrences(content, text) {
	const out = [];
	for (let at = content.indexOf(text); at !== -1; at = content.indexOf(text, at + 1)) out.push(at);
	return out;
}

/**
 * Applies the edits of one file to its content and returns the new content. Each `original` must occur exactly once,
 * as whole lines, and no two edits may overlap. Throws an ApiEditRefusal otherwise.
 */
export function applyEdits(path, content, edits) {
	const ranges = edits.map((e) => {
		const found = occurrences(content, e.original);
		if (!found.length) throw new ApiEditRefusal(`The text to replace was not found in ${path} at the PR head.`);
		if (found.length > 1) throw new ApiEditRefusal(`The text to replace occurs ${found.length} times in ${path}. It must occur exactly once.`);
		const start = found[0];
		const end = start + e.original.length;
		const startsLine = start === 0 || content[start - 1] === "\n";
		const endsLine = end === content.length || content[end] === "\n" || content.startsWith("\r\n", end);
		if (!startsLine || !endsLine) throw new ApiEditRefusal(`The text to replace in ${path} must cover whole lines.`);
		return { start, end, replacement: e.replacement };
	}).sort((a, b) => a.start - b.start);
	for (let i = 1; i < ranges.length; i++) {
		if (ranges[i].start < ranges[i - 1].end) throw new ApiEditRefusal(`Two edits of ${path} overlap.`);
	}
	let out = content;
	for (const r of ranges.reverse()) out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
	if (out === content) throw new ApiEditRefusal(`The edits leave ${path} unchanged.`);
	return out;
}

const blobOid = (text) => {
	const body = Buffer.from(text, "utf8");
	return createHash("sha1").update(`blob ${body.length}\u0000`).update(body).digest("hex");
};

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		nameWithOwner
		defaultBranchRef { name }
		pullRequest(number: $number) {
			id url state headRefOid headRefName baseRefName isCrossRepository maintainerCanModify
			headRepository { nameWithOwner }
		}
	}
}`;

const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** Reads the PR and returns its head branch, or throws why nothing may be committed to it. */
async function readTarget(repo, number, reviewedSha) {
	const { owner, name } = repoParts(repo);
	let data;
	try {
		data = await graphql(PR_QUERY, { owner, name, number });
	} catch (e) {
		throw new ApiEditRefusal(`Could not read PR #${number} from GitHub: ${e.message}`);
	}
	const pr = data?.repository?.pullRequest;
	if (!pr) throw new ApiEditRefusal(`PR #${number} was not found.`);
	if (pr.state !== "OPEN") throw new ApiEditRefusal(`PR #${number} is ${pr.state === "MERGED" ? "already merged" : "closed"}.`);
	if (pr.headRefOid !== reviewedSha) throw new ApiEditRefusal(`The PR head moved to ${String(pr.headRefOid).slice(0, 7)} since the review. The edits were written for ${reviewedSha.slice(0, 7)}.`);
	const headRepo = pr.headRepository?.nameWithOwner;
	if (typeof headRepo !== "string" || !headRepo) throw new ApiEditRefusal("The PR's head repository is gone.");
	if (typeof pr.headRefName !== "string" || !pr.headRefName) throw new ApiEditRefusal("The PR names no head branch.");
	const base = data.repository.nameWithOwner ?? repo;
	if (pr.isCrossRepository) {
		if (same(headRepo, base)) throw new ApiEditRefusal("The PR claims to come from a fork, but its head is in the base repository.");
		if (pr.maintainerCanModify !== true) throw new ApiEditRefusal("The contributor did not allow edits by maintainers, so nothing can be committed to the fork's branch.");
	} else {
		if (!same(headRepo, base)) throw new ApiEditRefusal(`The PR's head repository ${headRepo} is not ${base}.`);
		const protectedNames = [data.repository.defaultBranchRef?.name, pr.baseRefName].filter(Boolean);
		if (protectedNames.includes(pr.headRefName)) throw new ApiEditRefusal(`The PR's head branch is ${pr.headRefName}, the branch it merges into. Nothing is committed there.`);
	}
	return { id: pr.id, url: pr.url, headRepo, branch: pr.headRefName };
}

/** Reads the edited files at `sha` through the API. Returns `Map<path, text>`, or throws for a file that cannot be edited as text. */
async function readFiles(repo, sha, paths) {
	const { owner, name } = repoParts(repo);
	const decls = paths.map((_, i) => `$p${i}: String!`).join(", ");
	const fields = paths.map((_, i) => `f${i}: file(path: $p${i}) { mode type object { ... on Blob { oid isBinary isTruncated text } } }`).join("\n");
	const variables = { owner, name, sha };
	paths.forEach((p, i) => (variables[`p${i}`] = p));
	let data;
	try {
		data = await graphql(`query($owner: String!, $name: String!, $sha: GitObjectID!, ${decls}) {
			repository(owner: $owner, name: $name) { object(oid: $sha) { ... on Commit { ${fields} } } }
		}`, variables);
	} catch (e) {
		throw new ApiEditRefusal(`Could not read the files at the PR head: ${e.message}`);
	}
	const commit = data?.repository?.object;
	if (!commit) throw new ApiEditRefusal(`The commit ${sha.slice(0, 7)} was not found.`);
	const out = new Map();
	paths.forEach((path, i) => {
		const entry = commit[`f${i}`];
		if (!entry) throw new ApiEditRefusal(`${path} does not exist at the PR head. An API edit creates no files.`);
		if (entry.mode === SYMLINK_MODE) throw new ApiEditRefusal(`${path} is a symlink.`);
		if (entry.type !== "blob") throw new ApiEditRefusal(`${path} is not a file.`);
		// A file addition of the commit mutation carries no mode. Edit only plain files
		if (entry.mode !== REGULAR_FILE_MODE) throw new ApiEditRefusal(`${path} is not a regular file (mode ${Number(entry.mode).toString(8)}).`);
		const blob = entry.object;
		if (!blob || blob.isBinary || blob.isTruncated || typeof blob.text !== "string") throw new ApiEditRefusal(`${path} is binary or too large to edit as text.`);
		// Compare the blob hash because the commit sends the whole file. Text that differs by one byte would change more than the edits
		if (blobOid(blob.text) !== blob.oid) throw new ApiEditRefusal(`${path} could not be read exactly, so it is not edited.`);
		out.set(path, blob.text);
	});
	return out;
}

const COMMENT_TEMPLATE = "api-edit";
const COMMENT_DEFAULT = "I pushed a small text fix to this PR: {commit}\n\nIt changes {files}.";

/** The profile's `templates/api-edit.md` without its leading HTML comment, or the default. */
async function commentTemplate(profileDir) {
	let text = "";
	try {
		text = (await readFile(join(profileDir, "templates", `${COMMENT_TEMPLATE}.md`), "utf8")).replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, "").trim();
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	return text || COMMENT_DEFAULT;
}

/** The comment that reports the commit: the template with the commit link and the files, then the note for the contributor. */
export function commentText(template, { commitUrl, paths, note }) {
	const files = paths.map((p) => `\`${p}\``).join(", ");
	return [template.replaceAll("{commit}", commitUrl).replaceAll("{files}", files), (note ?? "").trim()].filter(Boolean).join("\n\n");
}

/**
 * Commits a route's API edit to the PR's head branch as one commit, then comments on the PR. Never throws.
 * `reviewedSha` is the head the edits were written for. `text` is the note for the contributor, appended to the comment.
 * Nothing is checked out and no code runs: the files are read through the API at that SHA and changed in memory.
 * Returns `{ ok: true, sha, url, commentUrl, paths, warning? }`, or with `dryRun` `{ ok: true, dryRun, invocations, files }`
 * where `files` holds the old and the new content. A refusal is `{ ok: false, result }`.
 */
export async function runApiEdit({ instance, ...request } = {}) {
	if (instance) return withInstance(instance, () => runApiEdit(request));
	const { repo, number, reviewedSha, params, text = "", dryRun = false } = request;
	try {
		if (isPaused()) return { ok: false, result: PAUSED_MESSAGE, paused: true };
		const settings = loadInstance(instanceName());
		if (!allowedRepo(settings.name, repo)) throw new ApiEditRefusal(`${repo} is not a repository of instance ${settings.name}.`);
		if (!Number.isSafeInteger(number) || number <= 0) throw new ApiEditRefusal("number must be a PR number.");
		if (typeof reviewedSha !== "string" || !SHA.test(reviewedSha)) throw new ApiEditRefusal("An API edit needs the item's reviewedSha as a full 40-character SHA.");
		const problems = apiEditProblems(params, settings.profile);
		if (problems.length) throw new ApiEditRefusal(`The edits break the rules of an API edit: ${problems.join("; ")}.`);
		if (typeof text !== "string" || text.length > API_EDIT_LIMITS.note) throw new ApiEditRefusal(`The note for the contributor has at most ${API_EDIT_LIMITS.note} characters.`);
		const paths = [...new Set(params.edits.map((e) => e.path))];
		const template = await commentTemplate(settings.profileDir);
		const comment = (commitUrl) => commentText(template, { commitUrl, paths, note: text });
		const command = botCommandsOf(settings.profile).find((c) => comment("").toLowerCase().includes(c));
		if (command) throw new ApiEditRefusal(`The comment would contain the bot command "${command}". Post bot commands on GitHub yourself.`);
		assertWriteAllowed();

		const target = await readTarget(repo, number, reviewedSha);
		const contents = await readFiles(repo, reviewedSha, paths);
		const changed = paths.map((path) => ({ path, before: contents.get(path), after: applyEdits(path, contents.get(path), params.edits.filter((e) => e.path === path)) }));

		// One mutation creates the commit and moves the branch. GitHub refuses it when the branch left the reviewed head
		const mutation = {
			query: "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }",
			variables: {
				input: {
					branch: { repositoryNameWithOwner: target.headRepo, branchName: target.branch },
					expectedHeadOid: reviewedSha,
					message: { headline: params.message },
					fileChanges: { additions: changed.map((f) => ({ path: f.path, contents: Buffer.from(f.after, "utf8").toString("base64") })) },
				},
			},
		};
		if (dryRun) {
			const posted = await runAction({ action: "comment", kind: "pr", number, repo, text: comment(`${target.url}/commits/<sha>`), dryRun: true });
			if (!posted.ok) throw new ApiEditRefusal(posted.result);
			return { ok: true, dryRun: true, paths, files: changed, invocations: [{ command: ["gh", ...GRAPHQL_ARGS], as: writeLogin(), stdin: mutation }, ...posted.result.invocations] };
		}
		let commit;
		try {
			commit = (await graphql(mutation.query, mutation.variables))?.createCommitOnBranch?.commit;
		} catch (e) {
			throw new ApiEditRefusal(`GitHub refused the commit: ${e.message}`);
		}
		if (!commit?.oid) throw new ApiEditRefusal("GitHub returned no commit.");
		const url = `${target.url}/commits/${commit.oid}`;
		const posted = await runAction({ action: "comment", kind: "pr", number, repo, text: comment(url) });
		return { ok: true, sha: commit.oid, url, paths, commentUrl: posted.ok ? posted.result : null, ...(!posted.ok && { warning: `Committed. The comment could not be posted: ${posted.result}` }) };
	} catch (e) {
		if (e instanceof ApiEditRefusal) return { ok: false, result: `${e.message} Nothing was committed.` };
		return { ok: false, result: `${e?.message ?? String(e)} Nothing was committed.` };
	}
}
