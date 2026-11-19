// Mechanical facts about an item, computed by code so no model has to read them out of a thread:
// who spoke when, who we wait on, and for PRs whether it is clean and dependency-only.
import { basename } from "node:path";
import { AUTOMATED_TEXT_LIMIT } from "./config.mjs";

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

export const MAX_SENSITIVE_FILES = 5;

/** The first changed files of a PR entry that match the profile's `sensitivePaths`, with their full count. Empty without a match. */
export function sensitiveFacts(entry) {
	const files = (Array.isArray(entry?.sensitiveFiles) ? entry.sensitiveFiles : []).filter((f) => typeof f === "string" && f);
	return files.length ? { sensitiveFiles: files.slice(0, MAX_SENSITIVE_FILES), sensitiveFileCount: files.length } : {};
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
		// Only a complete file list can prove a PR changes dependencies only
		dependencyOnly: files.length > 0 && files.length >= (entry.changedFileCount ?? files.length) && files.every(isDependencyFile),
		touchesSensitive: (entry.sensitiveFiles ?? []).length > 0,
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

/**
 * Whether an AI agent or a bot wrote the PR, from its commits and head branch. `ai.logins` are the configured bot
 * and the profile's botLogins, `ai.names` the profile's aiAuthors, matched as case-insensitive parts of a name or login.
 * `ai.own` is the configured bot. Its commits on a PR someone else opened are ours, from a take-over or a format run.
 * They do not make the PR AI-written, and `ourCommits` counts them.
 */
export function aiFacts(node, ai = { logins: [], names: [] }) {
	const logins = new Set((ai.logins ?? []).map((l) => l.toLowerCase()));
	const names = (ai.names ?? []).map((n) => n.toLowerCase()).filter(Boolean);
	const isAgent = (text) => {
		const v = (text ?? "").trim();
		if (!v) return false;
		const low = v.toLowerCase();
		return AI_NAME.test(v) || low.endsWith("[bot]") || logins.has(low) || names.some((n) => low.includes(n));
	};
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
		for (const m of (commit?.message ?? "").matchAll(/^co-authored-by:\s*([^<\n]*?)\s*(?:<([^>\n]*)>)?\s*$/gim)) {
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
