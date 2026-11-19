// Route rules shared by the board server and the item validator.

/** Allowed actors per route type. The first entry is the default when a route has no `as`. */
export const ROUTE_TYPES = {
	reply: ["me", "bot"],
	request_logs: ["bot", "me"],
	close: ["me"],
	reopen: ["bot", "me"],
	merge: ["me"],
	review: ["bot", "me"],
	address_review: ["agent"],
	follow_up: ["agent", "bot", "me"],
	take_over: ["agent"],
	revise: ["agent"],
	drive: ["agent"],
	format: ["agent"],
	move: ["bot", "me"],
	chore: ["bot"],
	open: ["me"],
};
export const DRIVE_AUTHORS = new Set(["maintainer", "bot", "copilot"]);
// Without a bot these turn into text the maintainer posts himself
export const PREFILL_TYPES = new Set(["reply", "request_logs", "reopen", "follow_up"]);
export const PUSHING_AGENT_TYPES = new Set(["address_review", "take_over", "revise", "drive", "follow_up", "format"]);
export const MOVE_MODES = ["transfer", "close"];
// What a discussion becomes after the escalate command. It only words the card, the repo's workflow picks the label
export const ISSUE_KINDS = ["bug", "enhancement"];
export const CHORE_ACTIONS = new Set(["label", "assign", "ready", "answer_discussion", "react", "update_branch", "rerun_ci"]);

/** The route's actor, or undefined when the type is unknown or the given `as` is not allowed for it. */
export function actorOf(route) {
	const allowed = ROUTE_TYPES[route?.type];
	if (!allowed) return undefined;
	if (route.type === "move") {
		// The target decides who acts: GitHub has no API to convert between issues and discussions
		const to = route.params?.to;
		const as = to === "discussion" || to === "issue" ? "me" : typeof to === "string" ? "bot" : undefined;
		return route.as === undefined || route.as === as ? as : undefined;
	}
	// follow_up has more than one sensible actor, so it needs an explicit `as`
	if (route.as === undefined) return route.type === "follow_up" ? undefined : allowed[0];
	return allowed.includes(route.as) ? route.as : undefined;
}

export const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Who acts after a click, given the configured accounts (`mode` from accountMode()):
 * "me" (prefill, he acts on GitHub), "bot", "own" (his stored gh login, only with allowOwnTokenPushes),
 * "agent", "unavailable" (needs a bot or allowOwnTokenPushes), or undefined for an invalid route.
 * A move to a repository has one actor per button, so pass its `moveMode` ("transfer" or "close").
 */
export function effectiveActor(route, mode, moveMode) {
	const as = actorOf(route);
	if (as === "me" && route.type === "review" && Array.isArray(route.params?.comments) && route.params.comments.length) return undefined;
	if (as === undefined || as === "me") return as;
	if (as === "agent") return mode === "none" && PUSHING_AGENT_TYPES.has(route.type) ? "unavailable" : "agent";
	if (mode === "bot") return "bot";
	if (route.type === "move") {
		if (moveMode === "close") return "me";
		return mode === "own" ? "own" : "unavailable";
	}
	const comments = Array.isArray(route.params?.comments) ? route.params.comments : [];
	if (PREFILL_TYPES.has(route.type) || (route.type === "review" && !comments.length)) return "me";
	return mode === "own" ? "own" : "unavailable";
}

/**
 * Why the agent may not push our commits to this PR, or null when it may.
 * Pushing to a contributor's PR is always a take-over, so a contributor PR needs `takenOver: true` first.
 */
export function pushRefusal(item, what = "This route") {
	if (item?.kind !== "pr") return `${what} works only on PRs.`;
	if (!DRIVE_AUTHORS.has(item.authorType) && item.takenOver !== true) {
		return `${what} is only for PRs by the maintainer, a bot or Copilot, or taken-over PRs. Use take_over on a contributor PR.`;
	}
	return null;
}

/**
 * Why the server refuses a format route on this item, or null when it accepts it. Applying the project's own
 * autofix to a contributor's PR does not take it over, so neither pushRefusal nor `takenOver` applies here.
 */
export function formatRefusal(item) {
	if (item?.kind !== "pr") return "format works only on PRs.";
	if (item.autofix?.changes !== true) return "format needs the snapshot's autofix check to have found changes.";
	// The worker compares it with the PR head and refuses when the head moved since the check
	if (typeof item.reviewedSha !== "string" || !/^[0-9a-f]{7,64}$/.test(item.reviewedSha)) return "format needs the item's reviewedSha.";
	return null;
}

/** Why the server refuses a drive on this item, or null when it accepts it. */
export function driveRefusal(item, maxRounds = 3) {
	const refusal = pushRefusal(item, "drive");
	if (refusal) return refusal;
	if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 3) return "drive needs maxRounds from 1 to 3.";
	return null;
}

/** Why the server refuses a revise route with these instructions on this item, or null when it accepts it. */
export function reviseRefusal(item, text) {
	const refusal = pushRefusal(item, "revise");
	if (refusal) return refusal;
	if (!(typeof text === "string" && text.trim())) return "revise needs a text that says what to change.";
	return null;
}

/** Why the server refuses this take_over route on this item, or null when it accepts it. */
export function takeOverRefusal(route, item) {
	if (item?.kind !== "pr") return "take_over works only on PRs.";
	// A PR we already control has nothing to take over
	if (!pushRefusal(item)) return "take_over is only for contributor PRs that are not taken over. Use revise on this PR.";
	const mode = route?.params?.mode ?? "push";
	if (mode !== "push" && mode !== "replace") return 'take_over needs params.mode "push" or "replace".';
	if (mode === "replace" && !(typeof route.callout === "string" && route.callout.trim())) {
		return "A replacement PR needs a callout that says why pushing is not possible.";
	}
	return null;
}

/**
 * The route as the server serves and runs it. A stored take_over that pushes to a PR we already control
 * becomes a revise with the same id, text and params, so its draft hash stays the same.
 */
export function servedRoute(route, item) {
	if (route?.type !== "take_over" || (route.params?.mode ?? "push") !== "push" || pushRefusal(item)) return route;
	const title = typeof route.title === "string" ? route.title.replace(/^Take over\b/, "Change") : route.title;
	return { ...route, type: "revise", title };
}

/**
 * The body GitHub gets for one inline review comment: its text, then a suggestion block when it has `suggestion`.
 * The fence is one backtick longer than the longest backtick run that starts a line of the suggestion, and at least three.
 */
export function commentBody(comment) {
	const text = typeof comment?.text === "string" ? comment.text : "";
	if (typeof comment?.suggestion !== "string") return text;
	const longest = Math.max(0, ...comment.suggestion.split("\n").map((l) => /^`*/.exec(l)[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	const block = `${fence}suggestion\n${comment.suggestion}\n${fence}`;
	return text ? `${text}\n\n${block}` : block;
}
