// The reconcile pass: the names rules may refer to, and when a pass is due. See "Reconcile" in SPEC.md.
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_ACTIONS } from "./actions.mjs";
import { writeAtomic } from "./board-store.mjs";
import { CATEGORIES, OLD_SECTIONS, categoryFromSection } from "./categories.mjs";
import { instanceDir, instanceName } from "./config.mjs";
import { ROUTE_TYPES } from "./routes.mjs";

export const RECONCILE_INTERVAL_MS = 7 * 86400000;
// A pass that started this long ago and never finished counts as dead
export const RECONCILE_RUN_MS = 2 * 3600000;

// The item fields a rule can name. Keep this list by hand: a field that leaves it makes the next pass look for rules that name it
const ITEM_FIELDS = [
	"kind", "repo", "number", "title", "url", "author", "authorType", "category", "needsHardware", "discussionCategory", "ciOptionalFailing", "priority",
	"effortMinutes", "waitingOn", "dueAt", "dueSource", "series", "reviewDepth", "classifiedBy", "analyzedBy", "state", "hint", "routes",
	"threads", "findings", "wants", "wantsReason", "handled", "pushed", "reviewedSha", "takenOver", "blocked", "dismissedRoutes",
	"story", "links", "solved", "waitingDays", "rounds",
];

/** The names a rule may refer to today, by kind. */
export function currentNames() {
	return {
		category: [...CATEGORIES],
		flag: ["needsHardware"],
		routeType: Object.keys(ROUTE_TYPES),
		agentAction: [...AGENT_ACTIONS],
		itemField: [...ITEM_FIELDS],
	};
}

/** The names that no longer exist, each with what replaced it. */
export function retiredNames() {
	return {
		section: Object.fromEntries(OLD_SECTIONS.map((s) => [s, s === "hardware" ? "category decide with needsHardware" : s === "review" ? "category unblock for contributors, land otherwise" : `category ${categoryFromSection(s)}`])),
		itemField: { section: "category" },
	};
}

/** Every current name as `<kind>:<name>`. */
export function namesList(names = currentNames()) {
	return Object.entries(names).flatMap(([kind, list]) => list.map((n) => `${kind}:${n}`)).sort();
}

export const namesHash = (list = namesList()) => createHash("sha256").update(list.join("\n")).digest("hex").slice(0, 16);

export const reconcileFile = (instance = instanceName()) => join(instanceDir(instance), "state", "reconcile.json");

const isIso = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));

export async function readReconcile(instance = instanceName()) {
	try {
		const data = JSON.parse(await readFile(reconcileFile(instance), "utf8"));
		return data && typeof data === "object" && !Array.isArray(data) ? data : {};
	} catch (e) {
		if (e.code === "ENOENT" || e instanceof SyntaxError) return {};
		throw e;
	}
}

async function writeReconcile(instance, data) {
	const file = reconcileFile(instance);
	await mkdir(join(instanceDir(instance), "state"), { recursive: true });
	await writeAtomic(file, data);
}

/**
 * Says whether a pass is due, and why. `reasons` holds `interval` when the last pass is 7 days old or missing,
 * `names` when a name the last pass knew is gone or no pass ran yet, and `requested` when the maintainer asked after the last pass.
 * A pass that started in the last 2 hours and did not finish makes `due` false and sets `running`.
 */
export function reconcileDue(state = {}, { now = Date.now(), list = namesList() } = {}) {
	const last = isIso(state.lastReconcileAt) ? Date.parse(state.lastReconcileAt) : null;
	const reasons = [];
	if (last === null || now - last >= RECONCILE_INTERVAL_MS) reasons.push("interval");
	const known = Array.isArray(state.names) ? state.names : null;
	const current = new Set(list);
	const removed = known ? known.filter((n) => !current.has(n)) : [];
	if (!known || removed.length) reasons.push("names");
	if (isIso(state.requestedAt) && (last === null || Date.parse(state.requestedAt) > last)) reasons.push("requested");
	const started = isIso(state.startedAt) ? Date.parse(state.startedAt) : null;
	const running = started !== null && (last === null || started > last) && now - started < RECONCILE_RUN_MS;
	return { due: reasons.length > 0 && !running, reasons, running, removed, lastReconcileAt: state.lastReconcileAt ?? null, reviewedUntil: state.reviewedUntil ?? null, namesHash: namesHash(list), storedNamesHash: state.namesHash ?? null };
}

/** Records the maintainer's request. The queue watcher prints it, so the master starts a pass. */
export async function requestReconcile(instance = instanceName(), at = new Date().toISOString()) {
	const state = await readReconcile(instance);
	await writeReconcile(instance, { ...state, requestedAt: at });
	return at;
}

/** Marks a pass as started. Returns false when another pass runs. */
export async function startReconcile(instance = instanceName(), now = Date.now()) {
	const state = await readReconcile(instance);
	if (reconcileDue(state, { now }).running) return false;
	await writeReconcile(instance, { ...state, startedAt: new Date(now).toISOString() });
	return true;
}

/**
 * Marks a pass as done: the last run time is its start, so a request during the pass stays due.
 * The names of today become the ones the next pass compares with.
 */
export async function finishReconcile(instance = instanceName(), { reviewedUntil, now = Date.now() } = {}) {
	if (reviewedUntil !== undefined && reviewedUntil !== null && !isIso(reviewedUntil)) throw new Error("--until needs an ISO time");
	const state = await readReconcile(instance);
	const list = namesList();
	const at = isIso(state.startedAt) && Date.parse(state.startedAt) <= now ? state.startedAt : new Date(now).toISOString();
	const next = { ...state, lastReconcileAt: at, names: list, namesHash: namesHash(list) };
	if (reviewedUntil) next.reviewedUntil = reviewedUntil;
	delete next.startedAt;
	await writeReconcile(instance, next);
	return next;
}
