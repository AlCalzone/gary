// Checks a board item against the rules of SPEC.md before it is written.
import { ID_PATTERN } from "./board-store.mjs";
import { fixBlock } from "./fixes.mjs";
import { apiEditProblems } from "./api-edit.mjs";
import { FINDING_ID } from "./findings.mjs";
import { pendingRouteProblems, walkthroughProblems } from "./review-drafts.mjs";
import { ownPrRefusal } from "./own-pr.mjs";
import { botCommandTexts } from "./review-bots.mjs";
import { CATEGORIES, FYI, categoriesFor, normalizeCategory } from "./categories.mjs";
import { MOVE_MODES, CHORE_ACTIONS, ISSUE_KINDS, ROUTE_TYPES, driveRefusal, effectiveActor, formatRefusal, isApiEdit, isObject, pushRefusal, reviseRefusal, sensitiveRefusal, takeOverRefusal } from "./routes.mjs";

const KINDS = ["pr", "issue", "discussion"];
const AUTHOR_TYPES = ["maintainer", "bot", "copilot", "contributor"];
const WAITING_ON = ["us", "them", "nobody"];
const EFFORTS = [1, 2, 5, 10, 15, 30, 60, 120];
const DEPTHS = ["quick", "full", "pending"];
export const CLASSIFIERS = ["fast", "standard", "full"];
const HANDLED_VERIFIED = ["closed", "merged", "commented", "labeled", "unchanged"];
const CI = ["passing", "failing", "pending", "none"];
const MERGEABLE = ["mergeable", "conflicting", "unknown"];
const DECISIONS = ["approved", "changes_requested", "pending"];
const VERDICTS = ["valid", "optional", "wrong", "unjudged"];
const BLOCKED_REASONS = ["safety_filter", "failed"];
const SEVERITIES = ["blocker", "major", "minor", "idea", "question"];
const REVIEW_EVENTS = ["approve", "request_changes", "comment"];
const ROUTE_IDS = ["r1", "r2", "r3", "r4"];
const MAX_TITLE = 60;
// Route types whose text goes out on GitHub when the bot runs them
// The agent actions that push to a PR, and the routes that decide a PR after such a push
const PUSH_ACTIONS = ["take_over", "revise", "address_review", "drive", "format"];
const DECIDING_TYPES = ["merge", "review", "revise", "address_review", "close"];
const POSTING_TYPES = new Set(["reply", "request_logs", "reopen", "review", "follow_up", "move"]);

const isString = (v) => typeof v === "string" && v.trim().length > 0;

// The maintainer runs every route of a contributions instance on GitHub themself: the board copies the text and opens the thread
const CONTRIBUTION_ROUTES = ["reply", "review", "close", "open"];
// Fields that come from a profile, a bot, a checkout or an agent job, none of which a contributions instance has
const MAINTAINER_FIELDS = ["wants", "wantsReason", "pushed", "takenOver", "autofix", "fixFor", "rounds", "needsHardware"];

// A change on the maintainer's own PR is a drive. "Open on GitHub" is no answer to a change request there
const CHANGE_TITLE = /^\s*change\b/i;

/**
 * The rules a contributions item adds: fyi carries `newsAt`, routes are prefills, and nothing needs a profile or a bot.
 * The one agent route is `drive` on the maintainer's own PR, and only when `refusal`, from ownPrRefusal, is null.
 */
function checkContribution(item, err, refusal) {
	const fyi = item.category === FYI;
	if (fyi && !Number.isFinite(Date.parse(item.newsAt ?? ""))) err("newsAt", "an fyi item needs newsAt, the time of the newest relevant event its state reports");
	if (!fyi && item.newsAt !== undefined && item.newsAt !== null) err("newsAt", "newsAt belongs to fyi items only");
	if (item.gotIt !== undefined && item.gotIt !== null && !(isObject(item.gotIt) && Object.keys(item.gotIt).every((k) => k === "at") && Number.isFinite(Date.parse(item.gotIt.at ?? "")))) err("gotIt", "gotIt must be { at: ISO }, set by the board");
	for (const key of MAINTAINER_FIELDS) if (item[key] !== undefined && item[key] !== null && item[key] !== false) err(`contribution-${key}`, `${key} is not for a contributions instance, which has no profile, bot or checkout`);
	(Array.isArray(item.routes) ? item.routes : []).forEach((r, i) => {
		if (!isObject(r)) return;
		const where = `routes[${i}] (${r.type})`;
		if (r.type === "drive") return checkOwnDrive(r, where, err, refusal);
		if (!CONTRIBUTION_ROUTES.includes(r.type)) err("contribution-route", `${where}: a contributions instance offers only ${CONTRIBUTION_ROUTES.join(", ")} and drive on your own PR, because Gary writes nothing else to GitHub there`);
		else if (r.as !== "me") err("contribution-as", `${where}: every route of a contributions instance is as "me", a text the maintainer posts themself`);
		const params = isObject(r.params) ? r.params : {};
		if (params.alsoLabel !== undefined || params.alsoAnswer !== undefined) err("contribution-part", `${where}: alsoLabel and alsoAnswer need a bot, which a contributions instance has none of`);
		if (r.type === "review" && params.pending !== true && Array.isArray(params.comments) && params.comments.length) err("contribution-comments", `${where}: a review the maintainer posts themself carries no inline comments. Put them into the text`);
		if (r.type === "open" && !refusal && CHANGE_TITLE.test(r.title ?? "")) err("contribution-change", `${where}: a code change on your own PR is a drive route, with the change in its text. An open route only opens the PR`);
	});
	checkReviewDraft(item, err);
}

/** A drive on the maintainer's own PR: an agent implements the change in `text` and pushes it to the PR's head branch. */
function checkOwnDrive(r, where, err, refusal) {
	if (refusal) return err("contribution-drive", `${where}: ${refusal}`);
	if (r.as !== "agent") err("contribution-as", `${where}: a drive runs as "agent"`);
	if (!isString(r.text)) err("contribution-drive", `${where}: a drive on your own PR needs a text that says what to change`);
	if (r.params !== undefined && !(isObject(r.params) && !Object.keys(r.params).length)) err("contribution-drive", `${where}: a drive on your own PR has no params`);
}

/** A review draft holds at most one pending review route, the maintainer's own review that the server creates on GitHub on a click. */
function checkReviewDraft(item, err) {
	const pending = (Array.isArray(item.routes) ? item.routes : []).map((r, i) => [r, i]).filter(([r]) => isObject(r) && isObject(r.params) && (r.params.pending !== undefined || r.params.bodies !== undefined));
	if (pending.length > 1) err("pending-count", "an item has at most one pending review route");
	for (const [r, i] of pending) {
		const where = `routes[${i}] (${r.type})`;
		if (r.type !== "review" || r.params.pending !== true) err("pending-route", `${where}: params.pending is true on a review route only, and params.bodies needs it`);
		else for (const [code, message] of pendingRouteProblems(item, r, where)) err(code, message);
	}
}

/**
 * Returns `{ errors, warnings }` for one item. Each entry is `{ code, message }`.
 * `mode` is the account mode from accountMode(), `profile` the loaded profile.json, `repos` the instance's allowed repos
 * (default the profile's one repo), `fix` the item's fix state from fixStateOf, when known. `sensitive` says whether
 * the PR's snapshot entry lists sensitive files: true, false, or undefined without an entry. `sensitiveOurs` says
 * that the entry also marks the PR as ours alone. `kind` is the instance's kind: a contributions instance allows the
 * category `fyi`, routes the maintainer runs on GitHub themself and a drive on their own PR. For that drive, `entry` is
 * the item's entry in the snapshot and `me` the instance's login.
 */
export function validateItem(id, doc, { mode, profile, repos: repoList, fix = null, sensitive, sensitiveOurs = false, kind = "maintainer", entry, me }) {
	const errors = [];
	const warnings = [];
	const err = (code, message) => errors.push({ code, message });
	const warn = (code, message) => warnings.push({ code, message });

	if (!isObject(doc)) {
		err("not-object", "the item must be a JSON object");
		return { errors, warnings };
	}
	// An item may still carry the old `section`, which maps to a category
	const item = normalizeCategory(doc);

	// Fields and enums
	if (!KINDS.includes(item.kind)) err("kind", `kind must be one of ${KINDS.join(", ")}`);
	if (!Number.isSafeInteger(item.number) || item.number <= 0) err("number", "number must be a positive integer");
	if (!ID_PATTERN.test(id ?? "")) err("id", `the id "${id}" must match ${ID_PATTERN}`);
	const repos = repoList ?? [profile.repo];
	if (typeof item.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(item.repo)) err("repo", 'repo is required, like "owner/name"');
	else if (!repos.some((r) => r.toLowerCase() === item.repo.toLowerCase())) err("repo", `${item.repo} is not a repository of this instance (${repos.join(", ")})`);
	for (const key of ["title", "url", "author", "state"]) if (!isString(item[key])) err(`missing-${key}`, `${key} is required`);
	if (!AUTHOR_TYPES.includes(item.authorType)) err("authorType", `authorType must be one of ${AUTHOR_TYPES.join(", ")}`);
	const categories = categoriesFor(kind);
	if (item.section !== undefined) err("section", `section ${JSON.stringify(item.section)} is unknown. Items carry category: ${CATEGORIES.join(", ")}`);
	else if (!categories.includes(item.category)) err("category", `category must be one of ${categories.join(", ")}${item.category === undefined ? "" : `, not ${JSON.stringify(item.category)}`}${item.category === FYI ? ". Only a contributions instance has fyi items" : ""}`);
	if (kind === "contributions") checkContribution(item, err, ownPrRefusal(item, entry, me));
	else if (item.newsAt !== undefined || item.gotIt !== undefined) err("fyi-fields", "newsAt and gotIt belong to fyi items of a contributions instance");
	if (kind !== "contributions" && (Array.isArray(item.routes) ? item.routes : []).some((r) => isObject(r?.params) && (r.params.pending !== undefined || r.params.bodies !== undefined))) {
		err("pending-kind", "a pending review route is only for a review draft of a contributions instance");
	}
	if (kind !== "contributions") for (const problem of waitingDraftProblems(item, entry)) err("draft", problem);
	for (const problem of walkthroughProblems(item)) err("walkthrough", problem);
	if (item.needsHardware !== undefined && typeof item.needsHardware !== "boolean") err("needsHardware", "needsHardware must be true or false");
	if (item.waitingOn !== undefined && !WAITING_ON.includes(item.waitingOn)) err("waitingOn", `waitingOn must be one of ${WAITING_ON.join(", ")}, copied from facts.waitingOn`);
	checkDue(item, err);
	checkSeries(item, err);
	// The routine ranks only items with routes, so an item without routes may have no priority
	const ranked = Array.isArray(item.routes) && item.routes.length > 0;
	if ((ranked || item.priority != null) && (!Number.isInteger(item.priority) || item.priority < 0)) err("priority", "priority must be a whole number");
	if (item.effortMinutes === undefined) err("effortMinutes", `effortMinutes is required: the minutes the maintainer needs, one of ${EFFORTS.join(", ")}`);
	else if (!EFFORTS.includes(item.effortMinutes)) err("effortMinutes", `effortMinutes must be one of ${EFFORTS.join(", ")}, not ${JSON.stringify(item.effortMinutes)}`);
	if (!DEPTHS.includes(item.reviewDepth)) err("reviewDepth", `reviewDepth must be one of ${DEPTHS.join(", ")}`);
	if (item.kind === "pr" && item.ci !== undefined && !CI.includes(item.ci)) err("ci", `ci must be one of ${CI.join(", ")}`);
	if (item.ciOptionalFailing !== undefined && !(item.kind === "pr" && Array.isArray(item.ciOptionalFailing) && item.ciOptionalFailing.every(isString))) {
		err("ciOptionalFailing", "ciOptionalFailing lists the names of a PR's failing optional checks, from the snapshot");
	}
	if (item.mergeable !== undefined && !MERGEABLE.includes(item.mergeable)) err("mergeable", `mergeable must be one of ${MERGEABLE.join(", ")}`);
	if (item.reviewDecision !== undefined && !DECISIONS.includes(item.reviewDecision)) {
		err("reviewDecision", `reviewDecision must be one of ${DECISIONS.join(", ")}`);
	}
	if (item.discussionCategory !== undefined && !(item.kind === "discussion" && isString(item.discussionCategory))) err("discussionCategory", "discussionCategory is the discussion's category name, from the snapshot, and only discussions have one");
	if (item.analyzedBy !== undefined && item.analyzedBy !== "fallback") err("analyzedBy", 'analyzedBy must be "fallback" when present');
	if (item.lastEventUrl !== undefined && !(typeof item.lastEventUrl === "string" && typeof item.url === "string" && item.lastEventUrl.startsWith(item.url + "#"))) {
		err("lastEventUrl", "lastEventUrl must be a URL of the item's own thread, its url followed by #anchor");
	}
	if (item.handled !== undefined && item.handled !== null) {
		const h = item.handled;
		const ok = isObject(h) && Object.keys(h).every((k) => ["at", "routeId", "routeType", "verified"].includes(k)) && Number.isFinite(Date.parse(h.at ?? "")) && isString(h.routeId) && isString(h.routeType) && (h.verified === null || HANDLED_VERIFIED.includes(h.verified));
		if (!ok) err("handled", `handled must be { at, routeId, routeType, verified: null | ${HANDLED_VERIFIED.join(" | ")} }`);
	}
	if (item.fixFor !== undefined) {
		const f = item.fixFor;
		if (item.kind !== "pr" || !isObject(f) || Object.keys(f).some((k) => !["itemId", "ref"].includes(k)) || typeof f.itemId !== "string" || !ID_PATTERN.test(f.itemId) || typeof f.ref !== "string" || !/^[\w.-]+\/[\w.-]+#\d+$/.test(f.ref)) {
			err("fixFor", 'fixFor is only for PRs, as { itemId, ref: "owner/name#number" }');
		} else if (f.ref.split("#")[1] !== f.itemId.split("-").pop()) {
			err("fixFor", `fixFor.ref must name the item the fix is for (${f.itemId}), never the fix PR itself`);
		}
	}
	if (item.classifiedBy !== undefined && !CLASSIFIERS.includes(item.classifiedBy)) err("classifiedBy", `classifiedBy must be one of ${CLASSIFIERS.join(", ")}`);
	if (item.labels !== undefined && !(Array.isArray(item.labels) && item.labels.every((l) => typeof l === "string"))) {
		err("labels", "labels must be a list of strings");
	}
	if (item.pushed !== undefined && item.pushed !== null) {
		const p = item.pushed;
		const ok = item.kind === "pr" && isObject(p) && Object.keys(p).every((k) => ["action", "sha", "at"].includes(k)) && PUSH_ACTIONS.includes(p.action) && typeof p.sha === "string" && /^[0-9a-f]{7,64}$/.test(p.sha) && Number.isFinite(Date.parse(p.at ?? ""));
		if (!ok) err("pushed", `pushed is only for PRs, as { action: ${PUSH_ACTIONS.join(" | ")}, sha, at }`);
		// After our push the item offers the decision, also while CI still runs on the new head
		else if (p.sha === item.reviewedSha && !(Array.isArray(item.routes) ? item.routes : []).some((r) => DECIDING_TYPES.includes(r?.type))) {
			err("pushed-decision", `the agent's ${p.action} pushed the current head, so the item needs a route that decides the PR: ${DECIDING_TYPES.join(", ")}. A reply that reports the push is not one`);
		}
	}
	checkWants(item, profile, err);
	checkAutofix(item, profile, err);

	const threads = item.threads === undefined ? [] : item.threads;
	if (!Array.isArray(threads)) err("threads", "threads must be a list");
	const threadList = Array.isArray(threads) ? threads : [];
	threadList.forEach((t, i) => {
		if (!isObject(t) || !VERDICTS.includes(t.verdict)) err("thread-verdict", `threads[${i}].verdict must be one of ${VERDICTS.join(", ")}`);
	});

	const routes = item.routes === undefined ? [] : item.routes;
	if (!Array.isArray(routes)) {
		err("routes", "routes must be a list");
		return { errors, warnings };
	}
	if (item.blocked !== undefined && item.blocked !== null) {
		if (!isObject(item.blocked) || !BLOCKED_REASONS.includes(item.blocked.reason) || !Number.isFinite(Date.parse(item.blocked.at ?? ""))) {
			err("blocked", `blocked must be { reason: ${BLOCKED_REASONS.join(" | ")}, at: ISO }`);
		}
		if (routes.length !== 1 || routes[0]?.type !== "open") err("blocked-routes", "a blocked item has exactly one route, of type open");
	}

	const findings = item.findings === undefined ? [] : item.findings;
	if (!Array.isArray(findings)) err("findings", "findings must be a list");
	const routeIds = new Set(routes.map((r) => r?.id));
	const findingIds = new Set();
	(Array.isArray(findings) ? findings : []).forEach((f, i) => {
		if (!isObject(f) || !SEVERITIES.includes(f.severity)) err("finding-severity", `findings[${i}].severity must be one of ${SEVERITIES.join(", ")}`);
		// The maintainer's answers name a finding by its id, so an id is unique within the item
		if (isObject(f) && f.id !== undefined) {
			if (typeof f.id !== "string" || !FINDING_ID.test(f.id)) err("finding-id", `findings[${i}].id must be 1 to 40 letters, digits, "-" or "_", like "f1"`);
			else if (findingIds.has(f.id)) err("finding-id", `findings[${i}].id "${f.id}" is used twice`);
			else findingIds.add(f.id);
		}
		if (isObject(f) && f.routeId !== undefined && !routeIds.has(f.routeId)) {
			err("finding-route", `findings[${i}].routeId "${f.routeId}" names no route of this item`);
		}
		// A certain finding may go out in an automatic review, so it has to show its case
		if (isObject(f) && f.certain !== undefined && typeof f.certain !== "boolean") err("finding-certain", `findings[${i}].certain must be true or false`);
		if (isObject(f) && f.evidence !== undefined && !(isString(f.evidence) && f.evidence.length <= 400)) err("finding-evidence", `findings[${i}].evidence must name the concrete case in at most 400 characters`);
		if (isObject(f) && f.certain === true && !isString(f.evidence)) err("finding-evidence", `findings[${i}] is certain, so it needs evidence: the concrete case that shows the problem, in one sentence`);
		if (isObject(f) && f.certain === true && ["question", "idea"].includes(f.severity)) err("finding-certain", `findings[${i}]: a ${f.severity} is never certain`);
	});

	// An item without routes is hidden on the board and needs no hint
	if (!routes.length) return { errors, warnings };

	if (routes.length > 4) err("route-count", `an item has at most 4 routes, this one has ${routes.length}`);
	const recommended = routes.filter((r) => isObject(r) && r.recommended === true);
	if (recommended.length !== 1) err("recommended", `exactly one route must be recommended, found ${recommended.length}`);
	if (!isString(item.hint)) err("hint", "an item with routes needs a hint");
	else if (item.hint.length > MAX_TITLE) err("hint-length", `hint is longer than ${MAX_TITLE} characters`);
	if (recommended.length === 1 && isString(item.hint) && recommended[0].title !== item.hint) {
		err("hint-title", `hint "${item.hint}" differs from the recommended route's title "${recommended[0].title}"`);
	}
	if (threadList.some((t) => t?.verdict === "unjudged")) err("unjudged", "an item with an unjudged thread must have no routes yet");

	const dismissed = Array.isArray(item.dismissedRoutes) ? item.dismissedRoutes.filter(isObject) : [];
	const seen = new Set();
	const commands = botCommandTexts(profile);
	const hasValidThread = threadList.some((t) => t?.verdict === "valid");

	routes.forEach((route, i) => {
		const where = `routes[${i}]${isObject(route) && route.id ? ` (${route.id})` : ""}`;
		if (!isObject(route)) return err("route-object", `${where} must be an object`);
		if (!ROUTE_IDS.includes(route.id)) err("route-id", `${where}: id must be one of ${ROUTE_IDS.join(", ")}`);
		else if (seen.has(route.id)) err("route-id-duplicate", `${where}: id ${route.id} is used twice`);
		seen.add(route.id);
		if (!Object.hasOwn(ROUTE_TYPES, route.type)) return err("route-type", `${where}: unknown type "${route.type}"`);
		const gone = dismissed.find((d) => d.type === route.type);
		if (gone) {
			err("dismissed-route", `${where}: the maintainer dismissed the ${route.type} route "${gone.title ?? ""}"${gone.reason ? ` because: ${gone.reason}` : ""}`);
		}
		if (!isString(route.title)) err("route-title", `${where}: title is required`);
		else if (route.title.length > MAX_TITLE) err("route-title-length", `${where}: title is longer than ${MAX_TITLE} characters`);
		if (route.params !== undefined && !isObject(route.params)) err("route-params", `${where}: params must be an object`);
		const params = isObject(route.params) ? route.params : {};

		// Actor under the current account mode
		const toRepo = route.type === "move" && typeof params.to === "string" && params.to !== "discussion" && params.to !== "issue";
		// The drive on the maintainer's own PR pushes under their own login, so the account mode does not decide it
		const ownDrive = kind === "contributions" && route.type === "drive";
		const actors = ownDrive ? ["agent"] : toRepo ? MOVE_MODES.map((m) => effectiveActor(route, mode, m)) : [effectiveActor(route, mode)];
		if (actors.includes(undefined)) err("route-actor", `${where}: "${route.as ?? "(none)"}" is not allowed for ${route.type}`);
		else if (actors.every((a) => a === "unavailable")) {
			err("route-unavailable", `${where}: ${route.type} needs a bot account or allowOwnTokenPushes in this setup`);
		}

		if (params.alsoLabel !== undefined) checkAlsoLabel(route, params.alsoLabel, profile, where, err);
		if (params.alsoAnswer !== undefined) checkAlsoAnswer(item, route, params.alsoAnswer, where, err);

		if (params.askReporter !== undefined || params.askReporterWhy !== undefined) {
			if (route.type !== "follow_up" || route.as !== "agent") err("ask-reporter", `${where}: askReporter is only for follow_up routes with as "agent"`);
			else if (typeof params.askReporter !== "boolean") err("ask-reporter", `${where}: params.askReporter must be true or false`);
			else if (params.askReporterWhy !== undefined && !(params.askReporter && isString(params.askReporterWhy) && params.askReporterWhy.length <= 200)) {
				err("ask-reporter", `${where}: params.askReporterWhy says in at most 200 characters why only the reporter can test it, and needs askReporter true`);
			}
		}

		// No second fix while one runs or its PR is a draft or open
		if (route.type === "follow_up" && route.as === "agent" && fixBlock(fix)) err("fix-running", `${where}: ${fixBlock(fix)}`);

		// A PR with sensitive files gets no agent in its checkout, unless only we committed to it
		const refusal = sensitiveRefusal(route, sensitive, sensitiveOurs);
		if (refusal) err("sensitive-push", `${where}: ${refusal}`);
		if (isApiEdit(route)) checkApiEdit(item, route, profile, { sensitive, sensitiveOurs }, where, err);
		else if (params.via !== undefined) err("api-edit", `${where}: params.via is only for take_over and revise routes, with the value "api"`);

		switch (route.type) {
			case "review": {
				if (!REVIEW_EVENTS.includes(params.event)) err("review-event", `${where}: params.event must be one of ${REVIEW_EVENTS.join(", ")}`);
				const comments = params.comments ?? [];
				if (!Array.isArray(comments)) err("review-comments", `${where}: params.comments must be a list`);
				else {
					const ids = new Set();
					comments.forEach((c, j) => {
						if (!isObject(c) || !isString(c.id) || !isString(c.path) || !Number.isInteger(c.line) || !isString(c.text)) {
							err("review-comment", `${where}: comments[${j}] needs id, path, line and text`);
						} else if (ids.has(c.id)) err("review-comment-id", `${where}: comment id ${c.id} is used twice`);
						if (isObject(c)) checkSuggestion(c, `${where}: comments[${j}]`, err, warn);
						if (isObject(c)) ids.add(c.id);
					});
				}
				if (params.event === "approve" && hasValidThread) warn("approve-valid-thread", `${where}: approves while a thread is judged valid`);
				// GitHub refuses a change request on one's own PR, so a bot's PR keeps a comment review
				if (params.event === "comment" && item.authorType !== "bot") {
					warn("review-comment-event", `${where}: a review with something for the contributor is a change request. Use event "request_changes", or "approve" for a clean PR. The maintainer can still pick Comment on the card`);
				}
				break;
			}
			case "merge":
				// An agent wrote these PRs, and only the maintainer's approval says that a human read the code
				if (route.recommended === true && (item.fixFor !== undefined || item.authorType === "copilot") && item.reviewDecision !== "approved") {
					err("merge-unapproved", `${where}: this PR was written by an agent and is not approved. Recommend a "review" route with event "approve" and as "me", and offer the merge as the alternative`);
				}
				if (hasValidThread) warn("merge-valid-thread", `${where}: merges while a thread is judged valid`);
				break;
			case "address_review":
				if (pushRefusal(item, "address_review")) err("address-review-push", `${where}: ${pushRefusal(item, "address_review")}`);
				if (!threadList.length) err("address-no-threads", `${where}: address_review needs the item's threads`);
				else if (threadList.some((t) => !isString(t?.id) || !VERDICTS.includes(t?.verdict))) {
					err("address-thread", `${where}: every thread needs an id and a verdict for address_review`);
				}
				break;
			case "drive": {
				if (ownDrive) break;
				const refusal = driveRefusal(item, params.maxRounds ?? 3);
				if (refusal) err("drive", `${where}: ${refusal}`);
				break;
			}
			case "format": {
				const refusal = formatRefusal(item);
				if (refusal) err("format", `${where}: ${refusal}`);
				if (!(profile.autofixCommands ?? []).length) err("format", `${where}: the profile names no autofixCommands, so there is no format route`);
				if ((typeof route.text === "string" && route.text.trim()) || Object.keys(params).length) {
					err("format-route", `${where}: a format route has no text and no params`);
				}
				break;
			}
			case "take_over": {
				const refusal = takeOverRefusal(route, item);
				if (refusal) err("take-over", `${where}: ${refusal}`);
				break;
			}
			case "revise": {
				const refusal = reviseRefusal(item, route.text, route);
				if (refusal) err("revise", `${where}: ${refusal}`);
				if (Object.keys(params).length && !isApiEdit(route)) err("revise-route", `${where}: a revise route has no params`);
				break;
			}
			case "move":
				if (params.to === "discussion") {
					if (item.kind !== "issue") err("move-target", `${where}: only an issue can become a discussion`);
				} else if (params.to === "issue") {
					if (item.kind !== "discussion") err("move-target", `${where}: only a discussion can become an issue`);
					if (item.live?.state === "closed") err("move-closed", `${where}: the discussion is closed, so it cannot become an issue`);
					if (params.issueKind !== undefined && !ISSUE_KINDS.includes(params.issueKind)) err("move-issue-kind", `${where}: params.issueKind must be one of ${ISSUE_KINDS.join(", ")}`);
				} else if (!isString(params.to)) {
					err("move-target", `${where}: params.to is required`);
				} else {
					if (item.kind !== "issue") err("move-target", `${where}: only issues move to another repository`);
					if (!(profile.relatedRepos ?? []).some((r) => r.toLowerCase() === params.to.toLowerCase())) {
						err("move-repo", `${where}: ${params.to} is not in the profile's relatedRepos`);
					}
				}
				break;
			case "chore":
				if (!CHORE_ACTIONS.has(params.action)) err("chore-action", `${where}: a chore cannot run "${params.action}"`);
				break;
			case "open":
				if ((typeof route.text === "string" && route.text.trim()) || Object.keys(params).length) {
					err("open-route", `${where}: an open route has no text and no params`);
				}
				break;
		}

		// Text the bot posts must not trigger a bot command
		const bot = actors.some((a) => a === "bot" || a === "own");
		// The note of an API edit goes into the comment about the commit
		if (((bot && POSTING_TYPES.has(route.type)) || isApiEdit(route)) && commands.length) {
			const texts = [route.text, params.title, ...(Array.isArray(params.comments) ? params.comments.map((c) => c?.text) : [])];
			for (const text of texts.filter((t) => typeof t === "string")) {
				const hit = commands.find((c) => text.toLowerCase().includes(c));
				if (hit) err("bot-command", `${where}: the bot would post the command "${hit}"`);
			}
		}
	});

	return { errors, warnings };
}

// The server commits the edits of an API edit exactly as the route holds them
function checkApiEdit(item, route, profile, { sensitive, sensitiveOurs }, where, err) {
	if (sensitive === false) err("api-edit-plain-pr", `${where}: this PR changes no sensitive files, so it gets the normal ${route.type} and no API edit`);
	if (sensitive === true && sensitiveOurs) err("api-edit-our-pr", `${where}: only the maintainer and the bot committed to this PR, so it gets the normal ${route.type} and no API edit`);
	if (typeof item.reviewedSha !== "string" || !/^[0-9a-f]{40}$/.test(item.reviewedSha)) err("api-edit-sha", `${where}: an API edit needs the item's reviewedSha as a full 40-character SHA`);
	for (const problem of apiEditProblems(route.params, profile)) err("api-edit", `${where}: ${problem}`);
}

const SUGGESTION_FENCE = /```suggestion\b/;

/**
 * The problems of an item for a draft PR that is on the board only for a waiting comment. Such an item gets reply
 * routes only, no full review and no label or assignee changes. `entry` is the PR's snapshot entry.
 */
function waitingDraftProblems(item, entry) {
	if (item.kind !== "pr" || entry?.isDraft !== true || entry.garyFix) return [];
	const problems = [];
	for (const r of Array.isArray(item.routes) ? item.routes : []) {
		if (isObject(r) && r.type !== "reply") problems.push(`route ${r.id ?? "?"} is a ${r.type}, but a draft PR gets reply routes only`);
	}
	if (item.reviewDepth === "full") problems.push("a draft PR gets no full review, only a quick classification");
	if (item.wants != null) problems.push("a draft PR gets no label or assignee changes, so it has no wants");
	return problems;
}

/**
 * A comment that proposes a change carries the exact lines it replaces in `original` and the new text in `suggestion`,
 * so the page and the GitHub body show both. A fence inside `text` is the old form.
 */
export function checkSuggestion(c, where, err, warn) {
	if (c.suggestion === undefined) {
		if (typeof c.text === "string" && SUGGESTION_FENCE.test(c.text)) {
			warn("suggestion-fence", `${where}: text holds a suggestion fence. Put the replacement in suggestion and the replaced lines in original`);
		}
		return;
	}
	if (typeof c.suggestion !== "string") return err("suggestion", `${where}: suggestion must be a string`);
	if (typeof c.original !== "string") return err("suggestion-original", `${where}: a suggestion needs original, the exact text of the lines it replaces`);
	const lines = Number.isInteger(c.startLine) ? c.line - c.startLine + 1 : 1;
	const have = c.original.split("\n").length;
	if (have !== lines) {
		err("suggestion-lines", `${where}: original has ${have} line${have === 1 ? "" : "s"}, but the comment covers ${lines}`);
	}
	if (typeof c.text === "string" && SUGGESTION_FENCE.test(c.text)) err("suggestion-fence", `${where}: text must not hold a suggestion fence when suggestion is set`);
	if (c.diffHunk !== undefined && !(typeof c.diffHunk === "string" && c.diffHunk.startsWith("@@"))) {
		err("suggestion-hunk", `${where}: diffHunk must start with an @@ header`);
	}
}

// The labels a reply or request_logs route also sets, offered as a second button or applied after the post
function checkAlsoLabel(route, also, profile, where, err) {
	if (route.type !== "reply" && route.type !== "request_logs") return err("also-label", `${where}: alsoLabel is only for reply and request_logs routes`);
	const strings = (v) => v === undefined || (Array.isArray(v) && v.every(isString));
	if (!isObject(also) || Object.keys(also).some((k) => !["add", "remove"].includes(k)) || !strings(also.add) || !strings(also.remove)) {
		return err("also-label", `${where}: params.alsoLabel must be { add?: [label], remove?: [label] }`);
	}
	const add = also.add ?? [];
	const remove = also.remove ?? [];
	if (!add.length && !remove.length) err("also-label", `${where}: params.alsoLabel needs at least one label`);
	const allowed = new Set((profile.autoLabels ?? []).map((x) => x.toLowerCase()));
	const outside = [...add, ...remove].filter((x) => !allowed.has(x.toLowerCase()));
	if (outside.length) err("also-label-not-auto", `${where}: params.alsoLabel may only name the profile's autoLabels, not ${outside.map((x) => `"${x}"`).join(", ")}`);
	const both = add.filter((x) => remove.some((y) => y.toLowerCase() === x.toLowerCase()));
	if (both.length) err("also-label", `${where}: params.alsoLabel adds and removes ${both.join(", ")}`);
}

// The comment a discussion close route also marks as the answer, offered as a second button
function checkAlsoAnswer(item, route, also, where, err) {
	if (route.type !== "close" || item.kind !== "discussion") return err("also-answer", `${where}: alsoAnswer is only for close routes of discussions`);
	if (!isObject(also) || Object.keys(also).some((k) => !["commentId", "url", "gist"].includes(k))) {
		return err("also-answer", `${where}: params.alsoAnswer must be { commentId, url, gist }`);
	}
	if (typeof also.commentId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(also.commentId)) err("also-answer", `${where}: params.alsoAnswer.commentId must be a discussion comment node id`);
	if (typeof also.url !== "string" || typeof item.url !== "string" || !also.url.startsWith(item.url + "#")) err("also-answer", `${where}: params.alsoAnswer.url must be a comment URL in this discussion`);
	if (!isString(also.gist) || also.gist.length > 200) err("also-answer", `${where}: params.alsoAnswer.gist must say in at most 200 characters what the answer says`);
}

// What the project's autofix would change in a PR, from the mechanical check before the review
function checkAutofix(item, profile, err) {
	if (item.autofix === undefined) return;
	const a = item.autofix;
	const count = (v) => Number.isInteger(v) && v >= 0;
	if (item.kind !== "pr") return err("autofix", "autofix is only for PRs");
	if (!(profile.autofixCommands ?? []).length) return err("autofix", "the profile names no autofixCommands, so there is no format check and no autofix");
	if (!isObject(a) || Object.keys(a).some((k) => !["changes", "files", "lines", "tools"].includes(k)) || typeof a.changes !== "boolean" || !count(a.files) || !count(a.lines) || !(Array.isArray(a.tools) && a.tools.every(isString))) {
		return err("autofix", "autofix must be { changes: boolean, files: number, lines: number, tools: [name] }");
	}
	if (a.changes !== a.files > 0) err("autofix", "autofix.changes must be true exactly when files is above 0");
}

// `wants` is the label and assignee state the agent would set. Only the profile's autoLabels are allowed in it
// `dueAt` and `dueSource` come from the snapshot together: a milestone's due date or a date field of a project item
function checkDue(item, err) {
	if (item.dueAt === undefined && item.dueSource === undefined) return;
	const ok = Number.isFinite(Date.parse(item.dueAt ?? "")) && isString(item.dueSource) && item.dueSource.length <= 200;
	if (!ok) err("due", "dueAt and dueSource come together from facts.dueAt and facts.dueSource: an ISO date and where GitHub has it, at most 200 characters");
}

function checkSeries(item, err) {
	if (item.series === undefined) return;
	const s = item.series;
	const ok = isObject(s) && Object.keys(s).every((k) => ["id", "title", "position", "size", "unready"].includes(k)) && (s.unready === undefined || (Number.isInteger(s.unready) && s.unready >= 1 && s.unready <= s.size)) && typeof s.id === "string" && ID_PATTERN.test(s.id)
		&& typeof s.title === "string" && s.title.length <= 300 && Number.isInteger(s.size) && s.size >= 2 && Number.isInteger(s.position) && s.position >= 1 && s.position <= s.size;
	if (!ok) err("series", "series is { id, title, position, size, unready? }, copied from facts.series: the first item's id and title, this item's place among size items, and how many of its PRs cannot be merged yet");
	else if (s.unready && Array.isArray(item.routes) && item.routes.some((r) => isObject(r) && r.type === "merge" && r.recommended === true)) {
		err("series-merge", `${s.unready} of the ${s.size} parts of this series cannot be merged yet, so merge may be an alternative route but never the recommended one`);
	}
}

function checkWants(item, profile, err) {
	if (item.wants === undefined) {
		if (item.wantsReason !== undefined) err("wants-reason", "wantsReason needs wants");
		return;
	}
	const w = item.wants;
	const strings = (v) => Array.isArray(v) && v.every(isString);
	if (!isObject(w) || Object.keys(w).some((k) => !["labels", "assignees"].includes(k))) {
		return err("wants", 'wants must be { labels?: { add?, remove? }, assignees? }');
	}
	if (!isString(item.wantsReason)) err("wants-reason", "wantsReason is required with wants, one sentence");
	if (w.labels !== undefined) {
		const l = w.labels;
		if (!isObject(l) || Object.keys(l).some((k) => !["add", "remove"].includes(k)) || (l.add !== undefined && !strings(l.add)) || (l.remove !== undefined && !strings(l.remove))) {
			err("wants-labels", "wants.labels must be { add?: [label], remove?: [label] }");
		} else {
			const allowed = new Set((profile.autoLabels ?? []).map((x) => x.toLowerCase()));
			const outside = [...(l.add ?? []), ...(l.remove ?? [])].filter((x) => !allowed.has(x.toLowerCase()));
			if (outside.length) err("wants-label-not-auto", `wants.labels may only name the profile's autoLabels, not ${outside.map((x) => `"${x}"`).join(", ")}`);
			const both = (l.add ?? []).filter((x) => (l.remove ?? []).some((y) => y.toLowerCase() === x.toLowerCase()));
			if (both.length) err("wants-labels", `wants.labels adds and removes ${both.join(", ")}`);
		}
	}
	if (w.assignees !== undefined && !strings(w.assignees)) err("wants-assignees", "wants.assignees must be a list of logins");
}

/** Item fields whose change needs a validation of the merged item. */
export const VALIDATED_FIELDS = ["routes", "threads", "hint", "findings", "wants", "wantsReason", "handled", "pushed", "reviewedSha", "walkthrough"];
