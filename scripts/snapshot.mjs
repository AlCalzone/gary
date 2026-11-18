// gary snapshot           print the work list, stage the snapshot in <state>/snapshot.pending.json
// gary snapshot --commit  promote the staged snapshot to the baseline <state>/snapshot.json
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { pathToFileURL } from "node:url";
import { botLogins, loadConfig, loadProfile, maintainerLogins, repoParts, stateDir } from "./lib/config.mjs";
import { graphql } from "./lib/gh.mjs";

const BASELINE = () => join(stateDir(), "snapshot.json");
const PENDING = () => join(stateDir(), "snapshot.pending.json");
const MAX_TEXT = 1500;
const MAX_FILES = 50;
const MAX_THREAD_TEXT = 600;
const MAX_OPEN_THREADS = 20;
const THREAD_PAGE = 100;
// GitHub's Copilot coding agent, the same account on every repository
const COPILOT = ["copilot-swe-agent", "copilot"];

const COMMENT_FIELDS = `
	totalCount
	nodes { id author { login __typename } authorAssociation createdAt body }
`;

const THREAD_FIELDS = `
	totalCount
	pageInfo { hasPreviousPage startCursor }
	nodes {
		id isResolved isOutdated path line originalLine
		comments(first: 1) { nodes { author { login __typename } createdAt url body } }
	}
`;

const REVIEW_STATE_FIELDS = `
	pageInfo { hasNextPage endCursor }
	nodes { author { login __typename } state submittedAt url }
`;

const PR_QUERY = `query($owner: String!, $name: String!, $after: String) {
	repository(owner: $owner, name: $name) {
		pullRequests(states: OPEN, first: 25, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
			pageInfo { hasNextPage endCursor }
			nodes {
				number title url body createdAt updatedAt isDraft
				author { login __typename } authorAssociation
				labels(first: 30) { nodes { name } }
				assignees(first: 10) { nodes { login } }
				headRefOid baseRefName reviewDecision mergeable
				additions deletions
				commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
				files(first: ${MAX_FILES}) { totalCount nodes { path } }
				comments(last: 5) { ${COMMENT_FIELDS} }
				reviews(last: 10) { nodes { author { login __typename } state submittedAt url body } }
				allReviews: reviews(first: 100) { ${REVIEW_STATE_FIELDS} }
				reviewRequests(first: 20) {
					nodes {
						requestedReviewer {
							__typename
							... on User { login }
							... on Bot { login }
							... on Mannequin { login }
							... on Team { slug }
						}
					}
				}
				reviewThreads(last: ${THREAD_PAGE}) { ${THREAD_FIELDS} }
			}
		}
	}
}`;

const MORE_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $before: String) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			reviewThreads(last: ${THREAD_PAGE}, before: $before) { ${THREAD_FIELDS} }
		}
	}
}`;

const MORE_REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			reviews(first: 100, after: $after) { ${REVIEW_STATE_FIELDS} }
		}
	}
}`;

const ISSUE_QUERY = `query($owner: String!, $name: String!, $after: String) {
	repository(owner: $owner, name: $name) {
		issues(states: OPEN, first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
			totalCount
			pageInfo { hasNextPage endCursor }
			nodes {
				number title url body createdAt updatedAt
				author { login __typename } authorAssociation
				labels(first: 30) { nodes { name } }
				assignees(first: 10) { nodes { login } }
				comments(last: 5) { ${COMMENT_FIELDS} }
			}
		}
	}
}`;

const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $after: String) {
	repository(owner: $owner, name: $name) {
		discussions(states: OPEN, first: 30, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
			totalCount
			pageInfo { hasNextPage endCursor }
			nodes {
				number title url body createdAt updatedAt
				author { login __typename } authorAssociation
				labels(first: 30) { nodes { name } }
				category { name isAnswerable }
				isAnswered
				comments(last: 5) {
					totalCount
					nodes {
						id author { login __typename } authorAssociation createdAt body
						replies(last: 2) { totalCount nodes { id author { login __typename } authorAssociation createdAt body } }
					}
				}
			}
		}
	}
}`;

export async function main(argv = []) {
	if (argv.includes("--commit")) return commit();

	const config = loadConfig();
	const cutoff = Date.now() - config.activeWindowDays * 24 * 60 * 60 * 1000;
	const classify = authorClassifier(maintainerLogins(), botLogins());
	const sensitive = loadProfile().sensitivePaths;

	const [prs, issues, discussions] = await Promise.all([
		fetchAll(PR_QUERY, "pullRequests"),
		fetchAll(ISSUE_QUERY, "issues", cutoff),
		fetchAll(DISCUSSION_QUERY, "discussions", cutoff),
	]);

	// Drafts are ignored entirely. A draft that becomes ready shows up as a new item
	const readyPrs = prs.nodes.filter((n) => !n.isDraft);
	await Promise.all(
		readyPrs.flatMap((pr) => [fetchRemainingThreads(pr), fetchRemainingReviews(pr)]),
	);

	const items = [
		...readyPrs.map((n) => toPr(n, classify, sensitive)),
		...issues.nodes.map((n) => toIssue(n, classify)),
		...discussions.nodes.map((n) => toDiscussion(n, classify)),
	];

	const baseline = readJson(BASELINE())?.items ?? {};
	const current = {};
	const changed = [];
	const unchanged = [];
	for (const item of items) {
		const entry = baselineEntry(item);
		current[item.id] = entry;
		const old = baseline[item.id];
		let reason;
		if (!old) reason = "new";
		else if (item.headSha && old.headSha !== item.headSha) reason = "head_changed";
		else if (
			old.updatedAt !== entry.updatedAt ||
			(old.lastReviewAt ?? null) !== entry.lastReviewAt ||
			(old.openThreadCount ?? 0) !== entry.openThreadCount
		) {
			reason = "updated";
		}

		if (reason) changed.push({ id: item.id, reason, ...item });
		else unchanged.push(item.id);
	}
	// `closed` also lists open issues and discussions that dropped out of the active window
	const closed = Object.keys(baseline).filter((id) => !current[id]);

	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(
		PENDING(),
		JSON.stringify({ fetchedAt: new Date().toISOString(), items: current }, null, "\t") + "\n",
	);

	const output = {
		changed,
		unchanged,
		closed,
		stale: {
			issues: issues.totalCount - issues.nodes.length,
			discussions: discussions.totalCount - discussions.nodes.length,
		},
	};
	process.stdout.write(JSON.stringify(output) + "\n");
}

// Compare review and thread state too because a PR's updatedAt does not reliably move for them
function baselineEntry(item) {
	return {
		updatedAt: item.updatedAt,
		headSha: item.headSha ?? null,
		lastReviewAt: item.reviews?.at(-1)?.submittedAt ?? null,
		openThreadCount: item.openThreadCount ?? 0,
	};
}

function commit() {
	if (!existsSync(PENDING())) {
		throw new Error("No staged snapshot. Run `gary snapshot` without --commit first.");
	}
	const { fetchedAt, items } = readJson(PENDING());
	renameSync(PENDING(), BASELINE());
	process.stdout.write(
		JSON.stringify({ committed: true, fetchedAt, items: Object.keys(items).length }) + "\n",
	);
}

/** Pages through a connection. With `cutoff`, stops at the first node last updated before it. */
async function fetchAll(query, connection, cutoff) {
	const { owner, name } = repoParts();
	const nodes = [];
	let totalCount;
	let after = null;
	while (true) {
		const data = await withRetry(() => graphql(query, { owner, name, after }));
		const page = data.repository[connection];
		totalCount = page.totalCount;
		for (const node of page.nodes) {
			if (cutoff !== undefined && Date.parse(node.updatedAt) < cutoff) {
				return { nodes, totalCount };
			}
			nodes.push(node);
		}
		if (!page.pageInfo.hasNextPage) return { nodes, totalCount };
		after = page.pageInfo.endCursor;
	}
}

// Prepend older thread pages for the few PRs with more threads than one page holds
async function fetchRemainingThreads(pr) {
	const { owner, name } = repoParts();
	let page = pr.reviewThreads;
	while (page.pageInfo.hasPreviousPage) {
		const data = await withRetry(() =>
			graphql(MORE_THREADS_QUERY, {
				owner,
				name,
				number: pr.number,
				before: page.pageInfo.startCursor,
			}),
		);
		page = data.repository.pullRequest.reviewThreads;
		pr.reviewThreads.nodes.unshift(...page.nodes);
	}
}

async function fetchRemainingReviews(pr) {
	const { owner, name } = repoParts();
	let page = pr.allReviews;
	while (page.pageInfo.hasNextPage) {
		const data = await withRetry(() =>
			graphql(MORE_REVIEWS_QUERY, {
				owner,
				name,
				number: pr.number,
				after: page.pageInfo.endCursor,
			}),
		);
		page = data.repository.pullRequest.reviews;
		pr.allReviews.nodes.push(...page.nodes);
	}
}

// GitHub answers large GraphQL pages with an occasional 502 or timeout
async function withRetry(fn, attempts = 3) {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (e) {
			if (i >= attempts) throw e;
			await new Promise((r) => setTimeout(r, 2000 * i));
		}
	}
}

function authorClassifier(maintainers, bots) {
	return (author) => {
		const login = (author?.login ?? "ghost").toLowerCase();
		if (maintainers.includes(login)) return "maintainer";
		if (COPILOT.includes(login)) return "copilot";
		if (bots.includes(login) || author?.__typename === "Bot") return "bot";
		return "contributor";
	};
}

function trim(text, max = MAX_TEXT) {
	if (!text) return "";
	return text.length > max ? text.slice(0, max) + `… [${text.length - max} more chars]` : text;
}

// Drop Copilot's severity icons too because each one costs about 450 characters
function cleanReviewText(text) {
	return (text ?? "")
		.replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, "")
		.replace(/<picture>[\s\S]*?<\/picture>\s*/g, "");
}

function toReview(r, classify) {
	const body = trim(cleanReviewText(r.body));
	return {
		author: r.author?.login ?? "ghost",
		authorType: classify(r.author),
		isBot: r.author?.__typename === "Bot",
		state: r.state,
		submittedAt: r.submittedAt,
		url: r.url,
		...(body && { body }),
	};
}

function toThread(t, classify) {
	const first = t.comments.nodes[0];
	return {
		id: t.id,
		url: first?.url,
		path: t.path,
		line: t.line ?? t.originalLine,
		author: first?.author?.login ?? "ghost",
		authorType: classify(first?.author),
		isBot: first?.author?.__typename === "Bot",
		createdAt: first?.createdAt,
		body: trim(cleanReviewText(first?.body), MAX_THREAD_TEXT),
	};
}

// A later COMMENTED review keeps an earlier approval or change request of the same reviewer, like on GitHub
function summarizeReviews(reviews, openThreads) {
	const byAuthor = new Map();
	for (const r of reviews) {
		if (!r.submittedAt || r.state === "PENDING") continue;
		const author = r.author?.login ?? "ghost";
		const prev = byAuthor.get(author);
		if (r.state === "COMMENTED" && prev && prev.state !== "commented") continue;
		byAuthor.set(author, {
			author,
			isBot: r.author?.__typename === "Bot",
			state: r.state.toLowerCase(),
			submittedAt: r.submittedAt,
			url: r.url,
			openThreadCount: 0,
		});
	}
	for (const t of openThreads) {
		const entry = byAuthor.get(t.comments.nodes[0]?.author?.login ?? "ghost");
		if (entry) entry.openThreadCount++;
	}
	return [...byAuthor.values()];
}

function toRequestedReviewer({ requestedReviewer: r }) {
	if (!r) return undefined;
	if (r.__typename === "Team") return { login: r.slug, isBot: false, isTeam: true };
	return { login: r.login, isBot: r.__typename === "Bot" };
}

function toComment(c, classify) {
	return {
		id: c.id,
		author: c.author?.login ?? "ghost",
		authorType: classify(c.author),
		authorAssociation: c.authorAssociation,
		createdAt: c.createdAt,
		body: trim(c.body),
	};
}

function common(kind, id, n, classify) {
	return {
		id,
		kind,
		number: n.number,
		title: n.title,
		url: n.url,
		author: n.author?.login ?? "ghost",
		authorType: classify(n.author),
		authorAssociation: n.authorAssociation,
		labels: n.labels.nodes.map((l) => l.name),
		createdAt: n.createdAt,
		updatedAt: n.updatedAt,
		body: trim(n.body),
		commentCount: n.comments.totalCount,
		comments: n.comments.nodes.map((c) => toComment(c, classify)),
	};
}

const CI_STATES = {
	SUCCESS: "passing",
	FAILURE: "failing",
	ERROR: "failing",
	PENDING: "pending",
	EXPECTED: "pending",
};

function toPr(n, classify, sensitivePaths) {
	const rollup = n.commits.nodes[0]?.commit.statusCheckRollup?.state;
	// GraphQL lists reviews and threads oldest first
	const reviews = n.reviews.nodes
		.filter((r) => r.submittedAt)
		.map((r) => toReview(r, classify));
	const open = n.reviewThreads.nodes.filter((t) => !t.isResolved && !t.isOutdated);
	const summary = summarizeReviews(n.allReviews.nodes, open);
	const requested = n.reviewRequests.nodes.map(toRequestedReviewer).filter(Boolean);
	return {
		...common("pr", `pr-${n.number}`, n, classify),
		isDraft: n.isDraft,
		assignees: n.assignees.nodes.map((a) => a.login),
		headSha: n.headRefOid,
		baseRef: n.baseRefName,
		ci: CI_STATES[rollup] ?? "none",
		reviewDecision: n.reviewDecision,
		mergeable: n.mergeable,
		additions: n.additions,
		deletions: n.deletions,
		changedFileCount: n.files.totalCount,
		files: n.files.nodes.map((f) => f.path),
		...sensitiveFiles(n.files.nodes, sensitivePaths),
		...(reviews.length && { reviews }),
		...(summary.length && { reviewSummary: summary }),
		...(requested.length && { requestedReviewers: requested }),
		...(open.length && {
			openThreadCount: open.length,
			openThreads: open.slice(-MAX_OPEN_THREADS).map((t) => toThread(t, classify)),
		}),
	};
}

// Only the first 50 changed files are checked, like the `files` list
function sensitiveFiles(files, patterns) {
	const hits = files.map((f) => f.path).filter((p) => patterns.some((g) => matchesGlob(p, g)));
	return hits.length ? { sensitiveFiles: hits } : {};
}

function toIssue(n, classify) {
	return {
		...common("issue", `issue-${n.number}`, n, classify),
		assignees: n.assignees.nodes.map((a) => a.login),
	};
}

function toDiscussion(n, classify) {
	return {
		...common("discussion", `disc-${n.number}`, n, classify),
		comments: n.comments.nodes.map((c) => ({
			...toComment(c, classify),
			replyCount: c.replies.totalCount,
			replies: c.replies.nodes.map((r) => toComment(r, classify)),
		})),
		category: n.category?.name,
		isAnswerable: n.category?.isAnswerable ?? false,
		isAnswered: n.isAnswered ?? false,
	};
}

function readJson(path) {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		await main(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`snapshot: ${e.message}\n`);
		process.exitCode = 1;
	}
}
