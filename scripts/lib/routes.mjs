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
	drive: ["agent"],
	move: ["bot", "me"],
	chore: ["bot"],
};
export const DRIVE_AUTHORS = new Set(["maintainer", "bot", "copilot"]);
// Without a bot these turn into text the maintainer posts himself
export const PREFILL_TYPES = new Set(["reply", "request_logs", "reopen", "follow_up"]);
export const PUSHING_AGENT_TYPES = new Set(["address_review", "take_over", "drive", "follow_up"]);
export const MOVE_MODES = ["transfer", "close"];
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

/** Why the server refuses a drive on this item, or null when it accepts it. */
export function driveRefusal(item, maxRounds = 3) {
	const refusal = pushRefusal(item, "drive");
	if (refusal) return refusal;
	if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 3) return "drive needs maxRounds from 1 to 3.";
	return null;
}

/** Why the server refuses this take_over route, or null when it accepts it. */
export function takeOverRefusal(route) {
	const mode = route?.params?.mode ?? "push";
	if (mode !== "push" && mode !== "replace") return 'take_over needs params.mode "push" or "replace".';
	if (mode === "replace" && !(typeof route.callout === "string" && route.callout.trim())) {
		return "A replacement PR needs a callout that says why pushing is not possible.";
	}
	return null;
}
