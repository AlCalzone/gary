// Checks a board item against the rules of SPEC.md before it is written.
import { ID_PATTERN } from "./board-store.mjs";
import { fixBlock } from "./fixes.mjs";
import { MOVE_MODES, CHORE_ACTIONS, ROUTE_TYPES, driveRefusal, effectiveActor, formatRefusal, isObject, pushRefusal, reviseRefusal, takeOverRefusal } from "./routes.mjs";

const KINDS = ["pr", "issue", "discussion"];
const AUTHOR_TYPES = ["maintainer", "bot", "copilot", "contributor"];
const SECTIONS = ["active", "easy", "almost", "review", "deferred", "hardware"];
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
const POSTING_TYPES = new Set(["reply", "request_logs", "reopen", "review", "follow_up", "move"]);

const isString = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * Returns `{ errors, warnings }` for one item. Each entry is `{ code, message }`.
 * `mode` is the account mode from accountMode(), `profile` the loaded profile.json, `repos` the instance's allowed repos
 * (default the profile's one repo), `fix` the item's fix state from fixStateOf, when known.
 */
export function validateItem(id, item, { mode, profile, repos: repoList, fix = null }) {
	const errors = [];
	const warnings = [];
	const err = (code, message) => errors.push({ code, message });
	const warn = (code, message) => warnings.push({ code, message });

	if (!isObject(item)) {
		err("not-object", "the item must be a JSON object");
		return { errors, warnings };
	}

	// Fields and enums
	if (!KINDS.includes(item.kind)) err("kind", `kind must be one of ${KINDS.join(", ")}`);
	if (!Number.isSafeInteger(item.number) || item.number <= 0) err("number", "number must be a positive integer");
	if (!ID_PATTERN.test(id ?? "")) err("id", `the id "${id}" must match ${ID_PATTERN}`);
	const repos = repoList ?? [profile.repo];
	if (typeof item.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(item.repo)) err("repo", 'repo is required, like "owner/name"');
	else if (!repos.some((r) => r.toLowerCase() === item.repo.toLowerCase())) err("repo", `${item.repo} is not a repository of this instance (${repos.join(", ")})`);
	for (const key of ["title", "url", "author", "state"]) if (!isString(item[key])) err(`missing-${key}`, `${key} is required`);
	if (!AUTHOR_TYPES.includes(item.authorType)) err("authorType", `authorType must be one of ${AUTHOR_TYPES.join(", ")}`);
	if (!SECTIONS.includes(item.section)) err("section", `section must be one of ${SECTIONS.join(", ")}`);
	if (!Number.isInteger(item.priority) || item.priority < 0) err("priority", "priority must be a whole number");
	if (item.effortMinutes === undefined) err("effortMinutes", `effortMinutes is required: the minutes the maintainer needs, one of ${EFFORTS.join(", ")}`);
	else if (!EFFORTS.includes(item.effortMinutes)) err("effortMinutes", `effortMinutes must be one of ${EFFORTS.join(", ")}, not ${JSON.stringify(item.effortMinutes)}`);
	if (!DEPTHS.includes(item.reviewDepth)) err("reviewDepth", `reviewDepth must be one of ${DEPTHS.join(", ")}`);
	if (item.kind === "pr" && item.ci !== undefined && !CI.includes(item.ci)) err("ci", `ci must be one of ${CI.join(", ")}`);
	if (item.mergeable !== undefined && !MERGEABLE.includes(item.mergeable)) err("mergeable", `mergeable must be one of ${MERGEABLE.join(", ")}`);
	if (item.reviewDecision !== undefined && !DECISIONS.includes(item.reviewDecision)) {
		err("reviewDecision", `reviewDecision must be one of ${DECISIONS.join(", ")}`);
	}
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
		}
	}
	if (item.classifiedBy !== undefined && !CLASSIFIERS.includes(item.classifiedBy)) err("classifiedBy", `classifiedBy must be one of ${CLASSIFIERS.join(", ")}`);
	if (item.labels !== undefined && !(Array.isArray(item.labels) && item.labels.every((l) => typeof l === "string"))) {
		err("labels", "labels must be a list of strings");
	}
	checkWants(item, profile, err);
	checkAutofix(item, err);

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
	(Array.isArray(findings) ? findings : []).forEach((f, i) => {
		if (!isObject(f) || !SEVERITIES.includes(f.severity)) err("finding-severity", `findings[${i}].severity must be one of ${SEVERITIES.join(", ")}`);
		if (isObject(f) && f.routeId !== undefined && !routeIds.has(f.routeId)) {
			err("finding-route", `findings[${i}].routeId "${f.routeId}" names no route of this item`);
		}
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
	const commands = Object.values(profile.botCommands ?? {}).map((c) => c.trim().toLowerCase()).filter(Boolean);
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
		const actors = toRepo ? MOVE_MODES.map((m) => effectiveActor(route, mode, m)) : [effectiveActor(route, mode)];
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
					warn("review-comment-event", `${where}: a review with something for the contributor is a change request. Use event "request_changes", or "approve" for a clean PR. He can still pick Comment on the card`);
				}
				break;
			}
			case "merge":
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
				const refusal = driveRefusal(item, params.maxRounds ?? 3);
				if (refusal) err("drive", `${where}: ${refusal}`);
				break;
			}
			case "format": {
				const refusal = formatRefusal(item);
				if (refusal) err("format", `${where}: ${refusal}`);
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
				const refusal = reviseRefusal(item, route.text);
				if (refusal) err("revise", `${where}: ${refusal}`);
				if (Object.keys(params).length) err("revise-route", `${where}: a revise route has no params`);
				break;
			}
			case "move":
				if (params.to === "discussion") {
					if (item.kind !== "issue") err("move-target", `${where}: only an issue can become a discussion`);
				} else if (params.to === "issue") {
					if (item.kind !== "discussion") err("move-target", `${where}: only a discussion can become an issue`);
					if (!isString(profile.botCommands?.escalate)) err("move-escalate", `${where}: the profile has no escalate command`);
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
		if (bot && POSTING_TYPES.has(route.type) && commands.length) {
			const texts = [route.text, params.title, ...(Array.isArray(params.comments) ? params.comments.map((c) => c?.text) : [])];
			for (const text of texts.filter((t) => typeof t === "string")) {
				const hit = commands.find((c) => text.toLowerCase().includes(c));
				if (hit) err("bot-command", `${where}: the bot would post the command "${hit}"`);
			}
		}
	});

	return { errors, warnings };
}

const SUGGESTION_FENCE = /```suggestion\b/;

/**
 * A comment that proposes a change carries the exact lines it replaces in `original` and the new text in `suggestion`,
 * so the page and the GitHub body show both. A fence inside `text` is the old form.
 */
function checkSuggestion(c, where, err, warn) {
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
function checkAutofix(item, err) {
	if (item.autofix === undefined) return;
	const a = item.autofix;
	const count = (v) => Number.isInteger(v) && v >= 0;
	if (item.kind !== "pr") return err("autofix", "autofix is only for PRs");
	if (!isObject(a) || Object.keys(a).some((k) => !["changes", "files", "lines", "tools"].includes(k)) || typeof a.changes !== "boolean" || !count(a.files) || !count(a.lines) || !(Array.isArray(a.tools) && a.tools.every(isString))) {
		return err("autofix", "autofix must be { changes: boolean, files: number, lines: number, tools: [name] }");
	}
	if (a.changes !== a.files > 0) err("autofix", "autofix.changes must be true exactly when files is above 0");
}

// `wants` is the label and assignee state the agent would set. Only the profile's autoLabels are allowed in it
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
export const VALIDATED_FIELDS = ["routes", "threads", "hint", "findings", "wants", "wantsReason", "handled"];
