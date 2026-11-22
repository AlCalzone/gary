// The fix state of an issue or discussion: a fix job in progress, or a PR that fixes it, from every source Gary has.
// While a fix is working, a draft or an open PR, nothing may start another fix for the item.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ID_PATTERN, boardDir, readJson, writeAtomic } from "./board-store.mjs";
import { FIX_REVIEW_DEFAULTS, instanceDir, instanceName, loadInstance, stateDir } from "./config.mjs";
import { listClaims } from "./claims.mjs";

export const FIX_BY = ["routine", "maintainer"];
export const BLOCKING_FIX_STATES = ["working", "draft", "open"];
const fixesFile = () => join(stateDir(), "fixes.json");

/**
 * Gary's own record of the fix PRs it opened: `{ <itemId>: [{ number, url, branch, run, startedBy, at }] }`.
 * A record that moved from an escalated discussion to its issue also carries `from`, the discussion's item id.
 */
export async function readFixRecords() {
	const data = await readJson(fixesFile());
	return data ?? {};
}

// Serialize the updates within this process so none overwrites another
let updating = Promise.resolve();

/** Writes the records that `change` returns for the current ones. Writes nothing when it returns them unchanged. */
function updateFixRecords(change) {
	const next = updating.then(async () => {
		const records = await readFixRecords();
		const changed = change(records);
		if (changed !== records) await writeAtomic(fixesFile(), changed);
		return changed;
	});
	updating = next.catch(() => {});
	return next;
}

/** Records a fix PR for an item. The autofix skill calls it right after `gh pr create`. */
export async function recordFix({ itemId, number, branch, run, startedBy, repo }) {
	if (!ID_PATTERN.test(itemId ?? "")) throw new Error(`The item id must match ${ID_PATTERN}`);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("--pr must be a PR number");
	if (typeof branch !== "string" || !branch.trim() || branch.length > 250) throw new Error("--branch must name the PR's branch");
	if (typeof run !== "string" || !run.trim() || run.length > 200) throw new Error("--run must name the run");
	if (!FIX_BY.includes(startedBy)) throw new Error(`--by must be one of ${FIX_BY.join(", ")}`);
	const entry = { number, url: `https://github.com/${repo}/pull/${number}`, branch, run, startedBy, at: new Date().toISOString() };
	await updateFixRecords((records) => {
		const hit = fixRecordOf(records, number);
		// A record that moved to the issue stays there when the fix worker names the discussion
		const moved = hit?.record.from === itemId;
		const key = moved ? hit.itemId : itemId;
		const list = (records[key] ?? []).filter((r) => r.number !== number);
		return { ...records, [key]: [...list, moved ? { ...hit.record, ...entry } : entry] };
	});
	return entry;
}

/** The record of fix PR `number` as `{ itemId, record }`, or null when Gary recorded no such PR. */
export function fixRecordOf(records, number) {
	for (const [itemId, list] of Object.entries(records)) {
		const record = (list ?? []).find((r) => r?.number === number);
		if (record) return { itemId, record };
	}
	return null;
}

/** Notes on the record of fix PR `number` that Gary marked it ready for review. */
export async function recordFixReady(number, at = new Date().toISOString()) {
	await patchFixRecord(number, { readyAt: at });
}

/** Merges `patch` into the record of fix PR `number`. An undefined value removes the field. Throws without a record. */
export function patchFixRecord(number, patch) {
	return updateFixRecords((records) => {
		const hit = fixRecordOf(records, number);
		if (!hit) throw new Error(`PR #${number} is not a fix PR Gary recorded`);
		return { ...records, [hit.itemId]: records[hit.itemId].map((r) => (r.number === number ? { ...r, ...patch } : r)) };
	});
}

/** The numbers of the recorded fix PRs without a known end that are not among `openPrs`, the numbers of the repo's open PRs. */
export function vanishedFixPrs(records, openPrs) {
	const open = new Set(openPrs);
	return Object.values(records).flatMap((list) => list ?? []).filter((r) => Number.isSafeInteger(r?.number) && !r.ended && !open.has(r.number)).map((r) => r.number);
}

/** The records with the ones of `from` moved to `to`, each marked with `from`. The same object without any to move. */
export function movedRecords(records, from, to) {
	if (!records[from]?.length) return records;
	const { [from]: moving, ...rest } = records;
	const target = new Map((rest[to] ?? []).map((r) => [r.number, r]));
	for (const r of moving) target.set(r.number, { ...r, ...target.get(r.number), from });
	return { ...rest, [to]: [...target.values()] };
}

export const moveFixRecords = (from, to) => updateFixRecords((records) => movedRecords(records, from, to));

/** The records of an item, with the ones that moved from it to the issue it became. */
export function fixRecordsFor(records, itemId) {
	return Object.entries(records).flatMap(([id, list]) => (list ?? []).filter((r) => r && (id === itemId || r.from === itemId)));
}

/** The `fixFor` of a fix PR's item, for the item its record is under. */
export const fixForOf = (itemId, repo) => ({ itemId, ref: `${repo}#${itemId.split("-").pop()}` });

export const driveDir = (instance = instanceName()) => join(instanceDir(instance), "state", "drive");
/** The id of the board item of PR `number`. A drive file and its action doc are named by it. */
export const prItemId = (number) => `pr-${number}`;

/** The drive files of the instance by item id, from `<state>/drive/<itemId>.json`: waiting drives and watched PRs. */
export async function readDrives(instance = instanceName()) {
	let names = [];
	try {
		names = (await readdir(driveDir(instance))).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const out = {};
	for (const n of names) {
		const data = await readJson(join(driveDir(instance), n));
		if (data && ID_PATTERN.test(n.slice(0, -5))) out[n.slice(0, -5)] = data;
	}
	return out;
}

/** The item id each recorded fix PR is for, by PR number. */
export function fixPrNumbers(records) {
	const out = new Map();
	for (const [itemId, list] of Object.entries(records)) for (const r of list ?? []) if (Number.isSafeInteger(r?.number)) out.set(r.number, itemId);
	return out;
}

/** The entries of the staged snapshot, or of the baseline when nothing is staged. */
export async function readSnapshotItems() {
	for (const file of ["snapshot.pending.json", "snapshot.json"]) {
		const data = await readJson(join(stateDir(), file));
		if (data?.items) return data.items;
	}
	return {};
}

async function readActions() {
	const dir = join(boardDir(), "actions");
	let names = [];
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	return (await Promise.all(names.map(async (n) => ({ id: n.slice(0, -5), data: await readJson(join(dir, n)) })))).filter((d) => d.data);
}

/** Everything the fix states are computed from, read once. */
export async function loadFixSources(instance = instanceName()) {
	return {
		claims: (await listClaims({ instance })).filter((c) => c.kind === "fix" && !c.expired),
		actions: await readActions(),
		records: await readFixRecords(),
		drives: await readDrives(instance),
		snapshot: await readSnapshotItems(),
		repo: loadInstance(instance).repos[0],
	};
}

// The PR that blocks most wins: open or draft, then merged, then closed
const RANK = { draft: 3, open: 3, merged: 2, closed: 1 };

/**
 * The fix state of one issue or discussion, or null when nothing fixes it:
 * `{ state: "working" | "draft" | "open" | "merged" | "closed", pr: { number, url, title, isDraft, ci, author } | null, startedBy, since, parked }`.
 * `parked` is true while the fix keeps the item out of the day plan, see `parksItem`.
 */
export function fixStateOf(itemId, { claims, actions, records, snapshot, repo, drives = {} }) {
	const queued = actions.map((a) => a.data).filter((a) => a.itemId === itemId && a.action === "start_fix" && a.status === "queued");
	const claim = claims.find((c) => c.itemId === itemId);
	if (queued.length || claim) {
		// A board click queues a request. A claim without one is the routine's automatic fix
		const since = [claim?.at, ...queued.map((a) => a.createdAt)].filter(Boolean).sort()[0] ?? null;
		return { state: "working", pr: null, startedBy: queued.length ? "maintainer" : "routine", since, parked: true };
	}
	const entry = snapshot[itemId];
	const candidates = new Map();
	const add = (number, data) => candidates.set(number, { ...(candidates.get(number) ?? {}), ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) });
	// `ended` is the state a moved record's PR had when it got no closing reference. GitHub's links override it
	for (const r of fixRecordsFor(records, itemId)) add(r.number, { number: r.number, url: r.url, startedBy: r.startedBy, since: r.at, readyAt: r.readyAt, state: r.ended });
	for (const p of [...(entry?.closingPrs ?? []), ...(entry?.referencingPrs ?? [])]) add(p.number, { number: p.number, url: p.url, state: p.state, isDraft: p.isDraft, title: p.title, author: p.author, ci: p.ci });
	if (!candidates.size) return null;
	const prs = [...candidates.values()].map((p) => {
		// The PR's own snapshot entry is the freshest source for its live fields
		const own = snapshot[`pr-${p.number}`];
		const live = own ? { state: "open", isDraft: own.isDraft, ci: own.ci, title: own.title, author: own.author } : {};
		const merged = { ...p, ...Object.fromEntries(Object.entries(live).filter(([, v]) => v !== undefined)) };
		// Gary marked it ready after the snapshot was taken
		if (p.readyAt) merged.isDraft = false;
		// A recorded PR found nowhere else is taken as open, so it still blocks. The snapshot records `ended` once it left the open PRs
		const state = merged.state === "merged" ? "merged" : merged.state === "closed" ? "closed" : merged.isDraft ? "draft" : "open";
		return { ...merged, state };
	});
	prs.sort((a, b) => RANK[b.state] - RANK[a.state] || b.number - a.number);
	const best = prs[0];
	return {
		state: best.state,
		pr: { number: best.number, url: best.url ?? `https://github.com/${repo}/pull/${best.number}`, title: best.title ?? null, isDraft: best.isDraft ?? best.state === "draft", ci: best.ci ?? null, author: best.author ?? null },
		startedBy: best.startedBy ?? "other",
		since: best.since ?? null,
		parked: parksItem(best.state, best.since, entry?.lastThemAt),
		...(reviewStage(drives[prItemId(best.number)]) && { review: reviewStage(drives[prItemId(best.number)]) }),
	};
}

/**
 * The stage of the review rounds on a fix PR, from its drive file: `{ reviewer, round, maxRounds }`, or null
 * when no review bot round runs. `round` counts the review requested last over the PR's whole life.
 * A drive file in the stage "watch" only waits for the maintainer's feedback, so it has no stage.
 */
export function reviewStage(drive) {
	if (!drive || drive.by !== "fix") return null;
	if (drive.stage === "watch" || (drive.stage === undefined && typeof drive.reviewRequestedAt !== "string")) return null;
	const maxRounds = Number.isInteger(drive.maxRounds) ? drive.maxRounds : FIX_REVIEW_DEFAULTS.maxRounds;
	const requested = Number.isInteger(drive.copilotRounds) ? drive.copilotRounds : (Array.isArray(drive.rounds) ? drive.rounds.length : 0) + 1;
	return { reviewer: drive.reviewBot ?? "copilot", round: Math.min(requested, maxRounds), maxRounds };
}

/**
 * How many fixes the routine started on its own are pending: a recorded fix PR that is a draft or open,
 * or a fix job of the routine that runs. Fixes the maintainer started never count.
 */
export function pendingAutoFixes(sources) {
	const ids = new Set(Object.keys(sources.records));
	for (const c of sources.claims) ids.add(c.itemId);
	let count = 0;
	for (const id of ids) {
		const fix = fixStateOf(id, sources);
		if (fix && BLOCKING_FIX_STATES.includes(fix.state) && fix.startedBy === "routine") count++;
	}
	return count;
}

/**
 * Whether a fix in `state` keeps its issue or discussion out of the day plan. The fix PR's own item carries the work
 * while the PR is a draft or open. The item returns when the other side wrote after the fix PR was recorded.
 * A fix PR without a recorded time keeps the item out until the PR is merged or closed.
 */
export function parksItem(state, since, lastThemAt) {
	if (!BLOCKING_FIX_STATES.includes(state)) return false;
	if (state === "working") return true;
	return !(Date.parse(lastThemAt ?? "") > Date.parse(since ?? ""));
}

/** Why a new fix for the item must not start, or null. */
export function fixBlock(fix) {
	if (!fix || !BLOCKING_FIX_STATES.includes(fix.state)) return null;
	if (fix.state === "working") return `A fix for this item is already running, started by the ${fix.startedBy}${fix.since ? ` at ${fix.since}` : ""}.`;
	return `A fix for this item is already open as ${fix.state === "draft" ? "draft " : ""}PR #${fix.pr.number}${fix.pr.title ? ` "${fix.pr.title}"` : ""}: ${fix.pr.url}`;
}

/** The fix state of every issue and discussion on the board, in the fix records or with fix PRs in the snapshot. */
export async function fixStates(instance = instanceName()) {
	const sources = await loadFixSources(instance);
	let names = [];
	try {
		names = (await readdir(join(boardDir(instance), "items"))).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const ids = new Set(Object.keys(sources.records));
	// An escalated discussion stays listed with the fix PRs that moved to its issue
	for (const r of Object.values(sources.records).flat()) if (r?.from) ids.add(r.from);
	for (const n of names) {
		const id = n.slice(0, -5);
		const item = await readJson(join(boardDir(instance), "items", n));
		if (item && (item.kind === "issue" || item.kind === "discussion")) ids.add(id);
	}
	for (const [id, e] of Object.entries(sources.snapshot)) if (e?.closingPrs || e?.referencingPrs) ids.add(id);
	for (const c of sources.claims) ids.add(c.itemId);
	for (const { data: a } of sources.actions) if (a.action === "start_fix" && a.status === "queued" && typeof a.itemId === "string") ids.add(a.itemId);
	const out = {};
	for (const id of [...ids].sort()) {
		const fix = fixStateOf(id, sources);
		if (fix) out[id] = fix;
	}
	return out;
}
