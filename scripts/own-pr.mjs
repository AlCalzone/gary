// gary own-pr: the working copy of the maintainer's own PR in a contributions instance and the one push to its branch.
// See "Your own PRs" in SPEC.md. Every subcommand prints one JSON object.
//   gary own-pr check <itemId> [--sha <head>]
//     Says from GitHub's state now whether an agent may push to the PR. Exit 3 when refused. Read-only.
//   gary own-pr locate <itemId>
//     The clone the work would use and the worktree that has the PR's branch checked out. Changes nothing.
//   gary own-pr workdir <itemId> (--request <action id> | --focus-session <id>) [--sha <head>]
//     The request is a Drive or a Focus request. Adds a new detached worktree of the PR's head under the state directory. Exit 3 when refused.
//   gary own-pr push <itemId> --worktree <dir> --sha <head it started from> (--request <action id> | --focus-session <id>) [--dry-run]
//     Pushes the new commits of the worktree to the PR's head branch, never with force. Exit 3 when refused, 4 while paused.
//     With local reviewers on the instance, the HEAD of a Drive job needs a finished local review that starts from --sha.
//   gary own-pr cleanup <itemId> --worktree <dir>
//     Removes one of Gary's worktrees and its ref.
import { join } from "node:path";
import { boardDir, readJson } from "./lib/board-store.mjs";
import { allowedRepo, instanceName, loadInstance, loadProfile, repoParts, stateDir } from "./lib/config.mjs";
import { localReviewOf, pushAllowed, readRecord } from "./lib/local-review.mjs";
import { PAUSED_MESSAGE, isPaused } from "./lib/control.mjs";
import { readSnapshotItems } from "./lib/fixes.mjs";
import { focusHold } from "./lib/focus.mjs";
import { graphql, verifyOwnLogin } from "./lib/gh.mjs";
import { OWN_PR_QUERY, cloneOf, descendsFrom, headOf, headRefFor, isInside, locate, ownPrFacts, ownPrRefusal, prepareWorktree, pushArgs, removeWorktree, runGit, worktreesDir } from "./lib/own-pr.mjs";

const USAGE = "Usage: gary own-pr check <itemId> [--sha <head>] | locate <itemId> | workdir <itemId> (--request <id> | --focus-session <id>) [--sha <head>] | push <itemId> --worktree <dir> --sha <head> (--request <id> | --focus-session <id>) [--dry-run] | cleanup <itemId> --worktree <dir>";
const VALUES = ["--sha", "--request", "--focus-session", "--worktree"];
const SHA = /^[0-9a-f]{40}$/;

class Refused extends Error {}
class Paused extends Error {}

function parse(argv) {
	const out = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (VALUES.includes(argv[i])) {
			if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
			out[argv[i].slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
		} else if (argv[i] === "--dry-run") out.dryRun = true;
		else if (argv[i].startsWith("--")) throw new Error(USAGE);
		else rest.push(argv[i]);
	}
	if (rest.length !== 1) throw new Error(USAGE);
	if (out.sha !== undefined && !SHA.test(out.sha)) throw new Error("--sha must be a full 40-character SHA");
	return { out, itemId: rest[0] };
}

/** The board item and the instance, or a refusal for an item that is no PR of this contributions instance. */
async function target(itemId) {
	const instance = loadInstance(instanceName());
	if (instance.kind !== "contributions") throw new Refused(`gary own-pr is for a contributions instance. ${instance.name} is a maintainer instance: use push-check and the push skills there.`);
	const item = await readJson(join(boardDir(), "items", itemId + ".json"));
	if (!item) throw new Refused(`${itemId} has no item on the board.`);
	if (item.kind !== "pr" || !Number.isSafeInteger(item.number) || !allowedRepo(instance.name, item.repo)) throw new Refused(`${itemId} is no PR of this instance.`);
	return { instance, item, me: instance.config.me };
}

/** Reads the PR from GitHub now and returns its live facts, or throws a Refused with the reason no agent may push. */
async function liveCheck(item, me, sha) {
	const { owner, name } = repoParts(item.repo);
	const node = (await graphql(OWN_PR_QUERY, { owner, name, number: item.number })).repository?.pullRequest;
	if (!node) throw new Refused(`PR #${item.number} could not be read from ${item.repo}.`);
	const ownPr = ownPrFacts(node, { me, ai: { logins: [], names: loadProfile().aiAuthors ?? [] } });
	const live = { author: node.author?.login ?? "ghost", githubState: String(node.state).toLowerCase(), ownPr };
	const refusal = ownPrRefusal({ ...item, author: live.author }, live, me);
	if (refusal) throw new Refused(refusal);
	if (sha && node.headRefOid !== sha) throw new Refused(`The head of PR #${item.number} is ${node.headRefOid}, not ${sha}. Someone pushed to it.`);
	return { headSha: node.headRefOid, headRepo: ownPr.headRepo, headRef: ownPr.headRef, baseRepo: node.baseRepository?.nameWithOwner ?? item.repo };
}

/**
 * Refuses unless the caller is the job of a click on Drive for this item, or the focus session that holds it.
 * `actions` are the request kinds that count. A worktree may also be made for a queued Focus request.
 */
async function assertMandate(itemId, { request, focusSession }, actions = ["drive"]) {
	const focus = focusHold(itemId);
	if (focusSession !== undefined) {
		if (!focus || focus.session?.id !== focusSession) throw new Refused(`${itemId} is not in focus with session ${focusSession}.`);
		return;
	}
	if (request === undefined) throw new Error("Name the click with --request <action id>, or the focus session with --focus-session <id>.");
	if (focus) throw new Refused(`${itemId} is in focus. Only the focus session may push to it.`);
	if (!/^[\w.-]+$/.test(request)) throw new Refused("--request names no action doc.");
	const doc = await readJson(join(boardDir(), "actions", request + ".json"));
	if (!doc || doc.itemId !== itemId || !actions.includes(doc.action)) throw new Refused(`${request} is no ${actions.join(" or ")} request for ${itemId}.`);
	if (doc.status === "done" || doc.status === "failed") throw new Refused(`The request ${request} is ${doc.status} already.`);
}

const roots = (instance) => instance.config.checkoutRoots ?? [];

async function check(itemId, out) {
	const { item, me } = await target(itemId);
	const live = await liveCheck(item, me, out.sha);
	return { ok: true, itemId, repo: item.repo, number: item.number, ...live };
}

async function locateCmd(itemId) {
	const { instance, item, me } = await target(itemId);
	const entry = (await readSnapshotItems())[itemId];
	const own = entry?.ownPr ?? {};
	const found = await locate({ stateDir: stateDir(), roots: roots(instance), baseRepo: item.repo, headRepo: own.headRepo, headRef: own.headRef });
	return { ok: true, itemId, repo: item.repo, number: item.number, headRepo: own.headRepo ?? null, headRef: own.headRef ?? null, refused: ownPrRefusal(item, entry, me), clone: found.clone.path, fresh: found.clone.fresh, branchWorktree: found.branchWorktree };
}

async function workdir(itemId, out) {
	const { instance, item, me } = await target(itemId);
	await assertMandate(itemId, out, ["drive", "focus"]);
	const live = await liveCheck(item, me, out.sha);
	try {
		const made = await prepareWorktree({ instance: instance.name, itemId, stateDir: stateDir(), roots: roots(instance), baseRepo: live.baseRepo, headRepo: live.headRepo, headRef: live.headRef, number: item.number, sha: live.headSha });
		return { ok: true, itemId, repo: item.repo, number: item.number, headRepo: live.headRepo, headRef: live.headRef, ...made };
	} catch (e) {
		if (e.refused) throw new Refused(e.message);
		throw e;
	}
}

async function push(itemId, out) {
	const { instance, item, me } = await target(itemId);
	if (!out.worktree || !out.sha) throw new Error(USAGE);
	if (!isInside(out.worktree, worktreesDir(stateDir()))) throw new Refused(`${out.worktree} is not one of Gary's worktrees. Gary pushes only from a worktree that gary own-pr workdir made.`);
	await assertMandate(itemId, out);
	if (isPaused(stateDir())) throw new Paused(PAUSED_MESSAGE);
	const head = await headOf(out.worktree);
	if (head === out.sha) throw new Refused("The worktree has no new commit. Nothing was pushed.");
	if (!(await descendsFrom(out.worktree, out.sha))) throw new Refused(`The worktree's HEAD ${head} does not build on ${out.sha}. Gary never force-pushes.`);
	const live = await liveCheck(item, me, out.sha);
	// A focus session pushes what the maintainer told it to push, so the maintainer is its reviewer
	if (out.focusSession === undefined) {
		const local = pushAllowed(localReviewOf(instance.config, instance.profile), await readRecord(stateDir(), itemId), { head, base: out.sha });
		if (!local.ok) throw new Refused(local.reason);
	}
	const args = pushArgs(out.worktree, live.headRepo, live.headRef);
	const url = `https://github.com/${item.repo}/pull/${item.number}/commits/${head}`;
	if (out.dryRun || process.env.GARY_DRY_RUN === "1") return { ok: true, dryRun: true, itemId, invocation: { command: ["git", ...args] }, sha: head, url };
	await verifyOwnLogin();
	try {
		await runGit(args);
	} catch (e) {
		throw new Refused(`git refused the push: ${String(e.stderr || e.message).trim().slice(-500)}`);
	}
	return { ok: true, itemId, pushed: head, url, headRepo: live.headRepo, headRef: live.headRef };
}

async function cleanup(itemId, out) {
	const { instance } = await target(itemId);
	if (!out.worktree) throw new Error(USAGE);
	if (!isInside(out.worktree, worktreesDir(stateDir()))) throw new Refused(`${out.worktree} is not one of Gary's worktrees. Gary removes nothing else.`);
	const clone = await cloneOf(out.worktree);
	await removeWorktree({ clone, worktree: out.worktree, stateDir: stateDir(), ref: headRefFor(instance.name, itemId) });
	return { ok: true, itemId, removed: out.worktree };
}

export async function main(argv) {
	const [command, ...args] = argv;
	let outcome;
	let code = 0;
	try {
		const { out, itemId } = parse(args);
		if (command === "check") outcome = await check(itemId, out);
		else if (command === "locate") outcome = await locateCmd(itemId);
		else if (command === "workdir") outcome = await workdir(itemId, out);
		else if (command === "push") outcome = await push(itemId, out);
		else if (command === "cleanup") outcome = await cleanup(itemId, out);
		else throw new Error(USAGE);
	} catch (e) {
		code = e instanceof Refused ? 3 : e instanceof Paused ? 4 : 1;
		outcome = { ok: false, ...(e instanceof Refused && { refused: e.message }), ...(e instanceof Paused && { paused: true }), result: e.message };
	}
	console.log(JSON.stringify(outcome));
	process.exitCode = code;
}
