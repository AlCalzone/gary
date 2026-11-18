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
		openThreadCount,
		approvedBy,
		changesRequestedBy,
		isClean: entry.mergeable === "MERGEABLE" && ciGreen && openThreadCount === 0 && changesRequestedBy.length === 0,
	};
}

/** The facts of an issue or discussion entry from the snapshot. */
export function issueFacts(entry, timeline) {
	return {
		hasClosingPr: (entry.closingPrs ?? []).some((p) => p.state !== "closed"),
		isAnswered: entry.isAnswered === true,
		authorIsUs: timeline.find((e) => e.kind === "opened")?.side === "us",
	};
}
