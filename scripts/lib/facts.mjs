// Mechanical facts about an item, computed by code so no model has to read them out of a thread:
// who spoke when, who we wait on, and for PRs whether it is clean and dependency-only.
import { basename } from "node:path";
import { ciOf } from "./ci.mjs";
import { AUTOMATED_TEXT_LIMIT, PROFILE_DEFAULTS } from "./config.mjs";

export const MAX_TIMELINE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

// Manifests, lock files and files that pin one tool version. A PR that changes only these is a dependency update
const DEPENDENCY_FILES = new Set([
	"package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", ".yarnrc.yml",
	"cargo.toml", "cargo.lock", "go.mod", "go.sum", "gemfile", "gemfile.lock", "composer.json", "composer.lock",
	"pipfile", "pipfile.lock", "poetry.lock", "uv.lock", "pyproject.toml", "requirements.txt", "requirements-dev.txt",
	"gradle.properties", "pom.xml", "packages.lock.json", "directory.packages.props", "flake.lock",
	".nvmrc", ".node-version", ".python-version", ".ruby-version", ".tool-versions", ".terraform.lock.hcl",
]);

export function isDependencyFile(path) {
	const name = basename(path).toLowerCase();
	return DEPENDENCY_FILES.has(name) || /^requirements[\w.-]*\.txt$/.test(name) || /^\.yarn\/releases\//.test(path);
}

const compiled = new Map();
const regexOf = (pattern) => {
	if (!compiled.has(pattern)) compiled.set(pattern, new RegExp(pattern));
	return compiled.get(pattern);
};

/** Whether a comment body matches one of the profile's `automatedComments` patterns. Profile validation compiled them already. */
export function isAutomated(body, patterns = []) {
	const text = (body ?? "").trimStart().slice(0, AUTOMATED_TEXT_LIMIT);
	return patterns.some((p) => regexOf(p.pattern).test(text));
}

/**
 * The side of one event: `automated` (matches automatedComments), `us` (a maintainer, `me` or our own bot),
 * `bot` (GitHub Apps like dependency bots, review bots and the Copilot coding agent), `them` (everyone else).
 */
export function sideOf(author, body, { us, patterns }) {
	const login = (author?.login ?? "ghost").toLowerCase();
	if (isAutomated(body, patterns)) return "automated";
	if (us.includes(login)) return "us";
	if (author?.__typename === "Bot" || login.endsWith("[bot]") || login === "copilot-swe-agent" || login === "copilot") return "bot";
	return "them";
}

/**
 * Sorts raw events `{ at, author, body, kind, url }` into the timeline, newest kept when there are more than the cap.
 * `lastEventUrl` is the `url` of the newest event after the opening post, or null.
 */
export function buildTimeline(events, ctx, { truncated = false } = {}) {
	const sorted = events.filter((e) => e.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	const kept = sorted.slice(-MAX_TIMELINE);
	// Automated comments count here, because the board opens the thread at its newest node
	const lastEventUrl = sorted.filter((e) => e.kind !== "opened" && typeof e.url === "string" && e.url).at(-1)?.url ?? null;
	return {
		lastEventUrl,
		timeline: kept.map((e) => ({ at: e.at, author: e.author?.login ?? "ghost", side: sideOf(e.author, e.body, ctx), kind: e.kind })),
		timelineTruncated: truncated || sorted.length > kept.length,
	};
}

/** Who spoke last and who we wait on. Bot and automated events do not decide whose turn it is. */
export function speakerFacts(timeline, now = Date.now()) {
	const spoken = timeline.filter((e) => e.side !== "automated");
	const people = timeline.filter((e) => e.side === "us" || e.side === "them");
	const last = people.at(-1);
	const lastAt = (side) => people.filter((e) => e.side === side).at(-1)?.at ?? null;
	return {
		lastSpeaker: spoken.at(-1)?.side ?? null,
		lastUsAt: lastAt("us"),
		lastThemAt: lastAt("them"),
		waitingOn: !last ? "nobody" : last.side === "them" ? "us" : "them",
		waitingDays: last ? Math.max(0, Math.floor((now - Date.parse(last.at)) / DAY_MS)) : 0,
	};
}

/**
 * The requests for a review by `login` on a PR, oldest first, as `[{ at, by }]`. GitHub's "Re-request review" button
 * creates one. `node.reviewRequestEvents` holds the PR's last review_requested timeline events.
 */
export function reviewRequestsFor(node, login) {
	const wanted = (login ?? "").toLowerCase();
	if (!wanted) return [];
	return (node.reviewRequestEvents?.nodes ?? [])
		.filter((e) => e?.createdAt && (e.requestedReviewer?.login ?? "").toLowerCase() === wanted)
		.map((e) => ({ at: e.createdAt, by: e.actor?.login ?? "ghost" }))
		.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** When `author` last commented, replied or reviewed in the timeline, or null. The opening post does not count. */
export function lastEventBy(timeline, author) {
	const login = (author ?? "").toLowerCase();
	return timeline.filter((e) => e.kind !== "opened" && String(e.author).toLowerCase() === login).at(-1)?.at ?? null;
}

const FEEDBACK_KINDS = new Set(["comment", "reply", "review", "thread_comment"]);

/**
 * Who gave feedback on a PR last, for the watch on the PRs we control: `{ lastMeAt, lastMeKind, lastOthersAt,
 * ourLastCommitAt, reviewBotReviews }`, each left out when there is none. `lastMeAt` is the newest comment, reply or
 * review by `me`. `lastMeKind` is "review" for a review and "comment" for the others.
 * `lastOthersAt` is the newest one by a person who is neither `me` nor `bot`, co-maintainers included.
 * `ourLastCommitAt` is the commit time of the newest commit in `commits` that `writeLogin` authored or committed.
 * `reviewBotReviews` counts the reviews by an account whose login starts with one of `reviewBots`.
 */
export function feedbackFacts(timeline, commits, { me, bot, writeLogin, reviewBots = [] }) {
	const low = (v) => String(v ?? "").toLowerCase();
	const feedback = timeline.filter((e) => FEEDBACK_KINDS.has(e.kind) && e.side !== "automated");
	const lastMe = feedback.filter((e) => me && low(e.author) === low(me)).at(-1);
	const lastMeAt = lastMe?.at;
	const others = feedback.filter((e) => e.side === "them" || (e.side === "us" && low(e.author) !== low(me) && low(e.author) !== low(bot)));
	const lastOthersAt = others.at(-1)?.at;
	const ours = (commits ?? [])
		.map((c) => c?.commit)
		.filter((c) => c?.committedDate && writeLogin && [c.author?.user?.login, c.committer?.user?.login].some((l) => low(l) === low(writeLogin)))
		.map((c) => c.committedDate)
		.sort((a, b) => Date.parse(a) - Date.parse(b));
	const bots = reviewBots.map(low).filter(Boolean);
	const reviewBotReviews = timeline.filter((e) => e.kind === "review" && bots.some((b) => low(e.author).startsWith(b))).length;
	return {
		...(lastMeAt && { lastMeAt, lastMeKind: lastMe.kind === "review" ? "review" : "comment" }),
		...(lastOthersAt && { lastOthersAt }),
		...(ours.length && { ourLastCommitAt: ours.at(-1) }),
		...(reviewBotReviews && { reviewBotReviews }),
	};
}

/**
 * The newest review or comment by `me` after `after` (a time in ms), as `{ at, kind, state }`, or null.
 * `kind` is "review" for a review or an inline review comment and "comment" for the others. `state` is the
 * review's state in lower case, like "approved", when `reviews` lists it, and null otherwise.
 */
export function ownVisit(timeline, reviews, { me, after }) {
	const low = (v) => String(v ?? "").toLowerCase();
	if (!me || !Number.isFinite(after)) return null;
	const last = (timeline ?? []).filter((e) => FEEDBACK_KINDS.has(e.kind) && low(e.author) === low(me) && Date.parse(e.at) > after).at(-1);
	if (!last) return null;
	const kind = last.kind === "review" || last.kind === "thread_comment" ? "review" : "comment";
	const review = kind === "review" ? (reviews ?? []).filter((r) => low(r.author) === low(me) && Date.parse(r.submittedAt) <= Date.parse(last.at)).at(-1) : null;
	const state = typeof review?.state === "string" && review.state !== "PENDING" ? review.state.toLowerCase() : null;
	return { at: last.at, kind, state };
}

export const MAX_SENSITIVE_FILES = 5;

/** The first changed files of a PR entry that match the profile's `sensitivePaths`, with their full count. Empty without a match. */
export function sensitiveFacts(entry) {
	const files = (Array.isArray(entry?.sensitiveFiles) ? entry.sensitiveFiles : []).filter((f) => typeof f === "string" && f);
	return files.length ? { sensitiveFiles: files.slice(0, MAX_SENSITIVE_FILES), sensitiveFileCount: files.length } : {};
}

const sameLogin = (a, b) => typeof a === "string" && typeof b === "string" && !!a && a.toLowerCase() === b.toLowerCase();
const CO_AUTHOR = /^co-authored-by:\s*([^<\n]*?)\s*(?:<([^>\n]*)>)?\s*$/gim;
const NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;

/**
 * Whether only we wrote a PR, as `{ ours, reason }`. `reason` says which condition failed, or is null.
 * `node` is the PR's GraphQL node. `me` is the maintainer's login and `bot` the configured bot's, or null without one.
 * `garyFix` says that Gary recorded the PR in fixes.json. `ai` is the same as for `aiFacts`.
 * All of these must hold: the head branch is in the base repository, the author is `me` or `bot`, a PR by `bot`
 * is a recorded fix, the commit list is complete, and `me` or `bot` authored and committed every commit.
 * A co-author must be `me`, `bot` or an AI agent.
 */
export function oursAlone(node, { me, bot = null, garyFix = false, ai } = {}) {
	const no = (reason) => ({ ours: false, reason });
	const isUs = (login) => sameLogin(login, me) || sameLogin(login, bot);
	if (node.isCrossRepository !== false) return no("its head branch is not in this repository");
	const author = node.author?.login ?? "ghost";
	if (!isUs(author)) return no(`${author} opened it, who is neither the maintainer nor Gary's bot`);
	if (sameLogin(author, bot) && !sameLogin(author, me) && !garyFix) return no("the bot opened it, but Gary has no record of it as its own fix PR");
	const foreign = foreignCommit(node, isUs, ai);
	if (foreign) return no(foreign);
	return { ours: true, reason: null };
}

/**
 * The first commit of a PR that someone other than `isUs` authored, committed or co-authored, as a sentence, or null when
 * there is none. `node.allCommits` must hold the full commit list, otherwise the answer names that. An AI agent may co-author.
 */
export function foreignCommit(node, isUs, ai) {
	const commits = node.allCommits?.nodes ?? [];
	const total = node.allCommits?.totalCount;
	if (!commits.length || !Number.isInteger(total) || total > commits.length) return `its commit list is incomplete: ${commits.length} of ${total ?? "an unknown number of"} commits read`;
	const isAgent = agentMatcher(ai);
	// `ourIds` holds the names and emails of our own commits on this PR, so a trailer with the maintainer's real name counts as the maintainer's
	const ourIds = new Set();
	for (const { commit } of commits) {
		for (const person of [commit?.author, commit?.committer]) {
			if (isUs(person?.user?.login)) for (const id of [person.name, person.email]) if (id) ourIds.add(id.toLowerCase());
		}
	}
	for (const [i, { commit }] of commits.entries()) {
		const where = `commit ${i + 1} of ${commits.length}`;
		const by = (person) => person?.user?.login ?? person?.name ?? "an unknown account";
		if (!isUs(commit?.author?.user?.login)) return `${where} was authored by ${by(commit?.author)}`;
		if (!isUs(commit?.committer?.user?.login) && !committedByGitHub(commit)) return `${where} was committed by ${by(commit?.committer)}`;
		for (const m of (commit.message ?? "").matchAll(CO_AUTHOR)) {
			const [name, email] = [m[1] ?? "", m[2] ?? ""];
			const ours = isUs(name) || isUs(NOREPLY.exec(email)?.[1]) || ourIds.has(name.toLowerCase()) || ourIds.has(email.toLowerCase());
			if (!ours && !isAgent(name) && !isAgent(email.split("@")[0])) return `${where} names the co-author ${name || email}`;
		}
	}
	return null;
}

// GitHub is the committer of what its API and its web pages create. It signs those commits with its own key,
// which a pushed commit cannot carry. Their author is the account that asked for the commit
function committedByGitHub(commit) {
	const c = commit?.committer;
	return !c?.user && c?.name === "GitHub" && c?.email === "noreply@github.com" && commit.signature?.isValid === true && commit.signature.wasSignedByGitHub === true;
}

/** Whether a PR's snapshot entry lists sensitive files: true or false, or undefined without an entry. */
export function touchesSensitive(entry) {
	return entry ? (entry.sensitiveFiles ?? []).length > 0 : undefined;
}

/** Whether a PR's snapshot entry lists sensitive files and says that only we committed to the PR. */
export function sensitiveOurs(entry) {
	return touchesSensitive(entry) === true && (entry.sensitiveOurs === true || entry.facts?.sensitiveOurs === true);
}

/** The facts of a PR entry from the snapshot. */
export function prFacts(entry) {
	const approvedBy = (entry.reviewSummary ?? []).filter((r) => r.state === "approved").map((r) => r.author);
	const changesRequestedBy = (entry.reviewSummary ?? []).filter((r) => r.state === "changes_requested").map((r) => r.author);
	const files = entry.files ?? [];
	const openThreadCount = entry.openThreadCount ?? 0;
	const ciGreen = entry.ci === "passing";
	return {
		ciGreen,
		...(entry.ciOptionalFailing?.length && { ciOptionalFailing: entry.ciOptionalFailing }),
		// Only a complete file list can prove a PR changes dependencies only
		dependencyOnly: files.length > 0 && files.length >= (entry.changedFileCount ?? files.length) && files.every(isDependencyFile),
		touchesSensitive: touchesSensitive(entry),
		...sensitiveFacts(entry),
		openThreadCount,
		approvedBy,
		changesRequestedBy,
		isClean: entry.mergeable === "MERGEABLE" && ciGreen && openThreadCount === 0 && changesRequestedBy.length === 0,
	};
}

const LOCK_FILES = new Set([
	"package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "cargo.lock", "go.sum",
	"gemfile.lock", "composer.lock", "pipfile.lock", "poetry.lock", "uv.lock", "packages.lock.json", "flake.lock", ".terraform.lock.hcl",
]);

/**
 * The size of a PR from its GraphQL node: `changedFiles`, and `changedLines` as additions plus deletions without lock files.
 * GitHub's API does not say which files are generated, so only lock files are left out. Lock files beyond the first
 * page of files still count.
 */
export function sizeFacts(node) {
	const files = node.files?.nodes ?? [];
	const lockLines = files.filter((f) => LOCK_FILES.has(basename(f.path ?? "").toLowerCase())).reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
	return {
		changedFiles: node.files?.totalCount ?? files.length,
		changedLines: Math.max(0, (node.additions ?? 0) + (node.deletions ?? 0) - lockLines),
	};
}

const AI_NAME = /\b(claude|copilot)\b/i;
const AI_BRANCH = /^(claude|copilot)\//i;

/** A test for a name or login that says whether it names an AI agent or a bot. `ai` is the same as for `aiFacts`. */
function agentMatcher(ai = {}) {
	const logins = new Set((ai.logins ?? []).map((l) => l.toLowerCase()));
	const names = (ai.names ?? []).map((n) => n.toLowerCase()).filter(Boolean);
	return (text) => {
		const v = (text ?? "").trim();
		if (!v) return false;
		const low = v.toLowerCase();
		return AI_NAME.test(v) || low.endsWith("[bot]") || logins.has(low) || names.some((n) => low.includes(n));
	};
}

/**
 * Whether an AI agent or a bot wrote the PR, from its commits and head branch. `ai.logins` are the configured bot
 * and the profile's botLogins, `ai.names` the profile's aiAuthors, matched as case-insensitive parts of a name or login.
 * `ai.own` is the configured bot. Its commits on a PR someone else opened are ours, from a take-over or a format run.
 * They do not make the PR AI-written, and `ourCommits` counts them.
 */
export function aiFacts(node, ai = { logins: [], names: [] }) {
	const isAgent = agentMatcher(ai);
	const signals = new Set();
	if (AI_BRANCH.test(node.headRefName ?? "")) signals.add(`branch ${node.headRefName}`);
	const own = (ai.own ?? "").toLowerCase();
	const foreign = !!own && (node.author?.login ?? "").toLowerCase() !== own;
	let ourCommits = 0;
	for (const { commit } of node.allCommits?.nodes ?? []) {
		if (foreign && (commit?.author?.user?.login ?? "").toLowerCase() === own) {
			ourCommits++;
			continue;
		}
		for (const [role, person] of [["author", commit?.author], ["committer", commit?.committer]]) {
			const who = person?.user?.login ?? person?.name;
			if (isAgent(person?.user?.login) || isAgent(person?.name)) signals.add(`commit ${role} ${who}`);
		}
		for (const m of (commit?.message ?? "").matchAll(CO_AUTHOR)) {
			if (isAgent(m[1]) || isAgent(m[2]?.split("@")[0])) signals.add(`co-author ${m[1] || m[2]}`);
		}
	}
	return { aiAuthored: signals.size > 0, aiSignals: [...signals].slice(0, 10), ...(ourCommits && { ourCommits }) };
}

/** The facts of an issue or discussion entry from the snapshot. */
export function issueFacts(entry, timeline) {
	return {
		hasClosingPr: (entry.closingPrs ?? []).some((p) => p.state !== "closed"),
		isAnswered: entry.isAnswered === true,
		...(typeof entry.category === "string" && { category: entry.category }),
		authorIsUs: timeline.find((e) => e.kind === "opened")?.side === "us",
	};
}

/**
 * The earliest due date GitHub attaches to an issue or PR: its milestone's `dueOn`, or a date field of one of its
 * project items whose name is in `fields`, compared without case. Returns `{ dueAt: "YYYY-MM-DD", dueSource }` or `{}`.
 * Thread text never counts.
 */
export function dueFacts(node, fields = PROFILE_DEFAULTS.dueDateFields) {
	const names = new Set(fields.map((f) => f.trim().toLowerCase()));
	const found = [];
	const m = node.milestone;
	if (m?.dueOn && /^\d{4}-\d{2}-\d{2}/.test(m.dueOn)) found.push({ dueAt: m.dueOn.slice(0, 10), dueSource: `milestone ${m.title ?? ""}`.trim() });
	for (const item of node.projectItems?.nodes ?? []) {
		for (const v of item?.fieldValues?.nodes ?? []) {
			const name = v?.field?.name;
			if (typeof v?.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v.date) || typeof name !== "string" || !names.has(name.trim().toLowerCase())) continue;
			found.push({ dueAt: v.date.slice(0, 10), dueSource: `project "${item.project?.title ?? "?"}" · ${name}` });
		}
	}
	found.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
	return found[0] ?? {};
}

const prUnready = (n) =>
	n.isDraft === true || n.mergeable === "CONFLICTING" || n.reviewDecision === "CHANGES_REQUESTED"
	|| ciOf(n) === "failing";

/**
 * Finds series of related open items and returns a Map from item id to `{ id, title, position, size, unready? }`.
 * `unready` counts the PRs of the series that cannot be merged yet: a draft, conflicts, failing CI or requested changes.
 * Two PRs are stacked when one's base branch is the other's head branch inside the repo. An issue is in a series
 * with its parent issue. A PR that closes an issue of such a series joins it. Wording is never read.
 * `prs` and `issues` are the snapshot's raw nodes.
 */
export function seriesOf(prs = [], issues = []) {
	const nodes = new Map();
	for (const n of prs) nodes.set(`pr-${n.number}`, { id: `pr-${n.number}`, number: n.number, title: n.title ?? "", unready: prUnready(n) });
	for (const n of issues) nodes.set(`issue-${n.number}`, { id: `issue-${n.number}`, number: n.number, title: n.title ?? "" });
	// Edges point from the earlier item to the later one
	const edges = [];
	const byHead = new Map(prs.filter((p) => !p.isCrossRepository && p.headRefName).map((p) => [p.headRefName, `pr-${p.number}`]));
	for (const p of prs) {
		const below = byHead.get(p.baseRefName);
		if (below && below !== `pr-${p.number}`) edges.push([below, `pr-${p.number}`]);
	}
	for (const i of issues) {
		const parent = i.parent?.number;
		if (parent && nodes.has(`issue-${parent}`)) edges.push([`issue-${parent}`, `issue-${i.number}`]);
	}
	const linked = new Set(edges.flat());
	for (const p of prs) {
		for (const c of p.closingIssuesReferences?.nodes ?? []) {
			const issue = `issue-${c?.number}`;
			if (linked.has(issue)) edges.push([issue, `pr-${p.number}`]);
		}
	}
	// Group the linked items, then order each group so every item comes after the ones it builds on
	const root = new Map();
	const find = (x) => {
		while (root.get(x) !== x) x = root.get(x);
		return x;
	};
	for (const id of new Set(edges.flat())) root.set(id, id);
	for (const [a, b] of edges) root.set(find(a), find(b));
	const groups = new Map();
	for (const id of root.keys()) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
	const out = new Map();
	const byNumber = (a, b) => nodes.get(a).number - nodes.get(b).number || a.localeCompare(b);
	for (const members of groups.values()) {
		if (members.length < 2) continue;
		const inside = new Set(members);
		const before = new Map(members.map((id) => [id, 0]));
		for (const [a, b] of edges) if (inside.has(a) && inside.has(b)) before.set(b, before.get(b) + 1);
		const order = [];
		const ready = members.filter((id) => before.get(id) === 0).sort(byNumber);
		while (ready.length) {
			const id = ready.shift();
			order.push(id);
			for (const [a, b] of edges) {
				if (a !== id || !inside.has(b)) continue;
				before.set(b, before.get(b) - 1);
				if (before.get(b) > 0) continue;
				ready.push(b);
				ready.sort(byNumber);
			}
		}
		// A cycle leaves items out of the order. They follow by number
		for (const id of members.sort(byNumber)) if (!order.includes(id)) order.push(id);
		const first = nodes.get(order[0]);
		const unready = order.filter((id) => nodes.get(id).unready).length;
		order.forEach((id, i) => out.set(id, { id: first.id, title: first.title, position: i + 1, size: order.length, ...(unready && { unready }) }));
	}
	return out;
}
