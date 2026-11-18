import { readFileSync } from "node:fs";
import { commentNode } from "./actions.mjs";
import { allowedRepo, botLogins, instanceName, loadProfile, repoParts, withInstance } from "./config.mjs";
import { graphql } from "./gh.mjs";

/** Actions that post text, merge, review, close, reopen or transfer. They run only on a thread that has not moved since the review. */
export const GUARDED_ACTIONS = new Set(["comment", "review", "merge", "close", "reopen", "transfer"]);

// A moved head blocks these even with force, because they act on the exact code that was reviewed
function headBound(action, params) {
	if (action === "merge") return true;
	if (action !== "review") return false;
	return params?.event === "approve" || (Array.isArray(params?.comments) && params.comments.length > 0);
}
const LAST = 20;

const AUTHOR = "author { login __typename }";

function isHuman(author) {
	return !!author && author.__typename === "User" && !botLogins().includes(author.login.toLowerCase()) && !author.login.endsWith("[bot]");
}

function ago(iso) {
	const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
	if (s < 90) return "just now";
	if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
	if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
	return `${Math.round(s / 86400)} days ago`;
}

function readStub() {
	const file = process.env.GARY_GUARD_STUB;
	return file ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/**
 * Reads what the guard needs about one thread: state, the last comments, and for PRs the head and the latest reviews.
 * `GARY_GUARD_STUB` names a JSON file that replaces this read in tests. Keys are a ref like "acme/widgets#12", the legacy "pr-12", or "*".
 */
export async function readThread(kind, number, repo = loadProfile().repo) {
	const stub = readStub();
	if (stub) {
		const thread = stub[`${repo}#${number}`] ?? stub[`${kind === "discussion" ? "disc" : kind}-${number}`] ?? stub["*"];
		if (thread) return { state: "OPEN", stateReason: null, comments: [], reviews: [], headSha: null, ...thread };
	}
	const { owner, name } = repoParts(repo);
	if (kind === "pr") {
		const { repository } = await graphql(
			`query($owner: String!, $name: String!, $number: Int!) {
				repository(owner: $owner, name: $name) {
					pullRequest(number: $number) {
						state headRefOid
						comments(last: ${LAST}) { nodes { ${AUTHOR} createdAt } }
						reviews(last: ${LAST}) { nodes { ${AUTHOR} submittedAt } }
					}
				}
			}`,
			{ owner, name, number },
		);
		const pr = repository?.pullRequest;
		if (!pr) throw new Error(`PR #${number} not found`);
		return {
			state: pr.state,
			headSha: pr.headRefOid,
			comments: pr.comments.nodes.map((c) => ({ author: c.author, at: c.createdAt })),
			reviews: pr.reviews.nodes.filter((r) => r.submittedAt).map((r) => ({ author: r.author, at: r.submittedAt })),
		};
	}
	if (kind === "issue") {
		const { repository } = await graphql(
			`query($owner: String!, $name: String!, $number: Int!) {
				repository(owner: $owner, name: $name) {
					issue(number: $number) { state stateReason comments(last: ${LAST}) { nodes { ${AUTHOR} createdAt } } }
				}
			}`,
			{ owner, name, number },
		);
		const issue = repository?.issue;
		if (!issue) throw new Error(`Issue #${number} not found`);
		return {
			state: issue.state,
			stateReason: issue.stateReason,
			comments: issue.comments.nodes.map((c) => ({ author: c.author, at: c.createdAt })),
			reviews: [],
			headSha: null,
		};
	}
	const { repository } = await graphql(
		`query($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) {
				discussion(number: $number) {
					closed
					comments(last: ${LAST}) { nodes { ${AUTHOR} createdAt replies(last: ${LAST}) { nodes { ${AUTHOR} createdAt } } } }
				}
			}
		}`,
		{ owner, name, number },
	);
	const d = repository?.discussion;
	if (!d) throw new Error(`Discussion #${number} not found`);
	const comments = d.comments.nodes.flatMap((c) => [
		{ author: c.author, at: c.createdAt },
		...c.replies.nodes.map((r) => ({ author: r.author, at: r.createdAt })),
	]);
	return { state: d.closed ? "CLOSED" : "OPEN", comments, reviews: [], headSha: null };
}

async function commentExists(commentId) {
	const stub = readStub();
	if (stub?.nodes && Object.hasOwn(stub.nodes, commentId)) return stub.nodes[commentId] !== false;
	return (await commentNode(commentId)) !== null;
}

/**
 * Checks that a thread has not moved since the agent reviewed it. For `react` it checks only that the thread and the comment exist.
 * Returns `{ ok: true, state, stateReason }`, or `{ ok: false, reason, forceable, state, stateReason }`.
 * `force` skips every refusal except a moved head for merge, an approval or a review with inline comments. Never throws: a failed read refuses without force.
 */
export async function checkFresh({ instance, ...request }) {
	if (instance) return withInstance(instance, () => checkFresh(request));
	const { action, kind, number, item, params, force = false, openOnly = false } = request;
	if (!GUARDED_ACTIONS.has(action) && action !== "react" && !openOnly) return { ok: true };
	const repo = item?.repo ?? loadProfile().repo;
	if (!allowedRepo(instanceName(), repo)) return { ok: false, reason: `${repo} is not a repository of instance ${instanceName()}`, forceable: false };
	let thread;
	try {
		thread = await readThread(kind, number, repo);
	} catch (e) {
		return { ok: false, reason: `Could not check the thread on GitHub: ${e.message}`, forceable: false };
	}
	const live = { state: thread.state, stateReason: thread.stateReason ?? null };
	// With openOnly, newer comments and a moved head are fine. Only a closed or merged thread is refused
	if (openOnly) return thread.state === "OPEN" ? { ok: true, ...live } : { ok: false, reason: `#${number} is ${thread.state === "MERGED" ? "already merged" : "closed"}.`, forceable: false, ...live };
	if (action === "react") {
		const commentId = params?.commentId;
		if (typeof commentId === "string") {
			let exists;
			try {
				exists = await commentExists(commentId);
			} catch (e) {
				return { ok: false, reason: `Could not check the comment on GitHub: ${e.message}`, forceable: false, ...live };
			}
			if (!exists) return { ok: false, reason: "The comment no longer exists.", forceable: false, ...live };
		}
		return { ok: true, ...live };
	}
	const reviewedAt = Date.parse(item?.reviewedAt ?? "");
	const reasons = [];
	let headMoved = false;

	if (thread.state === "MERGED") reasons.push(`#${number} is already merged.`);
	else if (action === "reopen") {
		if (thread.state === "OPEN") reasons.push(`#${number} is already open.`);
	} else if (thread.state !== "OPEN") reasons.push(`#${number} is closed.`);

	if (Number.isFinite(reviewedAt)) {
		const comment = thread.comments.filter((c) => isHuman(c.author) && Date.parse(c.at) > reviewedAt).at(-1);
		if (comment) reasons.push(`${comment.author.login} commented ${ago(comment.at)}. Re-check before posting.`);
		const review = thread.reviews.filter((r) => isHuman(r.author) && Date.parse(r.at) > reviewedAt).at(-1);
		if (review) reasons.push(`${review.author.login} reviewed ${ago(review.at)}. Re-check before posting.`);
	}
	if (kind === "pr" && item?.reviewedSha && thread.headSha && thread.headSha !== item.reviewedSha) {
		headMoved = true;
		reasons.push(`The PR head moved to ${thread.headSha.slice(0, 7)} since the review.`);
	}

	if (!reasons.length) return { ok: true, ...live };
	const forceable = !(headMoved && headBound(action, params));
	if (force && forceable) return { ok: true, forced: true, ...live };
	return { ok: false, reason: reasons.join(" "), forceable, ...live };
}
