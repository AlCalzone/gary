// The maintainer's own PRs in a contributions instance: the facts that decide whether an agent may push to one,
// and the working copy it pushes from. See "Your own PRs" in SPEC.md.
// Nothing here checks out, edits, commits or stashes in a clone the maintainer owns. A found clone gets only a fetch
// into a ref of Gary's own and a new worktree under the instance's state directory.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { expandHome } from "./config.mjs";
import { foreignCommit } from "./facts.mjs";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10 * 60000;
const MAX_COMMITS = 100;
// The repo permissions that let a login push to a branch
const CAN_PUSH = new Set(["ADMIN", "MAINTAIN", "WRITE"]);
// `NO_HOOKS` keeps every git hook of a clone from running in Gary's git calls
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
// `GH_CREDENTIALS` makes git authenticate to GitHub with the maintainer's stored gh login
const GH_CREDENTIALS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

/** The fields of one PR that decide whether the maintainer's login may push to it. The query name lets tests answer it. */
export const OWN_PR_QUERY = `query ContributionsOwnPr($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			number state headRefName headRefOid isCrossRepository
			author { login }
			baseRepository { nameWithOwner }
			headRepository { nameWithOwner owner { login } viewerPermission }
			allCommits: commits(first: ${MAX_COMMITS}) { totalCount nodes { commit { oid message signature { isValid wasSignedByGitHub } author { name email user { login } } committer { name email user { login } } } } }
		}
	}
}`;

const low = (v) => String(v ?? "").toLowerCase();

/**
 * The facts of the maintainer's own PR from an `OWN_PR_QUERY` node: `{ headRepo, headRef, pushable, notPushable?, foreign }`.
 * `pushable` is true when the head repo still exists and the login owns it or may write to it. `foreign` names the
 * first commit that someone other than `me` authored, committed or co-authored, or is null. AI agents may co-author.
 */
export function ownPrFacts(node, { me, ai } = {}) {
	const head = node.headRepository;
	const facts = { headRepo: head?.nameWithOwner ?? null, headRef: node.headRefName ?? null };
	if (!head || !facts.headRef) facts.notPushable = "the PR's head branch or its repository no longer exists";
	else if (low(head.owner?.login) !== low(me) && !CAN_PUSH.has(head.viewerPermission)) facts.notPushable = `your login cannot push to ${head.nameWithOwner}`;
	facts.pushable = !facts.notPushable;
	facts.foreign = foreignCommit(node, (login) => !!login && low(login) === low(me), ai);
	return facts;
}

/**
 * Why no agent may push to this PR of the maintainer's, or null when one may. `item` is the board item, `entry` its entry
 * in the committed snapshot, `me` the instance's login. Every fact comes from the snapshot, never from the model.
 */
export function ownPrRefusal(item, entry, me) {
	if (item?.kind !== "pr") return "Only a PR can get Drive or Focus.";
	if (!entry) return "Gary has no snapshot of this PR yet. The next run reads it.";
	if (low(item.author) !== low(me) || low(entry.author) !== low(me)) return "This is not your PR. Gary pushes only to PRs you opened.";
	if (entry.githubState && entry.githubState !== "open") return `PR #${item.number} is ${entry.githubState}.`;
	const own = entry.ownPr;
	if (!own) return "The snapshot has no facts about the PR's branch yet. The next run reads them.";
	if (!own.pushable) return `Gary cannot push to this PR: ${own.notPushable ?? "the branch is not pushable"}.`;
	if (own.foreign) return `Someone else has commits on the PR's branch (${own.foreign}). Gary runs no agent on code it did not see you write.`;
	return null;
}

/** The `owner/name` of a GitHub remote URL, in lower case, or null for another host. */
export function githubRepoOf(url) {
	const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(url ?? "").trim());
	return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

async function git(args, opts = {}) {
	const { stdout } = await execFileAsync("git", args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, ...opts });
	return stdout;
}

/** The GitHub repos the remotes of `dir` point to, in lower case. Reads only the git config. */
async function remotesOf(dir) {
	try {
		const out = await git(["-C", dir, "config", "--get-regexp", "^remote\\..*\\.url$"]);
		return out.split("\n").map((l) => githubRepoOf(l.split(" ").slice(1).join(" "))).filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * The first clone of one of `repos` among the direct child directories of `roots`, as `{ path, repo }`, or null.
 * A clone counts when one of its git remotes points to the repo on GitHub. `repos` are in the order of preference.
 */
export async function findClone(roots, repos) {
	const wanted = repos.filter(Boolean).map(low);
	const found = [];
	for (const root of roots) {
		const dir = resolve(expandHome(root));
		let names = [];
		try {
			names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name);
		} catch {
			continue;
		}
		for (const name of names.sort()) {
			const path = join(dir, name);
			try {
				if (!statSync(path).isDirectory() || !existsSync(join(path, ".git"))) continue;
			} catch {
				continue;
			}
			for (const repo of await remotesOf(path)) if (wanted.includes(repo)) found.push({ path, repo });
		}
	}
	found.sort((a, b) => wanted.indexOf(a.repo) - wanted.indexOf(b.repo));
	return found[0] ?? null;
}

/** The worktrees of a clone, the main one first, as `[{ path, branch }]`. `branch` is the short name, or null when detached. */
export async function worktreesOf(clone) {
	const out = await git(["-C", clone, "worktree", "list", "--porcelain"]);
	const list = [];
	for (const block of out.split("\n\n")) {
		const path = /^worktree (.+)$/m.exec(block)?.[1];
		if (!path) continue;
		const ref = /^branch (.+)$/m.exec(block)?.[1] ?? null;
		list.push({ path, branch: ref ? ref.replace(/^refs\/heads\//, "") : null });
	}
	return list;
}

const ownDir = (stateDir, ...parts) => join(stateDir, "own-pr", ...parts);
export const worktreesDir = (stateDir) => ownDir(stateDir, "worktrees");
const freshClonesDir = (stateDir) => ownDir(stateDir, "clones");
const safeName = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");

/** Whether `path` lies inside `dir`. */
export function isInside(path, dir) {
	const rel = relative(resolve(dir), resolve(path));
	return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Where the work on the PR can happen, without changing anything: the clone to use as `{ path, repo, fresh }`, and the
 * worktree of that clone that has the PR's head branch checked out, or null. Without a clone in `roots` the clone is
 * Gary's fresh clone under the state directory, which may not exist yet.
 */
export async function locate({ stateDir, roots, baseRepo, headRepo, headRef }) {
	const found = await findClone(roots, [headRepo, baseRepo]);
	const clone = found ? { path: found.path, repo: found.repo, fresh: false } : { path: join(freshClonesDir(stateDir), safeName(baseRepo)), repo: low(baseRepo), fresh: true };
	let branchWorktree = null;
	if (existsSync(join(clone.path, ".git")) || existsSync(join(clone.path, "HEAD"))) {
		try {
			branchWorktree = (await worktreesOf(clone.path)).find((w) => headRef && w.branch === headRef)?.path ?? null;
		} catch {
			branchWorktree = null;
		}
	}
	return { clone, branchWorktree };
}

/** The ref in the clone that holds the fetched PR head for one worktree. */
export const headRefFor = (instance, itemId) => `refs/gary/${safeName(instance)}/${safeName(itemId)}`;

/**
 * Creates a new detached worktree of the PR's head under the state directory and returns
 * `{ clone, fresh, worktree, ref, headSha }`. It clones the base repo fresh when `roots` hold no clone, fetches the PR
 * head into a ref of Gary's own and refuses when that head is not `sha`. It never touches a working tree of the clone.
 */
export async function prepareWorktree({ instance, itemId, stateDir, roots, baseRepo, headRepo, headRef, number, sha }) {
	const { clone } = await locate({ stateDir, roots, baseRepo, headRepo, headRef });
	const url = `https://github.com/${baseRepo}.git`;
	if (clone.fresh && !existsSync(join(clone.path, ".git"))) {
		mkdirSync(freshClonesDir(stateDir), { recursive: true });
		await git([...NO_HOOKS, ...GH_CREDENTIALS, "clone", "--no-checkout", url, clone.path]);
	}
	const ref = headRefFor(instance, itemId);
	await git(["-C", clone.path, ...NO_HOOKS, ...GH_CREDENTIALS, "fetch", "--no-tags", url, `+refs/pull/${number}/head:${ref}`]);
	const fetched = (await git(["-C", clone.path, "rev-parse", ref])).trim();
	if (sha && fetched !== sha) {
		await git(["-C", clone.path, "update-ref", "-d", ref]).catch(() => {});
		throw Object.assign(new Error(`The head of PR #${number} is ${fetched}, not ${sha}. Someone pushed to it.`), { refused: true });
	}
	const worktree = join(worktreesDir(stateDir), safeName(itemId));
	if (existsSync(worktree)) await removeWorktree({ clone: clone.path, worktree, stateDir });
	mkdirSync(worktreesDir(stateDir), { recursive: true });
	await git(["-C", clone.path, ...NO_HOOKS, "worktree", "add", "--detach", worktree, ref]);
	return { clone: clone.path, fresh: clone.fresh, worktree, ref, headSha: fetched };
}

/** Removes one of Gary's worktrees. It refuses every path outside the state directory's worktree folder. */
export async function removeWorktree({ clone, worktree, stateDir, ref = null }) {
	if (!isInside(worktree, worktreesDir(stateDir))) throw new Error(`${worktree} is not one of Gary's worktrees. Gary removes nothing else.`);
	try {
		await git(["-C", clone, "worktree", "remove", "--force", worktree]);
	} catch {
		await rm(worktree, { recursive: true, force: true });
		await git(["-C", clone, "worktree", "prune"]).catch(() => {});
	}
	if (ref) await git(["-C", clone, "update-ref", "-d", ref]).catch(() => {});
}

/** The commit HEAD of a worktree points to. */
export async function headOf(worktree) {
	return (await git(["-C", worktree, "rev-parse", "HEAD"])).trim();
}

/** The clone a worktree belongs to: the directory that holds its common git directory. */
export async function cloneOf(worktree) {
	const common = (await git(["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
	return common.endsWith("/.git") ? common.slice(0, -5) : common;
}

/** Whether `ancestor` is an ancestor of HEAD in `worktree`, so a push of HEAD needs no force. */
export async function descendsFrom(worktree, ancestor) {
	try {
		await git(["-C", worktree, "merge-base", "--is-ancestor", ancestor, "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

/** The git command that pushes HEAD of `worktree` to `headRef` of `headRepo`, as an argument list. It never forces. */
export function pushArgs(worktree, headRepo, headRef) {
	return ["-C", worktree, ...NO_HOOKS, ...GH_CREDENTIALS, "push", "--no-verify", `https://github.com/${headRepo}.git`, `HEAD:refs/heads/${headRef}`];
}

/** Runs `git` with these arguments. */
export const runGit = (args) => git(args);
