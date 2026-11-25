// gary snapshot           print the work list, stage the snapshot in <state>/snapshot.pending.json
// gary snapshot --out <f> write the work list to <f> instead, creating its directory
//                         Changed items in focus are listed in `focus`, apart from `changed`
// gary snapshot --commit  promote the staged snapshot to the baseline <state>/snapshot.json
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ID_PATTERN, boardDir, readJson as readDoc } from "./lib/board-store.mjs";
import { allowedRepo, botLogins, instanceName, instanceNames, isContributions, loadConfig, loadProfile, maintainerLogins, maintainerRepos, repoParts, stateDir } from "./lib/config.mjs";
import { NODE_FIELDS, SEARCH_QUERY, contributionFacts, contributionId, contributionSearches, kindOfNode, mergeReminderDaysOf, repoCovered, scopeQualifiers } from "./lib/contributions.mjs";
import { lastReview, maintainerJoinedAt, offerAnswer, reRequestedAt, readAutoReviews } from "./lib/auto-review.mjs";
import { aiFacts, buildTimeline, dueFacts, feedbackFacts, issueFacts, lastEventBy, oursAlone, prFacts, reviewRequestsFor, seriesOf, sizeFacts, speakerFacts } from "./lib/facts.mjs";
import { activityOf } from "./lib/since.mjs";
import { canReadProjects, graphql, writeLogin } from "./lib/gh.mjs";
import { fixPrNumbers, patchFixRecord, readFixRecords, vanishedFixPrs } from "./lib/fixes.mjs";
import { heldItemIds } from "./lib/focus.mjs";
import { logPostedTexts } from "./lib/posted.mjs";

const BASELINE = () => join(stateDir(), "snapshot.json");
const PENDING = () => join(stateDir(), "snapshot.pending.json");
const MAX_TEXT = 1500;
const MAX_FILES = 50;
const MAX_THREAD_TEXT = 600;
const MAX_OPEN_THREADS = 20;
const THREAD_PAGE = 100;
const TIMELINE_PAGE = 50;
const STATUS_PAGE = 20;
const MAX_COMMITS = 100;
const TIMELINE_REPLIES = 20;
const TIMELINE_THREAD_COMMENTS = 20;
const MAX_REPLIES = 300;
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
		allComments: comments(last: ${TIMELINE_THREAD_COMMENTS}) { totalCount nodes { author { login __typename } createdAt body url } }
	}
`;

// Light comment lists for the facts timeline. Bodies are needed only to spot automated comments
const TIMELINE_COMMENTS = `timelineComments: comments(last: ${TIMELINE_PAGE}) { totalCount nodes { author { login __typename } createdAt body url } }`;

const REVIEW_STATE_FIELDS = `
	pageInfo { hasNextPage endCursor }
	nodes { author { login __typename } state submittedAt url }
`;

// The "Re-request review" button of a PR creates one of these
const REVIEW_REQUEST_EVENTS = `reviewRequestEvents: timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 30) {
					nodes { ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } } } }
				}`;

// The status changes for the "Since your last choice" timeline. Issues have no draft, ready, force-push or merge events
const EVENT_TYPES = {
	READY_FOR_REVIEW_EVENT: "ReadyForReviewEvent", CONVERT_TO_DRAFT_EVENT: "ConvertToDraftEvent", HEAD_REF_FORCE_PUSHED_EVENT: "HeadRefForcePushedEvent",
	MERGED_EVENT: "MergedEvent", CLOSED_EVENT: "ClosedEvent", REOPENED_EVENT: "ReopenedEvent", LABELED_EVENT: "LabeledEvent", UNLABELED_EVENT: "UnlabeledEvent",
};
const ISSUE_STATUS = ["CLOSED_EVENT", "REOPENED_EVENT", "LABELED_EVENT", "UNLABELED_EVENT"];
const statusEvents = (types) => `statusEvents: timelineItems(itemTypes: [${types.join(", ")}], last: ${STATUS_PAGE}) {
					nodes { __typename ${types.map((t) => `... on ${EVENT_TYPES[t]} { createdAt actor { login __typename }${/LABELED/.test(t) ? " label { name }" : ""} }`).join(" ")} }
				}`;

const PR_FIELDS = `
				number title url body createdAt updatedAt isDraft state maintainerCanModify
				author { login __typename } authorAssociation
				${REVIEW_REQUEST_EVENTS}
				labels(first: 30) { nodes { name } }
				assignees(first: 10) { nodes { login } }
				headRefOid headRefName baseRefName isCrossRepository reviewDecision mergeable
				additions deletions
				milestone { title dueOn }
				closingIssuesReferences(first: 5) { nodes { number } }
				commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
				recentCommits: commits(last: 20) { nodes { commit { oid committedDate author { user { login } } committer { user { login } } } } }
				allCommits: commits(first: ${MAX_COMMITS}) { totalCount nodes { commit { message signature { isValid wasSignedByGitHub } author { name email user { login } } committer { name email user { login } } } } }
				files(first: ${MAX_FILES}) { totalCount nodes { path additions deletions } }
				comments(last: 5) { ${COMMENT_FIELDS} }
				${TIMELINE_COMMENTS}
				${statusEvents(Object.keys(EVENT_TYPES))}
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
`;

// Date fields of the item's projects, for its due date. Reading them needs the read:project scope
const PROJECT_FIELDS = `
				projectItems(first: 5) { nodes { project { title } fieldValues(first: 20) { nodes { ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } } } } }
`;
const withProjects = (fields, projects) => (projects ? fields + PROJECT_FIELDS : fields);

const prQuery = (projects) => `query($owner: String!, $name: String!, $after: String) {
	repository(owner: $owner, name: $name) {
		pullRequests(states: OPEN, first: 25, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
			pageInfo { hasNextPage endCursor }
			nodes { ${withProjects(PR_FIELDS, projects)} }
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

const ALL_FILES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			files(first: 100, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { path additions deletions } }
		}
	}
}`;

const ISSUE_FIELDS = `
				number title url body createdAt updatedAt state
				author { login __typename } authorAssociation
				labels(first: 30) { nodes { name } }
				assignees(first: 10) { nodes { login } }
				comments(last: 5) { ${COMMENT_FIELDS} }
				${TIMELINE_COMMENTS}
				${statusEvents(ISSUE_STATUS)}
				closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number url state isDraft title author { login } } }
				milestone { title dueOn }
				parent { number }
`;

const issueQuery = (projects) => `query($owner: String!, $name: String!, $after: String) {
	repository(owner: $owner, name: $name) {
		issues(states: OPEN, first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
			totalCount
			pageInfo { hasNextPage endCursor }
			nodes { ${withProjects(ISSUE_FIELDS, projects)} }
		}
	}
}`;

const DISCUSSION_FIELDS = `
				number title url body createdAt updatedAt closed
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
				timelineComments: comments(last: ${TIMELINE_PAGE}) {
					totalCount
					nodes {
						id author { login __typename } createdAt body url
						replies(last: ${TIMELINE_REPLIES}) { totalCount nodes { author { login __typename } createdAt body url } }
					}
				}
`;

const MORE_REPLIES_QUERY = `query($id: ID!, $after: String) {
	node(id: $id) {
		... on DiscussionComment {
			replies(first: 100, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { author { login __typename } createdAt body url } }
		}
	}
}`;

const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $after: String) {
	repository(owner: $owner, name: $name) {
		discussions(states: OPEN, first: 30, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
			totalCount
			pageInfo { hasNextPage endCursor }
			nodes { ${DISCUSSION_FIELDS} }
		}
	}
}`;

// The answer to a format offer: the reactions on the review that made it, and the comments after it
const OFFER_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			state headRefOid maintainerCanModify
			offerReviews: reviews(last: 30) { nodes { url reactions(first: 50) { nodes { content createdAt user { login } } } } }
			offerComments: comments(last: 30) { nodes { url createdAt body author { login } } }
			${REVIEW_REQUEST_EVENTS}
		}
	}
}`;

/**
 * Reads what a PR with an automatic review shows since: `{ state, headSha, maintainerCanModify, reactions, comments, reReviewRequests }`.
 * `reactions` are the ones on the review at `reviewUrl`, as `[{ content, user, at }]`. `comments` are the PR's last
 * 30 comments as `[{ at, author, url, body }]`. Everything in them is untrusted text.
 */
export async function fetchOfferFacts(number, reviewUrl, repo = loadProfile().repo) {
	if (!allowedRepo(instanceName(), repo)) throw new Error(`${repo} is not a repository of instance ${instanceName()}`);
	const { owner, name } = repoParts(repo);
	const data = await withRetry(() => graphql(OFFER_QUERY, { owner, name, number }));
	const pr = data.repository?.pullRequest;
	if (!pr) throw new Error(`pr #${number} not found in ${owner}/${name}`);
	const review = (pr.offerReviews?.nodes ?? []).find((r) => r.url === reviewUrl);
	return {
		state: String(pr.state ?? "").toLowerCase(),
		headSha: pr.headRefOid,
		maintainerCanModify: pr.maintainerCanModify === true,
		reactions: (review?.reactions?.nodes ?? []).map((r) => ({ content: r.content, user: r.user?.login ?? "ghost", at: r.createdAt })),
		comments: (pr.offerComments?.nodes ?? []).map((c) => ({ at: c.createdAt, author: c.author?.login ?? "ghost", url: c.url, body: trim(c.body) })),
		reReviewRequests: reviewRequestsFor(pr, writeLogin()),
	};
}

/** Marks the PR nodes that have an automatic review with its record, and reads the answer to an open format offer. */
async function attachAutoReviews(prNodes) {
	const records = await readAutoReviews();
	await Promise.all(prNodes.map(async (node) => {
		const record = records[`pr-${node.number}`];
		if (!lastReview(record)) return;
		node.autoReviewRecord = record;
		if (record.offer?.state === "open") node.offerFacts = await fetchOfferFacts(node.number, record.offer.url);
	}));
}

const ITEM_QUERIES = {
	pr: ["pullRequest", PR_FIELDS],
	issue: ["issue", ISSUE_FIELDS],
	discussion: ["discussion", DISCUSSION_FIELDS],
};

/**
 * Records `ended` on every fix PR that left the open PRs, as "merged" or "closed". Without it a fix whose PR and
 * issue both left the snapshot would count as open forever. A failure only warns: the next snapshot tries again.
 */
async function markEndedFixes(records, openPrs) {
	const numbers = vanishedFixPrs(records, openPrs).slice(0, 50);
	if (!numbers.length) return;
	try {
		const { owner, name } = repoParts(loadProfile().repo);
		const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { state }`).join(" ");
		const data = await graphql(`query EndedFixes($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, { owner, name });
		for (const n of numbers) {
			const state = data.repository?.[`p${n}`]?.state;
			if (state === "MERGED" || state === "CLOSED") await patchFixRecord(n, { ended: state.toLowerCase() });
		}
	} catch (e) {
		console.error(`gary snapshot: could not check ended fix PRs: ${e.message}`);
	}
}

/** The file `--out` names. The baseline and the staged snapshot must never be the target. */
export function outPath(argv) {
	const i = argv.indexOf("--out");
	if (i < 0) return null;
	const out = argv[i + 1] ? resolve(argv[i + 1]) : null;
	if (!out) throw new Error("--out needs a file path");
	if (out === resolve(BASELINE()) || out === resolve(PENDING())) throw new Error("--out must not name the baseline. Write the work list into the run directory.");
	return out;
}

export async function main(argv = []) {
	if (argv.includes("--commit")) return commit();
	const out = outPath(argv);

	const config = loadConfig();
	if (isContributions(config)) return contributionsMain(config, out);
	const cutoff = Date.now() - config.activeWindowDays * 24 * 60 * 60 * 1000;
	const classify = authorClassifier(maintainerLogins(), botLogins());
	const sensitive = loadProfile().sensitivePaths;
	const ctx = factsContext();
	const projects = (await canReadProjects()).ok;

	const [prs, issues, discussions] = await Promise.all([
		fetchAll(prQuery(projects), "pullRequests"),
		fetchAll(issueQuery(projects), "issues", cutoff),
		fetchAll(DISCUSSION_QUERY, "discussions", cutoff),
	]);

	// Drafts are ignored, except Gary's own fix PRs, which the board must show. A draft that becomes ready shows up as a new item
	const fixRecords = await readFixRecords();
	await markEndedFixes(fixRecords, prs.nodes.map((n) => n.number));
	const fixFor = fixPrNumbers(fixRecords);
	const readyPrs = prs.nodes.filter((n) => !n.isDraft || fixFor.has(n.number));
	await Promise.all([
		...readyPrs.flatMap((pr) => [fetchRemainingThreads(pr), fetchRemainingReviews(pr)]),
		...discussions.nodes.map(fetchRemainingReplies),
		attachAutoReviews(readyPrs),
	]);
	const references = discussions.nodes.length ? await fetchDiscussionReferences(discussions.nodes.map((d) => d.number)) : new Map();

	// Drafts get no item, but a draft part still counts in its series
	const series = seriesOf(prs.nodes, issues.nodes);
	const linked = (id, n) => ({ ...dueOf(n), ...(series.has(id) && { series: series.get(id) }) });
	const items = [
		...readyPrs.map((n) => withFacts("pr", n, { ...toPr(n, classify, sensitive), ...(fixFor.has(n.number) && { garyFix: { itemId: fixFor.get(n.number) } }), ...linked(`pr-${n.number}`, n) }, ctx)),
		...issues.nodes.map((n) => withFacts("issue", n, { ...toIssue(n, classify), ...linked(`issue-${n.number}`, n) }, ctx)),
		...discussions.nodes.map((n) => withFacts("discussion", n, { ...toDiscussion(n, classify), ...(references.has(n.number) && { referencingPrs: references.get(n.number) }) }, ctx)),
	];

	const baseline = readJson(BASELINE())?.items ?? {};
	const fetchedAt = new Date().toISOString();
	await notePosted([...readyPrs.map((n) => [`pr-${n.number}`, n]), ...issues.nodes.map((n) => [`issue-${n.number}`, n]), ...discussions.nodes.map((n) => [`disc-${n.number}`, n])]);
	const nodeOf = new Map([
		...readyPrs.map((n) => [`pr-${n.number}`, ["pr", n]]),
		...issues.nodes.map((n) => [`issue-${n.number}`, ["issue", n]]),
		...discussions.nodes.map((n) => [`disc-${n.number}`, ["discussion", n]]),
	]);
	const current = {};
	const changed = [];
	const unchanged = [];
	for (const item of items) {
		const old = baseline[item.id];
		const [kind, node] = nodeOf.get(item.id);
		// The activity stays out of the work list, which the agents read
		const entry = { ...baselineEntry(item), activity: activityOf(kind, node, ctx, { before: old?.activity, ci: item.ci, at: fetchedAt }) };
		current[item.id] = entry;
		let reason;
		if (!old) reason = "new";
		else if (item.headSha && old.headSha !== item.headSha) reason = "head_changed";
		else if (
			old.updatedAt !== entry.updatedAt ||
			(old.lastReviewAt ?? null) !== entry.lastReviewAt ||
			(old.openThreadCount ?? 0) !== entry.openThreadCount ||
			// A new due date or series can change the item's category, also without a new comment
			(old.dueAt ?? null) !== (entry.dueAt ?? null) ||
			JSON.stringify(old.series ?? null) !== JSON.stringify(entry.series ?? null)
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
		JSON.stringify({ fetchedAt, items: current }, null, "\t") + "\n",
	);

	// An item in focus is the focus session's. The run refreshes only its facts, so it leaves `changed`
	const held = heldItemIds();
	const output = {
		changed: changed.filter((c) => !held.has(c.id)),
		focus: changed.filter((c) => held.has(c.id)),
		unchanged,
		closed,
		stale: {
			issues: issues.totalCount - issues.nodes.length,
			discussions: discussions.totalCount - discussions.nodes.length,
		},
	};
	if (!out) return void process.stdout.write(JSON.stringify(output) + "\n");
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(output) + "\n");
}

/**
 * Fetches one item fresh from GitHub, with the same fields as the full snapshot. Writes no state.
 * `kind` is pr, issue or discussion. `repo` defaults to the instance's repo and must be one of its repos.
 * With `allFiles`, a PR's entry lists every changed file, also beyond the snapshot's first page.
 */
export async function fetchItem(kind, number, repo = loadProfile().repo, { allFiles = false } = {}) {
	if (!Object.hasOwn(ITEM_QUERIES, kind)) throw new Error(`kind must be one of ${Object.keys(ITEM_QUERIES).join(", ")}`);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("number must be a positive integer");
	if (typeof repo !== "string") throw new Error("--repo <owner/name> is required for this instance");
	if (!allowedRepo(instanceName(), repo)) throw new Error(`${repo} is not a repository of instance ${instanceName()}`);
	if (isContributions(loadConfig())) return fetchContribution(kind, number, repo);
	const id = `${kind} #${number}`;
	const [field, base] = ITEM_QUERIES[kind];
	const fields = kind === "discussion" ? base : withProjects(base, (await canReadProjects()).ok);
	const { owner, name } = repoParts(repo);
	let data;
	try {
		data = await graphql(
			`query($owner: String!, $name: String!, $number: Int!) {
				repository(owner: $owner, name: $name) { ${field}(number: $number) { ${fields} } }
			}`,
			{ owner, name, number },
		);
	} catch (e) {
		if (/Could not resolve/i.test(e.message)) throw new Error(`${id} not found in ${owner}/${name}`);
		throw e;
	}
	const node = data.repository[field];
	if (!node) throw new Error(`${id} not found in ${owner}/${name}`);
	const classify = authorClassifier(maintainerLogins(), botLogins());
	const ctx = factsContext();
	if (repo === loadProfile().repo) await notePosted([[`${{ pr: "pr", issue: "issue", discussion: "disc" }[kind]}-${number}`, node]]);
	// A series needs every open item, so a single read takes it from the last snapshot
	const staged = (readJson(PENDING()) ?? readJson(BASELINE()))?.items?.[`${{ pr: "pr", issue: "issue", discussion: "disc" }[kind]}-${number}`];
	const linked = { ...(kind === "discussion" ? {} : dueOf(node)), ...(repo === loadProfile().repo && staged?.series && { series: staged.series }) };
	if (kind === "pr") {
		await Promise.all([fetchRemainingThreads(node), fetchRemainingReviews(node), attachAutoReviews([node])]);
		if (allFiles && (node.files.totalCount ?? 0) > node.files.nodes.length) node.files = await fetchAllFiles(owner, name, number);
		// Fix PRs are recorded by number for the instance's own repo
		const fixItem = repo === loadProfile().repo ? fixPrNumbers(await readFixRecords()).get(number) : undefined;
		return withFacts("pr", node, { ...toPr(node, classify, loadProfile().sensitivePaths), ...(fixItem && { garyFix: { itemId: fixItem } }), ...linked }, ctx);
	}
	if (kind === "issue") return withFacts("issue", node, { ...toIssue(node, classify), ...linked }, ctx);
	await fetchRemainingReplies(node);
	return withFacts("discussion", node, toDiscussion(node, classify), ctx);
}

const ITEM_USAGE = "Usage: gary item <id> | gary item <pr|issue|discussion> <number> [--repo <owner/name>]";

/**
 * gary item <id>: the fresh snapshot entry of a stored board item, found by its kind, number and repo.
 * gary item <kind> <number>: the same for any item of the instance's repo.
 */
export async function itemMain(argv) {
	const r = argv.indexOf("--repo");
	const repo = r >= 0 ? argv[r + 1] : undefined;
	const args = r < 0 ? argv : argv.filter((_, i) => i !== r && i !== r + 1);
	let entry;
	if (args.length === 1) {
		if (!ID_PATTERN.test(args[0])) throw new Error(ITEM_USAGE);
		const item = await readDoc(join(boardDir(), "items", args[0] + ".json"));
		if (!item) throw new Error(`Item ${args[0]} is not on the board. ${ITEM_USAGE}`);
		entry = await fetchItem(item.kind, item.number, item.repo ?? repo);
	} else if (args.length === 2) {
		entry = await fetchItem(args[0], Number(args[1]), repo);
	} else throw new Error(ITEM_USAGE);
	process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
}

// Compare review and thread state too because a PR's updatedAt does not reliably move for them
function baselineEntry(item) {
	return {
		updatedAt: item.updatedAt,
		headSha: item.headSha ?? null,
		lastReviewAt: item.reviews?.at(-1)?.submittedAt ?? null,
		openThreadCount: item.openThreadCount ?? 0,
		// Kept for every entry, so `gary wants` can compare unchanged items too
		labels: item.labels ?? [],
		assignees: item.assignees ?? [],
		// `gary handled` compares it with the time the maintainer handled the item
		lastEventAt: item.facts?.timeline?.at(-1)?.at ?? null,
		// The fix state compares it with the time a fix PR was recorded
		lastThemAt: item.facts?.lastThemAt ?? null,
		// The fix state of issues and discussions reads these
		...(item.kind === "pr" && { title: item.title, author: item.author, isDraft: item.isDraft ?? false, ci: item.ci ?? null, ...(item.garyFix && { garyFix: item.garyFix }) }),
		// `gary pr-origin` searches the session transcripts for the PR's branch and reads only those changed since its creation
		...(item.kind === "pr" && { createdAt: item.createdAt, headRef: item.headRef }),
		// The watch on our PRs compares these with the feedback a round already handled
		...(item.kind === "pr" && { feedback: Object.fromEntries(["lastMeAt", "lastMeKind", "lastOthersAt", "ourLastCommitAt", "reviewBotReviews"].filter((k) => item.facts?.[k] != null).map((k) => [k, item.facts[k]])) }),
		// The validator and the board server decide from these which routes may push to the PR
		...(item.sensitiveFiles && { sensitiveFiles: item.sensitiveFiles, ...(item.facts?.sensitiveOurs && { sensitiveOurs: true }) }),
		// The board server serves these from the snapshot, so a new due date shows without a new triage
		...(item.dueAt && { dueAt: item.dueAt, dueSource: item.dueSource }),
		...(item.series && { series: item.series }),
		...(item.facts?.waitingOn && { waitingOn: item.facts.waitingOn }),
		// The board shows a discussion's category also on items written before the routine copied it
		...(item.kind === "discussion" && typeof item.category === "string" && { category: item.category }),
		// The board reads these to tell whether a PR with an automatic review still waits for its contributor
		...(item.autoReview && { autoReview: item.autoReview }),
		...(item.closingPrs && { closingPrs: item.closingPrs }),
		...(item.referencingPrs && { referencingPrs: item.referencingPrs }),
		// The board server checks a review draft and a pending review against these
		...(item.facts?.reviewRequested && { reviewRequested: true, reviewRequestedAt: item.facts.reviewRequestedAt ?? null }),
	};
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_PAGE = 25;
// Closed threads stay this many days, at most the active window, so their news can reach the board
const CLOSED_DAYS = 7;

/** The context of the facts timeline for a contributions instance: only the maintainer themself is "us". */
function contributionsContext(me) {
	return { us: [me.toLowerCase()], patterns: [], me, maintainers: [me.toLowerCase()] };
}

const contributionClassifier = (me) => (author) => {
	const login = (author?.login ?? "ghost").toLowerCase();
	if (login === me.toLowerCase()) return "maintainer";
	if (COPILOT.includes(login)) return "copilot";
	if (author?.__typename === "Bot" || login.endsWith("[bot]")) return "bot";
	return "contributor";
};

// The decision log is a side product. A failure there never breaks a snapshot or a refresh
async function notePosted(threads) {
	try {
		await logPostedTexts(threads, loadConfig().me);
	} catch (e) {
		console.error(`gary snapshot: comparing posted replies failed: ${e.message}`);
	}
}

/** The time of the maintainer's last "Got it" on the stored item, or null. */
async function gotItOf(id) {
	const item = await readDoc(join(boardDir(), "items", id + ".json"));
	return typeof item?.gotIt?.at === "string" ? item.gotIt.at : null;
}

/** One snapshot entry of a contributions instance, from a search or item node. */
function contributionEntry(kind, node, id, classify) {
	const repo = node.repository.nameWithOwner;
	const githubState = kind === "discussion" ? (node.closed ? "closed" : "open") : node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : "open";
	const base = {
		id, repo, kind, number: node.number, title: node.title, url: node.url,
		author: node.author?.login ?? "ghost", authorType: classify(node.author), authorAssociation: node.authorAssociation,
		labels: (node.labels?.nodes ?? []).map((l) => l.name), githubState,
		createdAt: node.createdAt, updatedAt: node.updatedAt, ...(node.closedAt && { closedAt: node.closedAt }),
		body: trim(node.body), commentCount: node.comments?.totalCount ?? 0, comments: (node.comments?.nodes ?? []).map((c) => toComment(c, classify)),
	};
	if (kind === "discussion") {
		return {
			...base,
			comments: (node.comments?.nodes ?? []).map((c) => ({ ...toComment(c, classify), replyCount: c.replies?.totalCount ?? 0, replies: (c.replies?.nodes ?? []).map((r) => toComment(r, classify)) })),
			category: node.category?.name, isAnswerable: node.category?.isAnswerable ?? false, isAnswered: node.isAnswered ?? false,
		};
	}
	if (kind === "issue") return { ...base, assignees: (node.assignees?.nodes ?? []).map((a) => a.login), ...(node.stateReason && { stateReason: node.stateReason.toLowerCase() }) };
	const open = (node.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved);
	const reviews = (node.allReviews?.nodes ?? []).filter((r) => r.submittedAt).map((r) => toReview(r, classify));
	const requested = (node.reviewRequests?.nodes ?? []).map(toRequestedReviewer).filter(Boolean);
	return {
		...base,
		isDraft: node.isDraft,
		assignees: (node.assignees?.nodes ?? []).map((a) => a.login),
		headSha: node.headRefOid,
		ci: CI_STATES[node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state] ?? "none",
		reviewDecision: node.reviewDecision,
		mergeable: node.mergeable,
		...(reviews.length && { reviews: reviews.slice(-10) }),
		...(requested.length && { requestedReviewers: requested }),
		...(open.length && { openThreadCount: open.length, openThreads: open.slice(-10).map((t) => toThread(t, classify)) }),
	};
}

/** Adds the facts to a contributions entry. */
function withContributionFacts(kind, node, entry, { me, ctx, reasons, gotIt, now, config }) {
	return { ...entry, facts: contributionFacts(kind, node, { me, ctx, reasons, gotIt, ci: entry.ci ?? "none", now, reminderDays: mergeReminderDaysOf(entry.repo, config) }) };
}

/**
 * Runs the searches of a contributions instance at once, newest first per search, and keeps at most `max` threads of
 * covered repos, in the order of `searches`. Each search reads at most the pages that `max` threads need.
 * Returns `{ hits: Map<id, { kind, node, reasons }>, cut }`. `cut` says where the cap stopped, or null.
 */
async function searchContributions(searches, scope, max) {
	const read = async (s) => {
		const q = [s.q, ...scopeQualifiers(scope, s.q)].join(" ");
		const nodes = [];
		let after = null;
		let total = 0;
		let more = false;
		while (true) {
			const data = await withRetry(() => graphql(SEARCH_QUERY, { q, type: s.type, first: SEARCH_PAGE, after }));
			const page = data.search;
			total = (s.type === "DISCUSSION" ? page?.discussionCount : page?.issueCount) ?? 0;
			nodes.push(...(page?.nodes ?? []));
			more = page?.pageInfo?.hasNextPage === true;
			if (!more || nodes.length >= max) break;
			after = page.pageInfo.endCursor;
		}
		return { nodes, total, more };
	};
	const results = await Promise.all(searches.map(read));
	const hits = new Map();
	for (const [index, s] of searches.entries()) {
		const { nodes, total, more } = results[index];
		for (const [n, node] of nodes.entries()) {
			const kind = kindOfNode(node);
			const repo = node?.repository?.nameWithOwner;
			if (!kind || typeof repo !== "string" || !repoCovered(repo, scope).ok) continue;
			const id = contributionId(repo, kind, node.number);
			const hit = hits.get(id);
			if (hit) hit.reasons.add(s.reason);
			else if (hits.size < max) hits.set(id, { kind, node, reasons: new Set([s.reason]) });
			else return { hits, cut: { max, search: s.key, matched: total, left: Math.max(0, total - n), skipped: searches.slice(index + 1).map((x) => x.key) } };
		}
		// The search had more pages than the cap let it read
		if (more && hits.size >= max) return { hits, cut: { max, search: s.key, matched: total, left: Math.max(0, total - nodes.length), skipped: searches.slice(index + 1).map((x) => x.key) } };
	}
	return { hits, cut: null };
}

/** The sentence `gary snapshot` prints when the cap cut the snapshot. */
export function cutMessage(cut) {
	const later = cut.skipped.length ? ` The ${cut.skipped.length === 1 ? "search" : "searches"} after it did not count: ${cut.skipped.join(", ")}.` : "";
	return `The snapshot stopped at maxItems ${cut.max}. The search "${cut.search}" matched ${cut.matched} threads, up to ${cut.left} of them are left out.${later} Narrow "include", add repos to "exclude" or raise "maxItems".`;
}

/** gary snapshot for a contributions instance: the maintainer's own threads in every repo outside the maintainer instances. */
async function contributionsMain(config, out) {
	const me = config.me;
	const now = Date.now();
	const scope = { include: config.include, exclude: config.exclude, blocked: maintainerRepos(instanceNames().filter((n) => n !== instanceName())) };
	const searches = contributionSearches({ cutoff: now - config.activeWindowDays * DAY_MS, closedSince: now - Math.min(CLOSED_DAYS, config.activeWindowDays) * DAY_MS });
	const { hits, cut } = await searchContributions(searches, scope, config.maxItems);
	const ctx = contributionsContext(me);
	const classify = contributionClassifier(me);
	const baseline = readJson(BASELINE())?.items ?? {};
	const fetchedAt = new Date().toISOString();
	const current = {};
	const changed = [];
	const quiet = [];
	const unchanged = [];
	for (const [id, { kind, node, reasons }] of hits) {
		const item = withContributionFacts(kind, node, contributionEntry(kind, node, id, classify), { me, ctx, reasons: [...reasons], gotIt: await gotItOf(id), now, config });
		const closed = item.facts.closed;
		const old = baseline[id];
		// A thread the maintainer closed themself holds no news
		if (closed && String(closed.by ?? "").toLowerCase() === me.toLowerCase()) continue;
		// A thread that closed before the maintainer last looked holds no news either.
		// A tracked thread must stay tracked, because its stored item keeps the maintainer's "Got it".
		if (closed && !old && item.facts.lookedAt && !(Date.parse(closed.at) > Date.parse(item.facts.lookedAt))) continue;
		const entry = {
			...baselineEntry(item), repo: item.repo, githubState: item.githubState,
			activity: activityOf(kind, node, ctx, { before: old?.activity, ci: item.ci, at: fetchedAt }),
		};
		current[id] = entry;
		let reason;
		if (!old) reason = "new";
		else if (item.headSha && old.headSha !== item.headSha) reason = "head_changed";
		else if (old.updatedAt !== entry.updatedAt || (old.lastReviewAt ?? null) !== entry.lastReviewAt || (old.openThreadCount ?? 0) !== entry.openThreadCount || old.githubState !== entry.githubState) reason = "updated";
		if (!reason) unchanged.push(id);
		else if (item.facts.quiet) quiet.push(id);
		else changed.push({ id, reason, ...item });
	}
	const closed = Object.keys(baseline).filter((id) => !current[id]);
	await notePosted([...hits].map(([id, { node }]) => [id, node]));
	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(PENDING(), JSON.stringify({ fetchedAt, items: current }, null, "\t") + "\n");
	if (cut) console.error(`gary snapshot: ${cutMessage(cut)}`);
	const output = { changed, quiet, focus: [], unchanged, closed, stale: { issues: 0, discussions: 0 }, ...(cut && { cut: { ...cut, message: cutMessage(cut) } }) };
	if (!out) return void process.stdout.write(JSON.stringify(output) + "\n");
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(output) + "\n");
}

/** gary item for a contributions instance: one thread with the same fields as its snapshot entry. */
async function fetchContribution(kind, number, repo) {
	const config = loadConfig();
	const { owner, name } = repoParts(repo);
	const field = ITEM_QUERIES[kind][0];
	let data;
	try {
		data = await graphql(`query ContributionsItem($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { ${field}(number: $number) { ${NODE_FIELDS[kind]} } } }`, { owner, name, number });
	} catch (e) {
		if (/Could not resolve/i.test(e.message)) throw new Error(`${kind} #${number} not found in ${repo}`);
		throw e;
	}
	const node = data.repository?.[field];
	if (!node) throw new Error(`${kind} #${number} not found in ${repo}`);
	const id = contributionId(repo, kind, number);
	await notePosted([[id, node]]);
	return withContributionFacts(kind, node, contributionEntry(kind, node, id, contributionClassifier(config.me)), { me: config.me, ctx: contributionsContext(config.me), gotIt: await gotItOf(id), now: Date.now(), config });
}

const SEARCH_PRS = 100;

/**
 * PRs that name an active discussion by URL or as #<number> in their title or body, by discussion number.
 * Discussions have no cross-reference events in the API, so one search reads the repo's 100 most recently updated PRs.
 */
async function fetchDiscussionReferences(numbers) {
	const { owner, name } = repoParts();
	const wanted = new Set(numbers);
	const data = await withRetry(() =>
		graphql(
			`query($q: String!) {
				search(query: $q, type: ISSUE, first: ${SEARCH_PRS}) {
					nodes { ... on PullRequest { number url title body state isDraft author { login } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }
				}
			}`,
			{ q: `repo:${owner}/${name} is:pr sort:updated-desc` },
		),
	);
	const out = new Map();
	const urlRef = new RegExp(`github\\.com/${owner}/${name}/discussions/(\\d+)`, "gi");
	for (const pr of data.search?.nodes ?? []) {
		if (!pr?.number) continue;
		const text = `${pr.title ?? ""}\n${pr.body ?? ""}`;
		const refs = new Set([...text.matchAll(urlRef)].map((m) => Number(m[1])));
		for (const m of text.matchAll(/(?:^|[^\w/&])#(\d+)\b/g)) refs.add(Number(m[1]));
		for (const n of refs) {
			if (!wanted.has(n)) continue;
			const ref = {
				number: pr.number, url: pr.url, title: pr.title, author: pr.author?.login ?? "ghost", isDraft: pr.isDraft,
				state: pr.state.toLowerCase(), ci: CI_STATES[pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state] ?? "none",
			};
			out.set(n, [...(out.get(n) ?? []), ref]);
		}
	}
	return out;
}

/** Who counts as us, and the profile's patterns for automated comments. */
function factsContext() {
	const profile = loadProfile();
	const bot = loadConfig().bot?.login;
	return {
		us: [...new Set([...maintainerLogins(), ...botLogins()])],
		maintainers: maintainerLogins(),
		writeLogin: writeLogin(),
		me: loadConfig().me,
		bot: bot ?? null,
		reviewBots: profile.reviewBots ?? [],
		patterns: profile.automatedComments ?? [],
		ai: { logins: [...profile.botLogins, ...(bot ? [bot] : [])], names: profile.aiAuthors ?? [], own: bot ?? null },
	};
}

/** Adds the computed `facts` to a snapshot entry, from the raw GraphQL node. */
function withFacts(kind, node, entry, ctx) {
	const events = [{ at: node.createdAt, author: node.author, body: node.body, kind: "opened" }];
	const comments = node.timelineComments ?? node.comments;
	let truncated = (comments?.totalCount ?? 0) > (comments?.nodes?.length ?? 0);
	for (const c of comments?.nodes ?? []) {
		events.push({ at: c.createdAt, author: c.author, body: c.body, url: c.url, kind: "comment" });
		if (c.replies) {
			for (const r of c.replies.nodes ?? []) events.push({ at: r.createdAt, author: r.author, body: r.body, url: r.url, kind: "reply" });
			if ((c.replies.totalCount ?? 0) > (c.replies.nodes?.length ?? 0)) truncated = true;
		}
	}
	if (kind === "pr") {
		for (const r of node.allReviews?.nodes ?? []) {
			if (r.submittedAt) events.push({ at: r.submittedAt, author: r.author, body: "", url: r.url, kind: "review" });
		}
		for (const t of node.reviewThreads?.nodes ?? []) {
			const all = t.allComments ?? t.comments;
			for (const c of all?.nodes ?? []) events.push({ at: c.createdAt, author: c.author, body: c.body, url: c.url, kind: "thread_comment" });
			if ((all?.totalCount ?? 0) > (all?.nodes?.length ?? 0)) truncated = true;
		}
	}
	const { timeline, timelineTruncated, lastEventUrl } = buildTimeline(events, ctx, { truncated });
	const facts = {
		timeline,
		...(timelineTruncated && { timelineTruncated }),
		...(entry.dueAt && { dueAt: entry.dueAt, dueSource: entry.dueSource }),
		...(entry.series && { series: entry.series }),
		...(lastEventUrl && { lastEventUrl }),
		...speakerFacts(timeline),
		...(kind === "pr" ? { ...prFacts(entry), ...sizeFacts(node), ...aiFacts(node, ctx.ai) } : issueFacts(entry, timeline)),
		...(kind === "discussion" && { answerable: node.category?.isAnswerable === true, answerChosen: node.isAnswered === true }),
	};
	if (kind !== "pr") return { ...entry, facts };
	if (entry.sensitiveFiles) {
		const { ours, reason } = oursAlone(node, { me: ctx.me, bot: ctx.ai.own, garyFix: !!entry.garyFix, ai: ctx.ai });
		if (ours) facts.sensitiveOurs = true;
		else facts.sensitiveNotOurs = reason;
	}
	facts.maintainerCanModify = node.maintainerCanModify === true;
	facts.lastAuthorAt = lastEventBy(timeline, node.author?.login);
	Object.assign(facts, feedbackFacts(timeline, node.recentCommits?.nodes, { me: ctx.me, bot: ctx.bot, writeLogin: ctx.writeLogin, reviewBots: ctx.reviewBots }));
	const requests = reviewRequestsFor(node, ctx.writeLogin);
	if (requests.length) facts.reReviewRequests = requests;
	const record = node.autoReviewRecord;
	if (!record) return { ...entry, facts };
	const withTimeline = { ...entry, facts };
	const last = lastReview(record);
	const offer = record.offer;
	if (offer?.state === "open" && node.offerFacts) {
		const answer = offerAnswer(offer, node.offerFacts, entry.author);
		// The replies are the author's own words after the offer. They are data for the agent that judges them
		facts.formatOffer = { at: offer.at, url: offer.url, kind: offer.kind, acceptedByReaction: answer.accepted, replies: answer.replies };
	}
	return {
		...withTimeline,
		autoReview: {
			lastAuthorAt: facts.lastAuthorAt,
			maintainerAt: maintainerJoinedAt(withTimeline, { maintainers: ctx.maintainers, ownReviewUrls: record.reviews.map((r) => r.url) }),
			reRequestedAt: reRequestedAt(withTimeline, last.at),
		},
	};
}

/** Replaces the inline replies of a discussion's comments with all of them when the inline page was short. */
async function fetchRemainingReplies(discussion) {
	for (const c of discussion.timelineComments?.nodes ?? []) {
		if (!c.replies || (c.replies.totalCount ?? 0) <= (c.replies.nodes?.length ?? 0) || !c.id) continue;
		const all = [];
		let after = null;
		let total = c.replies.totalCount;
		while (all.length < MAX_REPLIES) {
			const data = await withRetry(() => graphql(MORE_REPLIES_QUERY, { id: c.id, after }));
			const page = data.node?.replies;
			if (!page) break;
			total = page.totalCount ?? total;
			all.push(...page.nodes);
			if (!page.pageInfo?.hasNextPage) break;
			after = page.pageInfo.endCursor;
		}
		if (all.length) c.replies = { totalCount: total, nodes: all };
	}
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

async function fetchAllFiles(owner, name, number) {
	const nodes = [];
	let totalCount;
	let after = null;
	while (true) {
		const data = await withRetry(() => graphql(ALL_FILES_QUERY, { owner, name, number, after }));
		const page = data.repository.pullRequest.files;
		totalCount = page.totalCount;
		nodes.push(...page.nodes);
		if (!page.pageInfo.hasNextPage) return { totalCount, nodes };
		after = page.pageInfo.endCursor;
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

function dueOf(node) {
	return dueFacts(node, loadProfile().dueDateFields);
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
		...(t.isOutdated && { outdated: true }),
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
		repo: loadProfile().repo,
		kind,
		number: n.number,
		title: n.title,
		url: n.url,
		author: n.author?.login ?? "ghost",
		authorType: classify(n.author),
		authorAssociation: n.authorAssociation,
		labels: n.labels.nodes.map((l) => l.name),
		// The board's refresh reads one item that may have been closed since the snapshot
		githubState: n.state === "MERGED" ? "merged" : n.state === "CLOSED" || n.closed === true ? "closed" : "open",
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
	// An outdated thread that nobody resolved is still open on GitHub
	const open = n.reviewThreads.nodes.filter((t) => !t.isResolved);
	const summary = summarizeReviews(n.allReviews.nodes, open);
	const requested = n.reviewRequests.nodes.map(toRequestedReviewer).filter(Boolean);
	return {
		...common("pr", `pr-${n.number}`, n, classify),
		isDraft: n.isDraft,
		assignees: n.assignees.nodes.map((a) => a.login),
		headSha: n.headRefOid,
		headRef: n.headRefName,
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

function closingPrs(n) {
	const prs = (n.closedByPullRequestsReferences?.nodes ?? []).map((p) => ({
		number: p.number,
		url: p.url,
		state: p.state.toLowerCase(),
		isDraft: p.isDraft,
		...(p.title !== undefined && { title: p.title }),
		...(p.author !== undefined && { author: p.author?.login ?? "ghost" }),
	}));
	return prs.length ? { closingPrs: prs } : {};
}

function toIssue(n, classify) {
	return {
		...common("issue", `issue-${n.number}`, n, classify),
		assignees: n.assignees.nodes.map((a) => a.login),
		...closingPrs(n),
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
