// The one automatic first review on a contributor's PR: its record in <state>/auto-reviews.json, the rules that
// decide whether a PR may get one, the check of the review doc, and the format offer. See "Automatic first review" in SPEC.md.
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join, matchesGlob } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readJson, writeAtomic } from "./board-store.mjs";
import { instanceDir, instanceName } from "./config.mjs";
import { commentBody, isObject } from "./routes.mjs";
import { checkSuggestion } from "./validate-item.mjs";

export const autoReviewsFile = (instance = instanceName()) => join(instanceDir(instance), "state", "auto-reviews.json");

/** The records by item id: `{ <itemId>: { repo, number, author, reviews: [...], offer, reRequestQueued } }`. */
export async function readAutoReviews(instance = instanceName()) {
	return (await readJson(autoReviewsFile(instance))) ?? {};
}

const LOCK_STALE_MS = 10000;
const LOCK_TRIES = 200;

/**
 * Changes the record of one PR: `change` gets the stored record or null and returns the new one.
 * A lock file keeps two processes from writing at once, so a post for one PR never drops the record of another.
 */
export async function updateAutoReview(itemId, change, instance = instanceName()) {
	const file = autoReviewsFile(instance);
	const lock = file + ".lock";
	await mkdir(dirname(file), { recursive: true });
	for (let i = 0; ; i++) {
		try {
			await (await open(lock, "wx")).close();
			break;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			const age = Date.now() - ((await stat(lock).catch(() => null))?.mtimeMs ?? Date.now());
			// A lock this old belongs to a process that died
			if (age > LOCK_STALE_MS) await unlink(lock).catch(() => {});
			else if (i >= LOCK_TRIES) throw new Error(`${file} stays locked by another process`);
			else await sleep(25);
		}
	}
	try {
		const all = await readAutoReviews(instance);
		const next = change(all[itemId] ?? null);
		await writeAtomic(file, { ...all, [itemId]: next });
		return next;
	} finally {
		await unlink(lock).catch(() => {});
	}
}

export const lastReview = (record) => record?.reviews?.at(-1) ?? null;

export const POSITIVE_REACTIONS = ["THUMBS_UP", "HEART", "HOORAY", "ROCKET"];
export const CERTAIN_SEVERITIES = ["blocker", "major", "minor"];
const MAX_FINDINGS = 20;
const MAX_COMMENTS = 50;
const MAX_SUMMARY = 6000;
export const MAX_EVIDENCE = 400;
// Wording of a guess. A certain finding states a fact and shows the case
const HEDGES = /\b(i think|i believe|i guess|i suspect|i am not sure|i'm not sure|not sure|maybe|perhaps|probably|imo|in my opinion|it seems|seems like|seems to)\b/i;

const isString = (v) => typeof v === "string" && v.trim().length > 0;
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** Why a finding may not go out in an automatic review, or null. `certain: true` and the concrete case in `evidence` are required. */
export function certainProblem(f) {
	if (!isObject(f)) return "must be an object";
	if (f.certain !== true) return "is not marked certain: true. Only findings the review is certain about go out without a click";
	if (!isString(f.evidence)) return "has no evidence, the concrete case that shows the problem in one sentence";
	if (f.evidence.length > MAX_EVIDENCE) return `has an evidence longer than ${MAX_EVIDENCE} characters`;
	if (!CERTAIN_SEVERITIES.includes(f.severity)) return `has severity "${f.severity}". A question or an idea stays on the board`;
	if (!isString(f.text)) return "has no text";
	if (/\?\s*$/.test(f.text.trim())) return "is phrased as a question";
	const hedge = HEDGES.exec(`${f.text} ${f.evidence}`);
	if (hedge) return `is hedged with "${hedge[0]}"`;
	return null;
}

/**
 * The problems of an automatic review doc `{ summary, findings, comments }`. An empty list means it may be posted.
 * Every finding is certain and shows its case, every inline comment belongs to one of the findings by `finding`,
 * its index. A doc without findings has no summary and no comments: it only carries the format offer.
 */
export function validateAutoReview(doc) {
	const errors = [];
	if (!isObject(doc)) return ["the review must be a JSON object { summary, findings, comments }"];
	for (const key of Object.keys(doc)) if (!["summary", "findings", "comments"].includes(key)) errors.push(`unknown field "${key}"`);
	const findings = doc.findings ?? [];
	const comments = doc.comments ?? [];
	if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) return [...errors, `findings must be a list of at most ${MAX_FINDINGS}`];
	if (!Array.isArray(comments) || comments.length > MAX_COMMENTS) return [...errors, `comments must be a list of at most ${MAX_COMMENTS}`];
	if (doc.summary !== undefined && typeof doc.summary !== "string") errors.push("summary must be a string");
	const summary = typeof doc.summary === "string" ? doc.summary.trim() : "";
	if (summary.length > MAX_SUMMARY) errors.push(`summary is longer than ${MAX_SUMMARY} characters`);
	findings.forEach((f, i) => {
		const problem = certainProblem(f);
		if (problem) errors.push(`findings[${i}] ${problem}`);
		else for (const key of Object.keys(f)) if (!["severity", "text", "ref", "certain", "evidence"].includes(key)) errors.push(`findings[${i}] has the unknown field "${key}"`);
	});
	if (!findings.length) {
		if (summary) errors.push("a review without findings has no summary: it only carries the format offer");
		if (comments.length) errors.push("a review without findings has no inline comments");
	} else {
		if (!summary) errors.push("summary is required with findings: it says what is wrong");
		const hedge = HEDGES.exec(summary);
		if (hedge) errors.push(`summary is hedged with "${hedge[0]}"`);
	}
	const err = (_code, message) => errors.push(message);
	comments.forEach((c, i) => {
		const where = `comments[${i}]`;
		if (!isObject(c) || !isString(c.path) || !Number.isInteger(c.line) || !isString(c.text)) return errors.push(`${where} needs path, line and text`);
		for (const key of Object.keys(c)) if (!["id", "path", "line", "startLine", "text", "original", "suggestion", "diffHunk", "finding"].includes(key)) errors.push(`${where} has the unknown field "${key}"`);
		if (!Number.isInteger(c.finding) || c.finding < 0 || c.finding >= findings.length) errors.push(`${where}.finding must be the index of the certain finding it belongs to`);
		const hedge = HEDGES.exec(c.text);
		if (hedge) errors.push(`${where} is hedged with "${hedge[0]}"`);
		checkSuggestion(c, where, err, err);
	});
	return errors;
}

/** The inline comments as the `review` action takes them. */
export function actionComments(comments = []) {
	return comments.map((c) => ({
		path: c.path,
		line: c.line,
		...(c.startLine !== undefined && { startLine: c.startLine }),
		text: commentBody(c),
	}));
}

export const TEMPLATE_DEFAULTS = {
	"auto-review-closing": "A maintainer will review this PR after these are addressed.",
	"format-offer": "The project's formatter would change {files} in this PR. I can push that as one commit to your branch. React to this review with a thumbs-up or reply here, and I will do it.",
	"format-command": "The project's formatter would change {files} in this PR. Please run `{command}` and push the result.",
};

/** A canned text from the profile's templates/<name>.md without its leading HTML comment, or the core default. */
export async function templateText(profileDir, name) {
	let text = "";
	try {
		text = (await readFile(join(profileDir, "templates", `${name}.md`), "utf8")).replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, "").trim();
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	return text || TEMPLATE_DEFAULTS[name];
}

/**
 * What the review says about formatting: `{ kind: "push" }` offers the commit, `{ kind: "command" }` names the
 * project's command, null says nothing. One offer per PR, and none without the autofix check finding changes.
 */
export function offerKind({ autofix, record, maintainerCanModify, formatCommand }) {
	if (autofix?.changes !== true || record?.offer) return null;
	if (maintainerCanModify === true) return "push";
	return isString(formatCommand) ? "command" : null;
}

/** The body of the review: the summary, the paragraph about formatting, and the fixed closing sentence after findings. */
export function composeBody({ summary, hasFindings, offer, autofix, formatCommand, templates }) {
	const files = `${autofix?.files} file${autofix?.files === 1 ? "" : "s"}`;
	const fill = (text) => text.replaceAll("{files}", files).replaceAll("{command}", formatCommand ?? "");
	const parts = [];
	if (hasFindings) parts.push(summary.trim());
	if (offer === "push") parts.push(fill(templates["format-offer"]));
	if (offer === "command") parts.push(fill(templates["format-command"]));
	if (hasFindings) parts.push(templates["auto-review-closing"]);
	return parts.join("\n\n");
}

const REVIEW_SLACK_MS = 10000;
// GitHub's author associations of people with a role in the repository. None of them is an outside contributor
const INSIDERS = ["OWNER", "MEMBER", "COLLABORATOR"];

/**
 * When a maintainer last commented or reviewed on the PR, or null. Our own automatic reviews do not count, also when
 * they went out under the maintainer's login: `ownReviewUrls` names them, and the entry's `reviews` give their times.
 */
export function maintainerJoinedAt(entry, { maintainers, ownReviewUrls = [] }) {
	const ownTimes = (entry.reviews ?? []).filter((r) => ownReviewUrls.includes(r.url)).map((r) => Date.parse(r.submittedAt));
	const isOwn = (e) => (e.kind === "review" || e.kind === "thread_comment") && ownTimes.some((t) => Math.abs(Date.parse(e.at) - t) <= REVIEW_SLACK_MS);
	const logins = maintainers.map((l) => l.toLowerCase());
	return (entry.facts?.timeline ?? []).filter((e) => e.kind !== "opened" && logins.includes(String(e.author).toLowerCase()) && !isOwn(e)).at(-1)?.at ?? null;
}

/** When the PR's author last asked for another review of ours after `since`, or null. */
export function reRequestedAt(entry, since) {
	const t = Date.parse(since ?? "");
	return (entry.facts?.reReviewRequests ?? []).filter((r) => same(r.by, entry.author) && Date.parse(r.at) > t).at(-1)?.at ?? null;
}

/**
 * Why this PR gets no automatic review now, as `{ code, message }`, or null when it may get one.
 * `entry` is the PR's fresh snapshot entry, `settings` comes from autoReviewOf, `record` is its entry in auto-reviews.json.
 */
export function refusal({ entry, sha, settings, profile, maintainers, writeLogin, record, runCount }) {
	const no = (code, message) => ({ code, message });
	if (!settings.enabled) return no("off", `The automatic review is off${settings.reason ? `: ${settings.reason}` : ""}.`);
	if (entry.githubState !== "open") return no("not-open", `PR #${entry.number} is ${entry.githubState}.`);
	if (entry.isDraft) return no("draft", `PR #${entry.number} is a draft.`);
	if (entry.garyFix) return no("author", `PR #${entry.number} is a fix PR of Gary.`);
	if (entry.authorType !== "contributor") return no("author", `PR #${entry.number} is by a ${entry.authorType}. Only PRs by outside contributors get an automatic review.`);
	if (INSIDERS.includes(entry.authorAssociation)) return no("author", `PR #${entry.number} is by a ${entry.authorAssociation.toLowerCase()} of the repository. Only PRs by outside contributors get an automatic review.`);
	if (entry.facts?.aiAuthored) return no("ai-authored", `PR #${entry.number} looks written by an AI agent or a bot: ${(entry.facts.aiSignals ?? []).join(", ")}.`);
	if ((entry.sensitiveFiles ?? []).length) return no("sensitive", `PR #${entry.number} touches sensitive paths: ${entry.sensitiveFiles.join(", ")}.`);
	// Only a complete file list can prove what kind of PR this is
	if (!(entry.files ?? []).length || entry.files.length < (entry.changedFileCount ?? entry.files.length)) return no("kind", `PR #${entry.number} changes more files than the snapshot lists, so its kind is unknown.`);
	const kind = settings.kinds.find((k) => entry.files.every((p) => (profile.autoReviewPaths?.[k] ?? []).some((g) => matchesGlob(p, g))));
	if (!kind) return no("kind", `PR #${entry.number} is not one of the kinds ${settings.kinds.join(", ")}: it touches files outside the profile's autoReviewPaths.`);
	if (sha !== undefined && entry.headSha !== sha) return no("head-moved", `The head of PR #${entry.number} is ${entry.headSha}, not the reviewed ${sha}.`);
	if (entry.facts?.timelineTruncated) return no("timeline-truncated", `The thread of PR #${entry.number} is longer than the snapshot reads, so nothing proves that no maintainer joined it.`);
	const joined = maintainerJoinedAt(entry, { maintainers, ownReviewUrls: (record?.reviews ?? []).map((r) => r.url) });
	if (joined) return no("maintainer-active", `A maintainer commented or reviewed on PR #${entry.number} at ${joined}. The thread is his.`);
	const insider = (entry.comments ?? []).find((c) => INSIDERS.includes(c.authorAssociation) && c.authorType !== "bot" && !same(c.author, writeLogin));
	if (insider) return no("maintainer-active", `${insider.author}, a ${insider.authorAssociation.toLowerCase()} of the repository, commented on PR #${entry.number}. The thread is theirs.`);
	const last = lastReview(record);
	if (last && !reRequestedAt(entry, last.at)) return no("already-reviewed", `PR #${entry.number} got its automatic review at ${last.at}. Another one needs the author to re-request it.`);
	if (runCount >= settings.maxPerRun) return no("run-limit", `This run already posted ${runCount} automatic review${runCount === 1 ? "" : "s"}, the limit in autoReview.maxPerRun.`);
	return null;
}

/**
 * What the PR's author answered to an open format offer, from the offer's fresh facts:
 * `{ accepted: true }` for a positive reaction of his on the review, and `replies`, his comments after the offer
 * that nobody judged yet. Reactions and comments of anyone else never count.
 */
export function offerAnswer(offer, facts, author) {
	const accepted = (facts?.reactions ?? []).some((r) => same(r.user, author) && POSITIVE_REACTIONS.includes(r.content));
	const judged = offer?.judged ?? [];
	const since = Date.parse(offer?.at ?? "");
	const replies = (facts?.comments ?? []).filter((c) => same(c.author, author) && Date.parse(c.at) > since && !judged.includes(c.at));
	return { accepted, replies };
}

const WATCH_DAYS = 14;
export const MAX_WATCHED = 20;

/** The PRs the queue watcher polls, newest review first, at most 20: an open push offer, or a review of the last 14 days. */
export function watchedRecords(records, now = Date.now()) {
	return Object.entries(records)
		.map(([itemId, record]) => ({ itemId, record, last: lastReview(record) }))
		.filter(({ record, last }) => last && ((record.offer?.state === "open" && record.offer.kind === "push") || now - Date.parse(last.at) < WATCH_DAYS * 24 * 60 * 60 * 1000))
		.sort((a, b) => String(b.last.at).localeCompare(String(a.last.at)))
		.slice(0, MAX_WATCHED);
}

/**
 * The events the watcher prints for one polled PR: `offer-accepted`, `offer-reply` with the reply's `at`,
 * and `re-requested` with the request's `at`. `facts` is the fresh answer of fetchOfferFacts.
 */
export function watchEvents(record, facts) {
	const out = [];
	if (facts.state !== "open") return out;
	if (record.offer?.state === "open" && record.offer.kind === "push") {
		const answer = offerAnswer(record.offer, facts, record.author);
		if (answer.accepted) out.push({ event: "offer-accepted" });
		else for (const r of answer.replies) out.push({ event: "offer-reply", at: r.at });
	}
	const last = lastReview(record);
	const again = (facts.reReviewRequests ?? []).filter((r) => same(r.by, record.author) && Date.parse(r.at) > Date.parse(last.at)).at(-1)?.at;
	if (again && again !== record.reRequestQueued) out.push({ event: "re-requested", at: again });
	return out;
}

/**
 * What the board shows on a PR item with an automatic review, or null:
 * `{ at, url, sha, event, count, asked, offer, waiting, changed }`. `waiting` is true while the contributor has
 * the next move, and `changed` lists what happened since: pushed, replied, re-requested, formatted, maintainer.
 * `snap` is the PR's snapshot entry, which carries `headSha` and `autoReview: { lastAuthorAt, maintainerAt, reRequestedAt }`.
 */
export function autoReviewState(item, record, snap) {
	const last = lastReview(record);
	if (!last) return null;
	const at = Date.parse(last.at);
	const later = (iso) => Date.parse(iso ?? "") > at;
	const facts = snap?.autoReview ?? {};
	const offer = record.offer ?? null;
	const changed = [];
	// A head our own format commit made is still the contributor's state
	const formatted = item?.pushed?.action === "format" && !!snap?.headSha && item.pushed.sha === snap.headSha;
	if (snap?.headSha && snap.headSha !== last.sha && !formatted) changed.push("pushed");
	if (formatted && last.event === "comment") changed.push("formatted");
	// The reply that accepted the offer is no new turn of the contributor
	if (later(facts.lastAuthorAt) && facts.lastAuthorAt !== offer?.replyAt) changed.push("replied");
	if (later(facts.reRequestedAt)) changed.push("re-requested");
	if (later(facts.maintainerAt)) changed.push("maintainer");
	return {
		at: last.at,
		url: last.url,
		sha: last.sha,
		event: last.event,
		count: record.reviews.length,
		asked: (last.findings ?? []).map((f) => f.text),
		...(offer && { offer: { kind: offer.kind, state: offer.state, at: offer.at } }),
		waiting: changed.length === 0,
		changed,
	};
}
