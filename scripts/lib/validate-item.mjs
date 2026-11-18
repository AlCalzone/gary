// Checks a board item against the rules of SPEC.md before it is written.
import { MOVE_MODES, CHORE_ACTIONS, ROUTE_TYPES, driveRefusal, effectiveActor, isObject, pushRefusal, takeOverRefusal } from "./routes.mjs";

const KINDS = { pr: "pr", issue: "issue", discussion: "disc" };
const AUTHOR_TYPES = ["maintainer", "bot", "copilot", "contributor"];
const SECTIONS = ["active", "easy", "almost", "review", "deferred", "hardware"];
const EFFORTS = [1, 2, 5, 10, 15, 30, 60];
const DEPTHS = ["quick", "full", "pending"];
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
 * `mode` is the account mode from accountMode(), `profile` the loaded profile.json.
 */
export function validateItem(id, item, { mode, profile }) {
	const errors = [];
	const warnings = [];
	const err = (code, message) => errors.push({ code, message });
	const warn = (code, message) => warnings.push({ code, message });

	if (!isObject(item)) {
		err("not-object", "the item must be a JSON object");
		return { errors, warnings };
	}

	// Fields and enums
	if (!Object.hasOwn(KINDS, item.kind)) err("kind", `kind must be one of ${Object.keys(KINDS).join(", ")}`);
	if (!Number.isSafeInteger(item.number) || item.number <= 0) err("number", "number must be a positive integer");
	if (Object.hasOwn(KINDS, item.kind) && Number.isSafeInteger(item.number) && id && id !== `${KINDS[item.kind]}-${item.number}`) {
		err("id", `the id ${id} does not match kind ${item.kind} and number ${item.number}`);
	}
	for (const key of ["title", "url", "author", "state"]) if (!isString(item[key])) err(`missing-${key}`, `${key} is required`);
	if (!AUTHOR_TYPES.includes(item.authorType)) err("authorType", `authorType must be one of ${AUTHOR_TYPES.join(", ")}`);
	if (!SECTIONS.includes(item.section)) err("section", `section must be one of ${SECTIONS.join(", ")}`);
	if (!Number.isInteger(item.priority) || item.priority < 0) err("priority", "priority must be a whole number");
	if (!EFFORTS.includes(item.effortMinutes)) err("effortMinutes", `effortMinutes must be one of ${EFFORTS.join(", ")}`);
	if (!DEPTHS.includes(item.reviewDepth)) err("reviewDepth", `reviewDepth must be one of ${DEPTHS.join(", ")}`);
	if (item.kind === "pr" && item.ci !== undefined && !CI.includes(item.ci)) err("ci", `ci must be one of ${CI.join(", ")}`);
	if (item.mergeable !== undefined && !MERGEABLE.includes(item.mergeable)) err("mergeable", `mergeable must be one of ${MERGEABLE.join(", ")}`);
	if (item.reviewDecision !== undefined && !DECISIONS.includes(item.reviewDecision)) {
		err("reviewDecision", `reviewDecision must be one of ${DECISIONS.join(", ")}`);
	}
	if (item.analyzedBy !== undefined && item.analyzedBy !== "fallback") err("analyzedBy", 'analyzedBy must be "fallback" when present');
	if (item.labels !== undefined && !(Array.isArray(item.labels) && item.labels.every((l) => typeof l === "string"))) {
		err("labels", "labels must be a list of strings");
	}

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
						if (isObject(c)) ids.add(c.id);
					});
				}
				if (params.event === "approve" && hasValidThread) warn("approve-valid-thread", `${where}: approves while a thread is judged valid`);
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
			case "take_over": {
				const refusal = takeOverRefusal(route);
				if (refusal) err("take-over", `${where}: ${refusal}`);
				if (item.kind !== "pr") err("take-over", `${where}: take_over works only on PRs`);
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

/** Item fields whose change needs a validation of the merged item. */
export const VALIDATED_FIELDS = ["routes", "threads", "hint", "findings"];
