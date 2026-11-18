// gary shadow record <file>: appends shadow comparison entries (one object or a list) to <state>/shadow.jsonl.
// gary shadow report [--since <ISO> | --week] [--json]: pairs the fast and standard answers per run and item and
// prints how often they agree and how often the fast tier handed the item up. A second part groups the
// maintainer's decisions from the decision log by the tier that classified the item.
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ID_PATTERN, boardDir, readJson } from "./lib/board-store.mjs";
import { stateDir } from "./lib/config.mjs";
import { readDecisions } from "./lib/learning.mjs";
import { CLASSIFIERS } from "./lib/validate-item.mjs";

export const TIERS = ["fast", "standard"];
const FIELDS = ["at", "run", "itemId", "repo", "tier", "model", "section", "hasRoutes", "recommendedType", "handedUp", "reason", "sampled"];
// Below this many items per tier the decision rates say nothing
export const MIN_ITEMS = 20;
export const RECENT_PAIRS = 40;
export const MIN_SECTION_AGREEMENT = 0.95;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const shadowFile = () => join(stateDir(), "shadow.jsonl");

const isString = (v) => typeof v === "string" && v.trim().length > 0;
const isStringOrNull = (v) => v === null || isString(v);

/** The problems of one entry. A fast answer that handed up may leave section and recommendedType null. */
export function validateShadowEntry(e) {
	if (!e || typeof e !== "object" || Array.isArray(e)) return ["an entry must be a JSON object"];
	const p = [];
	for (const key of Object.keys(e)) if (!FIELDS.includes(key)) p.push(`unknown field "${key}"`);
	if (!Number.isFinite(Date.parse(e.at ?? ""))) p.push("at must be an ISO time");
	if (!isString(e.run)) p.push("run must name the run");
	if (typeof e.itemId !== "string" || !ID_PATTERN.test(e.itemId)) p.push(`itemId must match ${ID_PATTERN}`);
	if (typeof e.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(e.repo)) p.push('repo must look like "owner/name"');
	if (!TIERS.includes(e.tier)) p.push(`tier must be one of ${TIERS.join(", ")}`);
	if (!isString(e.model)) p.push("model must name the model");
	if (typeof e.handedUp !== "boolean") p.push("handedUp must be true or false");
	if (e.tier === "standard" && e.handedUp === true) p.push("only the fast tier hands up");
	if (typeof e.hasRoutes !== "boolean") p.push("hasRoutes must be true or false");
	if (!isStringOrNull(e.section ?? null) || (!e.handedUp && !isString(e.section))) p.push("section is required unless the fast tier handed up");
	if (!isStringOrNull(e.recommendedType ?? null)) p.push("recommendedType must be a route type or null");
	if (e.hasRoutes === true && !e.handedUp && !isString(e.recommendedType)) p.push("recommendedType is required when the answer has routes");
	if (e.reason !== undefined && !isStringOrNull(e.reason)) p.push("reason must be a string or null");
	if (e.sampled !== undefined && typeof e.sampled !== "boolean") p.push("sampled must be true or false");
	return p;
}

async function readEntries() {
	let text = "";
	try {
		text = await readFile(shadowFile(), "utf8");
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	return text.split("\n").filter((l) => l.trim()).flatMap((l) => {
		try {
			return [JSON.parse(l)];
		} catch {
			return [];
		}
	});
}

const share = (n, of) => (of ? Math.round((n / of) * 1000) / 1000 : null);

/** Pairs the latest fast and standard entry per run and item, oldest pair first. */
export function buildReport(entries, { since } = {}) {
	const from = since ? Date.parse(since) : -Infinity;
	const groups = new Map();
	for (const e of entries) {
		if (!(Date.parse(e.at) >= from)) continue;
		const key = `${e.run}\u0000${e.itemId}`;
		const g = groups.get(key) ?? {};
		if (!g[e.tier] || Date.parse(g[e.tier].at) <= Date.parse(e.at)) g[e.tier] = e;
		groups.set(key, g);
	}
	const pairs = [...groups.values()].filter((g) => g.fast && g.standard).sort((a, b) => Date.parse(a.standard.at) - Date.parse(b.standard.at));
	const answered = pairs.filter((p) => !p.fast.handedUp);
	const sameSection = answered.filter((p) => p.fast.section === p.standard.section).length;
	const sameRoute = answered.filter((p) => (p.fast.recommendedType ?? null) === (p.standard.recommendedType ?? null)).length;
	const answer = (e) => ({ model: e.model, section: e.section ?? null, hasRoutes: e.hasRoutes, recommendedType: e.recommendedType ?? null, reason: e.reason ?? null });
	const recent = answered.slice(-RECENT_PAIRS);
	const recentSame = recent.filter((p) => p.fast.section === p.standard.section).length;
	const recentShare = share(recentSame, recent.length);
	return {
		pairs: pairs.length,
		sampledPairs: pairs.filter((p) => p.fast.sampled === true || p.standard.sampled === true).length,
		// The fast tier decided these itself, so a wrong section there reaches the board
		recentSectionAgreement: { pairs: recent.length, same: recentSame, share: recentShare, warning: recentShare !== null && recentShare < MIN_SECTION_AGREEMENT },
		handedUp: pairs.length - answered.length,
		handedUpShare: share(pairs.length - answered.length, pairs.length),
		// Agreement counts only the pairs where the fast tier answered itself
		compared: answered.length,
		sectionAgreement: { same: sameSection, share: share(sameSection, answered.length) },
		routeAgreement: { same: sameRoute, share: share(sameRoute, answered.length) },
		disagreements: answered
			.filter((p) => p.fast.section !== p.standard.section || (p.fast.recommendedType ?? null) !== (p.standard.recommendedType ?? null))
			.map((p) => ({ run: p.standard.run, itemId: p.standard.itemId, repo: p.standard.repo, fast: answer(p.fast), standard: answer(p.standard) })),
	};
}

// The decision types that say the maintainer did not take the agent's proposal as it was
const DEVIATIONS = {
	dismissedRecommended: (e) => e.type === "dismissed_route" && e.wasRecommended === true,
	choseAlternative: (e) => e.type === "chose_alternative",
	editedText: (e) => e.type === "edited_text",
};

/**
 * The maintainer's decisions per tier that classified the item. `items` are the board items with that
 * `classifiedBy` that were reviewed since `since`, plus the items the log names with it.
 */
export function decisionsByTier(boardItems, decisions, { since } = {}) {
	const from = since ? Date.parse(since) : -Infinity;
	const tiers = Object.fromEntries(CLASSIFIERS.map((t) => [t, { items: new Set(), ...Object.fromEntries(Object.keys(DEVIATIONS).map((k) => [k, new Set()])), any: new Set() }]));
	for (const { id, data } of boardItems) {
		const tier = tiers[data?.classifiedBy];
		if (!tier) continue;
		const at = Date.parse(data.reviewedAt ?? "");
		if (!Number.isFinite(at) || at >= from) tier.items.add(id);
	}
	for (const e of decisions) {
		const tier = tiers[e.item?.classifiedBy];
		if (!tier || typeof e.itemId !== "string") continue;
		tier.items.add(e.itemId);
		for (const [key, test] of Object.entries(DEVIATIONS)) {
			if (test(e)) {
				tier[key].add(e.itemId);
				tier.any.add(e.itemId);
			}
		}
	}
	const out = {};
	for (const [name, t] of Object.entries(tiers)) {
		const n = t.items.size;
		const count = (set) => ({ count: set.size, rate: share(set.size, n), itemIds: [...set].sort() });
		out[name] = {
			items: n,
			itemIds: [...t.items].sort(),
			tooFew: n < MIN_ITEMS,
			...Object.fromEntries([...Object.keys(DEVIATIONS), "any"].map((k) => [k, count(t[k])])),
		};
	}
	return out;
}

async function readBoardItems() {
	const dir = join(boardDir(), "items");
	let names = [];
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	return Promise.all(names.map(async (n) => ({ id: n.slice(0, -".json".length), data: await readJson(join(dir, n)) })));
}

async function record(file) {
	if (!file) throw new Error("Usage: gary shadow record <json file>");
	let data;
	try {
		data = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		throw new Error(`Cannot read ${file}: ${e.message}`);
	}
	const list = Array.isArray(data) ? data : [data];
	const problems = list.flatMap((e, i) => validateShadowEntry(e).map((m) => (list.length > 1 ? `[${i}] ${m}` : m)));
	if (problems.length) {
		console.log(JSON.stringify({ ok: false, error: "The shadow entries are invalid, nothing was written", problems }));
		process.exitCode = 1;
		return;
	}
	await mkdir(stateDir(), { recursive: true });
	const lines = list.map((e) => JSON.stringify(Object.fromEntries(FIELDS.filter((k) => k in e).map((k) => [k, e[k]])))).join("\n") + "\n";
	await appendFile(shadowFile(), lines);
	console.log(JSON.stringify({ ok: true, recorded: list.length }));
}

const pct = (s) => (s === null ? "-" : `${Math.round(s * 100)}%`);

async function report(argv) {
	const i = argv.indexOf("--since");
	const week = argv.includes("--week");
	if (week && i >= 0) throw new Error("Pass --since or --week, not both");
	const since = week ? new Date(Date.now() - WEEK_MS).toISOString() : i >= 0 ? argv[i + 1] : undefined;
	if (i >= 0 && !Number.isFinite(Date.parse(since ?? ""))) throw new Error("--since needs an ISO time");
	const r = buildReport(await readEntries(), { since });
	// readDecisions takes entries later than `since`, the shadow entries from `since` on
	r.decisions = decisionsByTier(await readBoardItems(), await readDecisions({ since: since && new Date(Date.parse(since) - 1).toISOString() }), { since });
	if (argv.includes("--json")) return console.log(JSON.stringify({ since: since ?? null, ...r }, null, 2));
	console.log(`${r.pairs} pairs${since ? ` since ${since}` : ""}, ${r.sampledPairs} of them from sampling`);
	console.log(`fast tier handed up: ${r.handedUp} (${pct(r.handedUpShare)})`);
	console.log(`same section:        ${r.sectionAgreement.same} of ${r.compared} (${pct(r.sectionAgreement.share)})`);
	console.log(`same route type:     ${r.routeAgreement.same} of ${r.compared} (${pct(r.routeAgreement.share)})`);
	for (const d of r.disagreements) {
		console.log(`\n${d.itemId} (${d.repo}), run ${d.run}`);
		for (const tier of TIERS) {
			const a = d[tier];
			console.log(`  ${tier.padEnd(8)} ${a.section ?? "-"} / ${a.recommendedType ?? "no route"} (${a.model})${a.reason ? `: ${a.reason}` : ""}`);
		}
	}
	const recent = r.recentSectionAgreement;
	if (recent.warning) {
		console.log(`\nWarning: the fast tier picked the standard tier's section in only ${recent.same} of the last ${recent.pairs} pairs it decided itself (${pct(recent.share)}, below ${pct(MIN_SECTION_AGREEMENT)})`);
	}

	console.log("\nYour decisions by tier");
	for (const [name, t] of Object.entries(r.decisions)) {
		const part = (label, c) => `${label} ${c.count} (${pct(c.rate)})`;
		console.log(`${name.padEnd(9)} ${String(t.items).padStart(4)} items: ${[part("dismissed the recommended route", t.dismissedRecommended), part("chose another route", t.choseAlternative), part("edited the text", t.editedText), part("any of these", t.any)].join(", ")}`);
		if (t.tooFew) console.log(`          fewer than ${MIN_ITEMS} items, too few to mean anything`);
	}
}

export async function main(argv) {
	const [sub, ...rest] = argv;
	if (sub === "record") return record(rest[0]);
	if (sub === "report") return report(rest);
	throw new Error("Usage: gary shadow record <json file> | gary shadow report [--since <ISO>] [--json]");
}
