// The parts of a contributions instance that need no GitHub call: item ids, the repo filter, the search queries and
// the facts the classification reads. A contributions instance follows the maintainer's own threads in repos outside
// their maintainer instances. See "Contributions" in SPEC.md.
import { createHash } from "node:crypto";
import { repoMatches } from "./config.mjs";
import { buildTimeline, speakerFacts } from "./facts.mjs";

const ID_KINDS = { pr: "pr", issue: "issue", discussion: "disc" };
const MAX_ID = 100;

/**
 * The item id of a thread in any repo, like `acme.widgets.pr-12`. An owner holds no dot and the kind and number come
 * last, so two threads never share an id. A name too long for the id pattern is cut and gets a hash of the full repo.
 */
export function contributionId(repo, kind, number) {
	const [owner, name] = String(repo).toLowerCase().split("/");
	const tail = `.${ID_KINDS[kind]}-${number}`;
	let id = `${owner}.${name}${tail}`;
	if (id.length > MAX_ID) {
		const hash = createHash("sha256").update(String(repo).toLowerCase()).digest("hex").slice(0, 8);
		id = `${owner}.${name.slice(0, MAX_ID - owner.length - tail.length - 11)}-${hash}${tail}`;
	}
	return id;
}

/**
 * Whether the instance covers `repo`: it is no repo of a maintainer instance (`blocked`, lower case), matches no glob of
 * `exclude` and, when `include` is not empty, matches one of its globs. Returns `{ ok, reason }`.
 */
export function repoCovered(repo, { include = [], exclude = [], blocked = new Set() }) {
	if (blocked.has(String(repo).toLowerCase())) return { ok: false, reason: "maintainer" };
	if (exclude.some((g) => repoMatches(repo, g))) return { ok: false, reason: "exclude" };
	if (include.length && !include.some((g) => repoMatches(repo, g))) return { ok: false, reason: "include" };
	return { ok: true, reason: null };
}

/**
 * After how many quiet days an approved PR in `repo` may get a reminder to merge. An exact name in
 * `mergeReminderDaysFor` wins over an `owner/*` entry, and both win over `mergeReminderDays`.
 */
export function mergeReminderDaysOf(repo, { mergeReminderDays = 14, mergeReminderDaysFor = {} } = {}) {
	const globs = Object.keys(mergeReminderDaysFor).filter((g) => repoMatches(repo, g));
	const hit = globs.find((g) => !g.endsWith("/*")) ?? globs[0];
	return hit === undefined ? mergeReminderDays : mergeReminderDaysFor[hit];
}

// GitHub's search refuses queries longer than this
export const MAX_QUERY = 256;

/**
 * The qualifiers that narrow every search to the covered repos: `repo:` and `user:` for `include`, `-repo:` and
 * `-user:` for the maintainer repos and `exclude`. They are an optimization only, because the code filters every
 * result again. Qualifiers that would make a query too long are left out. `base` is the longest query they go on.
 */
export function scopeQualifiers({ include = [], exclude = [], blocked = new Set() }, base = "") {
	const term = (glob, sign) => {
		const [owner, name] = glob.split("/");
		return name === "*" ? `${sign}user:${owner}` : `${sign}repo:${glob}`;
	};
	let length = base.length;
	const fits = (parts) => parts.reduce((n, p) => n + p.length + 1, length) <= MAX_QUERY;
	// Without every include qualifier the search would miss threads, so they go in all together or not at all
	const included = include.map((g) => term(g, ""));
	const out = fits(included) ? included : [];
	length += out.reduce((n, p) => n + p.length + 1, 0);
	for (const p of [...[...blocked].map((r) => `-repo:${r}`), ...exclude.map((g) => term(g, "-"))]) {
		if (!fits([p])) break;
		out.push(p);
		length += p.length + 1;
	}
	return out;
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The searches of one snapshot, in the order the cap keeps them: who waits on the maintainer first, then the maintainer's own work, then the
 * threads the maintainer took part in, then what closed in the last days. `type` is the GraphQL search type, `reason` the
 * involvement a hit carries. `cutoff` and `closedSince` are times in ms.
 */
export function contributionSearches({ cutoff, closedSince }) {
	const since = `updated:>=${day(cutoff)}`;
	const closed = `closed:>=${day(closedSince)}`;
	return [
		{ key: "review", type: "ISSUE", reason: "review_requested", q: "is:open is:pr draft:false review-requested:@me archived:false" },
		{ key: "own-pr", type: "ISSUE", reason: "author", q: "is:open is:pr draft:false author:@me archived:false" },
		{ key: "assigned", type: "ISSUE", reason: "assignee", q: `is:open assignee:@me archived:false ${since}` },
		{ key: "own-issue", type: "ISSUE", reason: "author", q: `is:open is:issue author:@me archived:false ${since}` },
		{ key: "own-discussion", type: "DISCUSSION", reason: "author", q: `is:open author:@me ${since}` },
		{ key: "involved", type: "ISSUE", reason: "involved", q: `is:open involves:@me archived:false ${since}` },
		{ key: "reviewed", type: "ISSUE", reason: "reviewer", q: `is:open is:pr reviewed-by:@me archived:false ${since}` },
		{ key: "involved-discussion", type: "DISCUSSION", reason: "involved", q: `is:open involves:@me ${since}` },
		{ key: "closed", type: "ISSUE", reason: "involved", q: `is:closed involves:@me archived:false ${closed}` },
		{ key: "closed-discussion", type: "DISCUSSION", reason: "involved", q: `is:closed involves:@me ${closed}` },
	];
}

const ACTOR = "author { login __typename }";
const STATUS = "createdAt actor { login __typename }";

// The size of a PR and the times its review was requested, which decide whether a review draft starts without a click
const REVIEW_DRAFT_FIELDS = `additions deletions changedFiles
	reviewRequestEvents: timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } } } } }`;

const PR_FIELDS = `
	__typename number title url body createdAt updatedAt closedAt isDraft state
	repository { nameWithOwner viewerPermission }
	${ACTOR} authorAssociation
	labels(first: 20) { nodes { name } }
	assignees(first: 10) { nodes { login } }
	headRefOid reviewDecision mergeable
	commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
	recentCommits: commits(last: 10) { nodes { commit { oid committedDate author { name user { login } } } } }
	comments(last: 5) { totalCount nodes { id ${ACTOR} authorAssociation createdAt body url } }
	timelineComments: comments(last: 30) { totalCount nodes { ${ACTOR} createdAt body url } }
	statusEvents: timelineItems(itemTypes: [MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, LABELED_EVENT, UNLABELED_EVENT], last: 15) {
		nodes { __typename ... on MergedEvent { ${STATUS} } ... on ClosedEvent { ${STATUS} } ... on ReopenedEvent { ${STATUS} } ... on ReadyForReviewEvent { ${STATUS} } ... on ConvertToDraftEvent { ${STATUS} } ... on HeadRefForcePushedEvent { ${STATUS} } ... on LabeledEvent { ${STATUS} label { name } } ... on UnlabeledEvent { ${STATUS} label { name } } }
	}
	allReviews: reviews(last: 30) { nodes { ${ACTOR} state submittedAt url body } }
	reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug } } } }
	reviewThreads(last: 30) { nodes { isResolved isOutdated path line comments(first: 1) { nodes { ${ACTOR} createdAt url body } } allComments: comments(last: 5) { totalCount nodes { ${ACTOR} createdAt body url } } } }
	${REVIEW_DRAFT_FIELDS}
`;

const ISSUE_FIELDS = `
	__typename number title url body createdAt updatedAt closedAt state stateReason
	repository { nameWithOwner }
	${ACTOR} authorAssociation
	labels(first: 20) { nodes { name } }
	assignees(first: 10) { nodes { login } }
	comments(last: 5) { totalCount nodes { id ${ACTOR} authorAssociation createdAt body url } }
	timelineComments: comments(last: 30) { totalCount nodes { ${ACTOR} createdAt body url } }
	statusEvents: timelineItems(itemTypes: [CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT], last: 15) {
		nodes { __typename ... on ClosedEvent { ${STATUS} } ... on ReopenedEvent { ${STATUS} } ... on LabeledEvent { ${STATUS} label { name } } ... on UnlabeledEvent { ${STATUS} label { name } } }
	}
	closedByPullRequestsReferences(first: 3, includeClosedPrs: true) { nodes { number url state } }
`;

const DISCUSSION_FIELDS = `
	__typename number title url body createdAt updatedAt closed closedAt
	repository { nameWithOwner }
	${ACTOR} authorAssociation
	labels(first: 20) { nodes { name } }
	category { name isAnswerable }
	isAnswered
	answer { ${ACTOR} createdAt url }
	comments(last: 5) { totalCount nodes { id ${ACTOR} authorAssociation createdAt body url replies(last: 2) { totalCount nodes { id ${ACTOR} authorAssociation createdAt body url } } } }
	timelineComments: comments(last: 30) { totalCount nodes { ${ACTOR} createdAt body url replies(last: 10) { totalCount nodes { ${ACTOR} createdAt body url } } } }
`;

export const NODE_FIELDS = { pr: PR_FIELDS, issue: ISSUE_FIELDS, discussion: DISCUSSION_FIELDS };

// One page of a search. The query name lets tests answer it
export const SEARCH_QUERY = `query ContributionsSearch($q: String!, $type: SearchType!, $first: Int!, $after: String) {
	search(query: $q, type: $type, first: $first, after: $after) {
		issueCount discussionCount
		pageInfo { hasNextPage endCursor }
		nodes { ... on PullRequest { ${PR_FIELDS} } ... on Issue { ${ISSUE_FIELDS} } ... on Discussion { ${DISCUSSION_FIELDS} } }
	}
}`;

export const kindOfNode = (node) => ({ PullRequest: "pr", Issue: "issue", Discussion: "discussion" })[node?.__typename] ?? null;

const low = (v) => String(v ?? "").toLowerCase();

// Comments that only agree, like "+1" or "same here", carry no news
const AGREEMENT = /^(?:\+1|👍|me too|same here|same|same issue|same problem)[\s.!]*$/iu;

/** The text of a comment without quoted lines, so a mention inside a quote is no mention. */
export const unquoted = (body) => String(body ?? "").split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").trim();

/** Whether a comment names `me` outside a quote. */
export function mentions(body, me) {
	if (!me) return false;
	return new RegExp(`(^|[^\\w-])@${me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(unquoted(body));
}

// A comment asks the maintainer when it names them or its last line ends in a question mark
const asks = (body, me) => mentions(body, me) || /\?\s*$/.test(unquoted(body).split("\n").filter((l) => l.trim()).at(-1) ?? "");

const isBotAuthor = (author) => author?.__typename === "Bot" || low(author?.login).endsWith("[bot]") || ["copilot", "copilot-swe-agent"].includes(low(author?.login));

const MAX_NEWS = 15;
const MAX_EXCERPT = 300;
const NEWS_STATUS = { MergedEvent: "merged", ClosedEvent: "closed", ReopenedEvent: "reopened" };

/**
 * The events after `after` (ms) that may be news for the maintainer, oldest first, as `{ at, by, kind, state?, excerpt?, mentionsMe?, asksMe? }`.
 * Code drops the mechanical noise: the maintainer's own events, bots, comments that only agree, label changes, draft and ready
 * flips, force-pushes and CI. Whether the rest matters for the maintainer is the classification's call.
 */
export function newsOf(kind, node, { me, after }) {
	const out = [];
	const keep = (author) => author && low(author.login) !== low(me) && !isBotAuthor(author);
	const comment = (c, k) => {
		if (!c?.createdAt || !(Date.parse(c.createdAt) > after) || !keep(c.author)) return;
		const text = unquoted(c.body);
		if (AGREEMENT.test(text)) return;
		out.push({ at: c.createdAt, by: c.author.login, kind: k, ...(text && { excerpt: text.slice(0, MAX_EXCERPT) }), ...(mentions(c.body, me) && { mentionsMe: true }), ...(asks(c.body, me) && { asksMe: true }) });
	};
	for (const c of node.timelineComments?.nodes ?? []) {
		comment(c, "comment");
		for (const r of c.replies?.nodes ?? []) comment(r, "reply");
	}
	if (kind === "pr") {
		for (const r of node.allReviews?.nodes ?? []) {
			if (!r.submittedAt || r.state === "PENDING" || !(Date.parse(r.submittedAt) > after) || !keep(r.author)) continue;
			const text = unquoted(r.body);
			out.push({ at: r.submittedAt, by: r.author.login, kind: "review", state: low(r.state), ...(text && { excerpt: text.slice(0, MAX_EXCERPT) }) });
		}
		for (const t of node.reviewThreads?.nodes ?? []) for (const c of t.allComments?.nodes ?? []) comment(c, "thread_comment");
		for (const { commit: c } of node.recentCommits?.nodes ?? []) {
			const who = c?.author?.user ?? (c?.author?.name ? { login: c.author.name } : null);
			if (c?.committedDate && Date.parse(c.committedDate) > after && keep(who)) out.push({ at: c.committedDate, by: who.login, kind: "commit" });
		}
	}
	for (const e of node.statusEvents?.nodes ?? []) {
		const k = NEWS_STATUS[e?.__typename];
		if (k && e.createdAt && Date.parse(e.createdAt) > after && keep(e.actor)) out.push({ at: e.createdAt, by: e.actor.login, kind: k });
	}
	if (kind === "discussion" && node.answer?.createdAt && Date.parse(node.answer.createdAt) > after && keep(node.answer.author)) {
		out.push({ at: node.answer.createdAt, by: node.answer.author.login, kind: "answer" });
	}
	out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	return out;
}

// The kinds of involvement, in the order the facts list them
export const INVOLVEMENT = ["author", "assignee", "review_requested", "reviewer", "commenter", "mentioned"];
// The maintainer has a part in these threads even when nothing new happened
const ACTIVE = new Set(["author", "assignee", "review_requested"]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The raw events of a node for the facts timeline, like the maintainer snapshot builds them.
 */
function timelineEvents(kind, node) {
	const events = [{ at: node.createdAt, author: node.author, body: node.body, kind: "opened" }];
	for (const c of node.timelineComments?.nodes ?? []) {
		events.push({ at: c.createdAt, author: c.author, body: c.body, url: c.url, kind: "comment" });
		for (const r of c.replies?.nodes ?? []) events.push({ at: r.createdAt, author: r.author, body: r.body, url: r.url, kind: "reply" });
	}
	if (kind === "pr") {
		for (const r of node.allReviews?.nodes ?? []) if (r.submittedAt) events.push({ at: r.submittedAt, author: r.author, body: "", url: r.url, kind: "review" });
		for (const t of node.reviewThreads?.nodes ?? []) for (const c of t.allComments?.nodes ?? []) events.push({ at: c.createdAt, author: c.author, body: c.body, url: c.url, kind: "thread_comment" });
	}
	return events;
}

/**
 * The facts of one thread for a contributions instance. `reasons` are the involvements the searches found, `gotIt` the
 * time of the maintainer's last "Got it" on the board, or null. `ctx` is `{ me, us, patterns }` for the sides of the timeline.
 * Returns the facts: the timeline and who waits, `involvement`, `lookedAt` with `lookedVia`, `news`, and for PRs
 * the review and CI state. `quiet` is true when nothing is new for the maintainer and they have no active part in the thread.
 */
export function contributionFacts(kind, node, { me, ctx, reasons = [], gotIt = null, ci = "none", now = Date.now(), reminderDays = 14 }) {
	const comments = node.timelineComments;
	let truncated = (comments?.totalCount ?? 0) > (comments?.nodes?.length ?? 0);
	for (const c of comments?.nodes ?? []) if ((c.replies?.totalCount ?? 0) > (c.replies?.nodes?.length ?? 0)) truncated = true;
	const { timeline, timelineTruncated, lastEventUrl } = buildTimeline(timelineEvents(kind, node), ctx, { truncated });
	const isMe = (login) => low(login) === low(me);
	const mine = timeline.filter((e) => isMe(e.author));
	const involvement = new Set(reasons.filter((r) => r !== "involved"));
	if (isMe(node.author?.login)) involvement.add("author");
	if ((node.assignees?.nodes ?? []).some((a) => isMe(a.login))) involvement.add("assignee");
	const requested = (node.reviewRequests?.nodes ?? []).some((r) => isMe(r.requestedReviewer?.login));
	if (requested) involvement.add("review_requested");
	if (mine.some((e) => e.kind === "review")) involvement.add("reviewer");
	if (mine.some((e) => e.kind !== "opened" && e.kind !== "review")) involvement.add("commenter");
	// The search finds a mention also in older comments than the snapshot reads
	if (!involvement.size) involvement.add("mentioned");
	const ownAt = mine.at(-1)?.at ?? null;
	const gotItAt = typeof gotIt === "string" && Number.isFinite(Date.parse(gotIt)) ? gotIt : null;
	const lookedAt = !gotItAt ? ownAt : !ownAt || Date.parse(gotItAt) > Date.parse(ownAt) ? gotItAt : ownAt;
	const lookedVia = !lookedAt ? null : lookedAt === gotItAt ? "got_it" : "comment";
	const news = newsOf(kind, node, { me, after: lookedAt ? Date.parse(lookedAt) : -Infinity });
	const lastAt = timeline.at(-1)?.at ?? node.updatedAt;
	const facts = {
		timeline,
		...(timelineTruncated && { timelineTruncated }),
		...(lastEventUrl && { lastEventUrl }),
		...speakerFacts(timeline, now),
		involvement: INVOLVEMENT.filter((r) => involvement.has(r)),
		lookedAt,
		lookedVia,
		news: news.slice(-MAX_NEWS),
		newsCount: news.length,
		quietDays: Math.max(0, Math.floor((now - Date.parse(lastAt)) / DAY_MS)),
	};
	const state = kind === "discussion" ? (node.closed ? "closed" : "open") : low(node.state);
	if (state !== "open") facts.closed = closedFacts(kind, node, state);
	if (kind === "pr") Object.assign(facts, prFacts(node, { me, ci, requested }), { mergeReminderDays: reminderDays });
	if (kind === "discussion") Object.assign(facts, { answerable: node.category?.isAnswerable === true, isAnswered: node.isAnswered === true, category: node.category?.name });
	if (kind === "issue") facts.closingPrs = (node.closedByPullRequestsReferences?.nodes ?? []).map((p) => ({ number: p.number, url: p.url, state: low(p.state) }));
	facts.quiet = news.length === 0 && !facts.involvement.some((r) => ACTIVE.has(r)) && !facts.closed;
	return facts;
}

// Who closed or merged the thread and how
function closedFacts(kind, node, state) {
	const ev = (node.statusEvents?.nodes ?? []).filter((e) => e?.__typename === (state === "merged" ? "MergedEvent" : "ClosedEvent")).at(-1);
	const how = state === "merged" ? "merged" : kind === "issue" && node.stateReason ? low(node.stateReason) : "closed";
	return { at: ev?.createdAt ?? node.closedAt ?? null, by: ev?.actor?.login ?? null, how };
}

// The state of a PR that decides what the maintainer does next on their own PR or a PR they review
// The repo permissions that let the viewer merge a PR
const CAN_MERGE = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

function prFacts(node, { me, ci, requested }) {
	const isMe = (login) => low(login) === low(me);
	const latest = new Map();
	for (const r of node.allReviews?.nodes ?? []) {
		if (!r.submittedAt || r.state === "PENDING") continue;
		const prev = latest.get(r.author?.login);
		// A later COMMENTED review keeps an earlier approval or change request, like on GitHub
		if (r.state === "COMMENTED" && prev && prev.state !== "COMMENTED") continue;
		latest.set(r.author?.login ?? "ghost", r);
	}
	const by = (state) => [...latest.values()].filter((r) => r.state === state && !isMe(r.author?.login)).map((r) => r.author?.login ?? "ghost");
	const open = (node.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved);
	const mine = [...latest.values()].find((r) => isMe(r.author?.login));
	const commits = (node.recentCommits?.nodes ?? []).map((n) => n.commit?.committedDate).filter(Boolean).sort();
	return {
		ci,
		ciGreen: ci === "passing",
		canMerge: CAN_MERGE.has(node.repository?.viewerPermission),
		approvedBy: by("APPROVED"),
		changesRequestedBy: by("CHANGES_REQUESTED"),
		openThreadCount: open.length,
		openThreadsByOthers: open.filter((t) => !isMe(t.comments?.nodes?.[0]?.author?.login)).length,
		...(requested && { reviewRequested: true }),
		...(mine && { myReview: { state: low(mine.state), at: mine.submittedAt, pushedSince: commits.some((c) => Date.parse(c) > Date.parse(mine.submittedAt)) } }),
		...reviewDraftFacts(node, { me, requested }),
	};
}

/**
 * The facts a review draft reads: `changedLines`, `changedFiles`, and for a PR that requests the maintainer's review
 * `reviewRequestedAt`, the newest request of the maintainer. It is null when the request is older than the events read.
 */
export function reviewDraftFacts(node, { me, requested }) {
	const out = {};
	if (Number.isInteger(node.additions) && Number.isInteger(node.deletions)) out.changedLines = node.additions + node.deletions;
	if (Number.isInteger(node.changedFiles)) out.changedFiles = node.changedFiles;
	if (requested) {
		const at = (node.reviewRequestEvents?.nodes ?? []).filter((e) => e?.createdAt && low(e.requestedReviewer?.login) === low(me)).map((e) => e.createdAt).sort().at(-1);
		out.reviewRequestedAt = at ?? null;
	}
	return out;
}
