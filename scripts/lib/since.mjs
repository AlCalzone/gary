// What happened on an item since the maintainer's last choice on it, for the "Since your last choice" timeline in the
// item dialog. The snapshot stores a compact activity list per item, the board server picks the anchor and groups
// the events after it. See "Since your last choice" in SPEC.md.
import { sideOf } from "./facts.mjs";
import { asksMe } from "./text.mjs";

export const MAX_ACTIVITY = 60;
export const MAX_OPEN_THREADS = 50;
export const MAX_CI = 10;

// The status events the snapshot reads per PR or issue. Discussions have no timeline items in the API
export const STATUS_EVENTS = {
	ReadyForReviewEvent: "ready",
	ConvertToDraftEvent: "draft",
	HeadRefForcePushedEvent: "force_push",
	MergedEvent: "merged",
	ClosedEvent: "closed",
	ReopenedEvent: "reopened",
	LabeledEvent: "labeled",
	UnlabeledEvent: "unlabeled",
};

/**
 * The compact activity of one item for the snapshot baseline: `{ events, openThreads, ci }`.
 * `events` are `{ at, by, side, kind }`, newest kept when there are more than `MAX_ACTIVITY`. A review carries `state`,
 * a commit `sha`, a label event `label`, and a comment by someone outside that asks the maintainer something `asks: true`.
 * `openThreads` are the unresolved review threads as `{ by, at }` of their first comment.
 * `ci` lists the CI results the snapshots saw as `{ at, state }`, one entry per change. `before` is the item's
 * activity in the previous baseline, `ci` the current rollup and `at` the snapshot time.
 */
export function activityOf(kind, node, ctx, { before, ci, at } = {}) {
	const side = (author, body = "") => sideOf(author, body, ctx);
	const login = (author) => author?.login ?? "ghost";
	const events = [];
	const comment = (c, k) => {
		if (!c?.createdAt) return;
		const s = side(c.author, c.body);
		events.push({ at: c.createdAt, by: login(c.author), side: s, kind: k, ...(s === "them" && asksMe(c.body, ctx.me) && { asks: true }) });
	};
	for (const c of (node.timelineComments ?? node.comments)?.nodes ?? []) {
		comment(c, "comment");
		for (const r of c.replies?.nodes ?? []) comment(r, "reply");
	}
	const openThreads = [];
	if (kind === "pr") {
		for (const r of node.allReviews?.nodes ?? []) {
			if (r.submittedAt && r.state !== "PENDING") events.push({ at: r.submittedAt, by: login(r.author), side: side(r.author), kind: "review", state: String(r.state).toLowerCase() });
		}
		for (const t of node.reviewThreads?.nodes ?? []) {
			const first = t.comments?.nodes?.[0];
			// The first comment of a thread is part of its review
			for (const c of (t.allComments ?? t.comments)?.nodes ?? []) if (!(c.createdAt === first?.createdAt && login(c.author) === login(first?.author))) comment(c, "thread_reply");
			if (!t.isResolved && first?.createdAt) openThreads.push({ by: login(first.author), at: first.createdAt });
		}
		for (const { commit: c } of node.recentCommits?.nodes ?? []) {
			const who = c?.author?.user ?? (c?.author?.name ? { login: c.author.name } : null);
			if (c?.committedDate) events.push({ at: c.committedDate, by: login(who), side: side(who), kind: "commit", ...(c.oid && { sha: c.oid }) });
		}
	}
	for (const e of node.statusEvents?.nodes ?? []) {
		const k = STATUS_EVENTS[e?.__typename];
		if (k && e.createdAt) events.push({ at: e.createdAt, by: login(e.actor), side: side(e.actor), kind: k, ...(e.label?.name && { label: e.label.name }) });
	}
	events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	const seen = Array.isArray(before?.ci) ? before.ci.filter((c) => c?.at && c?.state) : [];
	if ((ci === "passing" || ci === "failing") && seen.at(-1)?.state !== ci && at) seen.push({ at, state: ci });
	return { events: events.slice(-MAX_ACTIVITY), openThreads: openThreads.slice(-MAX_OPEN_THREADS), ci: seen.slice(-MAX_CI) };
}

// How a choice is named in the heading, by route type or action
const CHOICE_NAMES = {
	reply: "Reply", request_logs: "Ask for a log", close: "Close", reopen: "Reopen", merge: "Merge", review: "Review",
	address_review: "Address review", follow_up: "Implement", take_over: "Take over", revise: "Change", drive: "Drive",
	format: "Format", move: "Move", chore: "Chore", open: "Open on GitHub", escalate: "Escalate",
	reanalyze: "Analyze again", full_review: "Full review", start_fix: "Start fix", snooze: "Snooze", dismiss: "Snooze until new activity", got_it: "Got it",
};
const choiceName = (type) => CHOICE_NAMES[type] ?? String(type ?? "").replace(/_/g, " ");

// The jobs that push to a PR, named for the commits they made
export const PUSH_JOBS = { take_over: "Take over", revise: "Change", address_review: "Address review", drive: "Drive round", format: "Format" };

const OWN_REVIEWS = { approved: "Approved on GitHub", changes_requested: "Requested changes on GitHub" };

/** Whether an action doc records a click of the maintainer. Code writes its jobs with `params.by`. */
const isChoice = (a) => a && typeof a.createdAt === "string" && Number.isFinite(Date.parse(a.createdAt)) && !(a.params && typeof a.params === "object" && a.params.by !== undefined);

/**
 * The anchor of the timeline for one item: `{ at, kind: "choice", label }` for the maintainer's newest choice, else
 * `{ at, kind: "opened" }` for the first time the maintainer opened the dialog, else null. `actions` are the item's action docs.
 * A choice is a click recorded as an action doc, `item.handled` for a prefill the maintainer used, or a review or comment
 * that `me` wrote on GitHub, taken from the item's `activity`.
 */
export function sinceAnchor(item, actions = [], { activity, me } = {}) {
	const choices = [];
	for (const e of me && Array.isArray(activity?.events) ? activity.events : []) {
		if (!e || !Number.isFinite(Date.parse(e.at)) || String(e.by ?? "").toLowerCase() !== String(me).toLowerCase()) continue;
		if (e.kind === "review") choices.push({ at: e.at, label: OWN_REVIEWS[e.state] ?? "Reviewed on GitHub", rank: 0 });
		else if (["comment", "reply", "thread_reply"].includes(e.kind)) choices.push({ at: e.at, label: "Commented on GitHub", rank: 0 });
	}
	for (const a of actions) {
		if (!isChoice(a)) continue;
		const label = a.action === "dismiss_route" ? `Dismissed ${choiceName(a.route)}` : choiceName(a.route ?? a.action);
		// A route click outranks the job it queued at the same moment
		choices.push({ at: a.createdAt, label, rank: typeof a.routeId === "string" ? 1 : 0 });
	}
	const h = item?.handled;
	if (h && typeof h.at === "string" && Number.isFinite(Date.parse(h.at))) choices.push({ at: h.at, label: choiceName(h.routeType), rank: 1 });
	choices.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.rank - b.rank);
	const last = choices.at(-1);
	if (last) return { at: last.at, kind: "choice", label: last.label };
	if (typeof item?.seenAt === "string" && Number.isFinite(Date.parse(item.seenAt))) return { at: item.seenAt, kind: "opened" };
	return null;
}

const COMMIT_SHA = /\/commit\/([0-9a-f]{7,40})\b/i;

// The commit SHAs Gary's push jobs on the item made, each with the job's name
function jobCommits(actions) {
	const out = [];
	for (const a of actions) {
		const job = PUSH_JOBS[a?.action];
		if (!job) continue;
		const urls = [...(Array.isArray(a.resultParts?.commits) ? a.resultParts.commits : []), a.result];
		for (const u of urls) {
			const m = COMMIT_SHA.exec(typeof u === "string" ? u : "");
			if (m) out.push({ sha: m[1].toLowerCase(), job });
		}
	}
	return out;
}

const plural = (n, word) => `${n} ${n === 1 ? word : word.replace(/y$/, "ie") + "s"}`;
const times = (n) => (n === 1 ? "once" : `${n} times`);
const REVIEW_WORDS = { approved: "approved", changes_requested: "requested changes" };
const STATUS_WORDS = { ready: "marked it ready for review", draft: "converted it to draft", merged: "merged it", closed: "closed it", reopened: "reopened it" };
const ANSWERS = new Set(["comment", "reply", "thread_reply", "review"]);
const STATUS_ICONS = { ready: "pr", draft: "prDraft", merged: "prMerged", closed: "prClosed", reopened: "pr" };

/**
 * The timeline after `anchor`: `{ anchor, groups: [{ at, kind, icon, text, note? }] }`, oldest group first, or null
 * without activity or anchor. Events group by actor and kind. `note` calls out what is still open.
 * `me` is the maintainer's login, `bot` Gary's bot login. `actions` are the item's action docs.
 */
export function sinceSummary(activity, anchor, { me, bot, actions = [] } = {}) {
	if (!anchor || !activity || !Array.isArray(activity.events)) return null;
	const low = (v) => String(v ?? "").toLowerCase();
	const isMe = (login) => !!me && low(login) === low(me);
	const isBot = (login) => !!bot && low(login) === low(bot);
	const who = (login) => (isMe(login) ? "You" : low(login).startsWith("copilot") ? "Copilot" : login);
	const from = Date.parse(anchor.at);
	const all = activity.events.filter((e) => e && Number.isFinite(Date.parse(e.at)));
	const after = (t) => (e) => Date.parse(e.at) > t;
	const events = all.filter(after(from));
	const jobs = jobCommits(actions);
	const jobOf = (sha) => (sha ? jobs.find((j) => low(sha).startsWith(j.sha) || j.sha.startsWith(low(sha)))?.job : undefined);
	const groups = new Map();
	const add = (key, e, init) => {
		if (!groups.has(key)) groups.set(key, { at: e.at, events: [], ...init });
		groups.get(key).events.push(e);
	};
	for (const e of events) {
		if (e.kind === "commit") add(`commit|${e.by}|${jobOf(e.sha) ?? ""}`, e, { kind: "commit", job: jobOf(e.sha) });
		else if (e.kind === "force_push") add(`force|${e.by}`, e, { kind: "force_push" });
		else if (e.kind === "review") add(`review|${e.by}`, e, { kind: "review" });
		else if (["comment", "reply", "thread_reply"].includes(e.kind)) {
			if (e.side === "automated" || e.side === "bot") continue;
			if (isBot(e.by)) {
				// Gary's own replies in review threads count, its other comments do not
				if (e.kind === "thread_reply") add(`bot_replies|${e.by}`, e, { kind: "bot_replies" });
				continue;
			}
			add(`comment|${e.by}`, e, { kind: "comment" });
		} else if (STATUS_WORDS[e.kind]) add(`${e.kind}|${e.by}`, e, { kind: e.kind });
		else if ((e.kind === "labeled" || e.kind === "unlabeled") && e.side === "us") add(`${e.kind}|${e.by}`, e, { kind: e.kind });
	}
	const pushedAfter = (t) =>
		all.some((e) => (e.kind === "commit" || e.kind === "force_push") && Date.parse(e.at) > t) ||
		actions.some((a) => PUSH_JOBS[a?.action] && a.status === "done" && Date.parse(a.finishedAt) > t);
	const answeredAfter = (t) => all.some((e) => e.side === "us" && ANSWERS.has(e.kind) && Date.parse(e.at) > t);
	const out = [];
	for (const g of groups.values()) {
		const by = g.events[0].by;
		const n = g.events.length;
		const line = { at: g.at, kind: g.kind };
		if (g.kind === "commit") Object.assign(line, { icon: "commit", text: `${who(by)} pushed ${plural(n, "commit")}${g.job ? ` (${g.job})` : ""}` });
		else if (g.kind === "force_push") Object.assign(line, { icon: "commit", text: `${who(by)} force-pushed${n > 1 ? ` ${times(n)}` : ""}` });
		else if (g.kind === "review") {
			const last = g.events.findLast((e) => REVIEW_WORDS[e.state]);
			const state = last && g.events.at(-1).state !== "dismissed" ? REVIEW_WORDS[last.state] : undefined;
			const text = n === 1 ? (state ?? "reviewed") : `reviewed ${times(n)}${state ? `, ${state}` : ""}`;
			const open = (activity.openThreads ?? []).filter((t) => t?.by === by && Date.parse(t.at) > from).length;
			const notes = [];
			if (open) notes.push(`${plural(open, "thread")} still open`);
			if (isMe(by) && last?.state === "changes_requested" && !pushedAfter(Date.parse(last.at))) notes.push("not addressed yet");
			Object.assign(line, { icon: state === "approved" ? "check" : state === "requested changes" ? "changes" : "eye", text: `${who(by)} ${text}` }, notes.length && { note: notes.join(" · ") });
		} else if (g.kind === "comment") {
			const asked = g.events.findLast((e) => e.asks);
			Object.assign(line, { icon: "comments", text: `${who(by)} wrote ${plural(n, "comment")}` }, asked && !answeredAfter(Date.parse(asked.at)) && { note: "asked you something, no answer yet" });
		} else if (g.kind === "bot_replies") Object.assign(line, { icon: "comments", text: `${who(by)} wrote ${plural(n, "reply")} in review threads` });
		else if (g.kind === "labeled" || g.kind === "unlabeled") {
			const names = [...new Set(g.events.map((e) => e.label).filter(Boolean))];
			Object.assign(line, { text: `${who(by)} ${g.kind === "labeled" ? "added" : "removed"} ${names.length === 1 ? "label" : "labels"} ${names.join(", ")}` });
		} else Object.assign(line, { icon: STATUS_ICONS[g.kind], text: `${who(by)} ${STATUS_WORDS[g.kind]}` });
		out.push(line);
	}
	const linked = new Map();
	for (const a of actions) {
		if (a?.action !== "link_issue" || a.status !== "done" || !Number.isSafeInteger(a.params?.issue) || !(Date.parse(a.finishedAt) > from)) continue;
		// An issue with two fix PRs gets one line
		if (!linked.has(a.params.issue)) linked.set(a.params.issue, { at: a.finishedAt, kind: "linked", icon: "link", text: `Linked the fix PR to #${a.params.issue}` });
	}
	out.push(...linked.values());
	const ci = Array.isArray(activity.ci) ? activity.ci : [];
	const changes = ci.filter((c, i) => i > 0 && Date.parse(c.at) > from);
	if (changes.length) {
		const last = changes.at(-1);
		const failing = last.state === "failing";
		out.push({ at: last.at, kind: "ci", icon: failing ? "ciFail" : "ciPass", text: failing ? (changes.length > 1 ? "CI failed again" : "CI failed") : "CI passing again" });
	}
	out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	return { anchor, groups: out };
}
