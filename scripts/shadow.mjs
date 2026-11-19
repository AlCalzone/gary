// gary shadow record <file>: appends shadow comparison entries (one object or a list) to <state>/shadow.jsonl.
// gary shadow report [--since <ISO> | --week] [--json]: pairs the fast and standard answers per run and item and
// prints how often they agree and how often the fast tier handed the item up. A second part groups the
// maintainer's decisions from the decision log by the tier that classified the item.
// gary shadow propose [--dry-run]: writes the setting proposal that turns the fast tier on, or back to shadow, when the
// numbers of the report meet the bar. The numbers go into the proposal as they are, and the board builds the sentences.
// gary shadow convert <id> [--dry-run]: rebuilds a fast tier proposal that was written as a rule proposal.
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sendWrite } from "./board-put.mjs";
import { ID_PATTERN, boardDir, readJson } from "./lib/board-store.mjs";
import { instanceName, loadConfig, stateDir } from "./lib/config.mjs";
import { isSettingProposal, readDecisions, validateProposal } from "./lib/learning.mjs";
import { CLASSIFIERS } from "./lib/validate-item.mjs";

export const TIERS = ["fast", "standard"];
const FIELDS = ["at", "run", "itemId", "repo", "tier", "model", "section", "hasRoutes", "recommendedType", "handedUp", "reason", "sampled"];
// Below this many items per tier the decision rates say nothing
export const MIN_ITEMS = 20;
export const RECENT_PAIRS = 40;
export const MIN_SECTION_AGREEMENT = 0.95;
// A proposal to turn the fast tier on needs this many pairs
export const MIN_PAIRS = 40;
// The fast tier's override rate must exceed the standard tier's by this much before Gary proposes to switch back
export const OVERRIDE_MARGIN = 0.1;
const MAX_DIFFERENCES = 50;
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

/** The pair report since `since`, with the maintainer's decisions per tier as `decisions`. */
async function fullReport(since) {
	const r = buildReport(await readEntries(), { since });
	// readDecisions takes entries later than `since`, the shadow entries from `since` on
	r.decisions = decisionsByTier(await readBoardItems(), await readDecisions({ since: since && new Date(Date.parse(since) - 1).toISOString() }), { since });
	return r;
}

const SETTING_TITLES = { on: "Use the faster model for obvious items", shadow: "Go back to the standard model for all items" };

/** Why the report speaks for switching back to shadow: `agreement`, `overrides`, both or neither. */
export function switchBackReasons(report) {
	const reasons = [];
	const recent = report.recentSectionAgreement;
	if (recent.warning && recent.pairs >= MIN_ITEMS) reasons.push("agreement");
	const { fast, standard } = report.decisions ?? {};
	if (fast && standard && !fast.tooFew && !standard.tooFew && fast.any.rate >= standard.any.rate + OVERRIDE_MARGIN) reasons.push("overrides");
	return reasons;
}

/** The report's disagreements, one entry per item and pair of answers with the number of runs that showed it. */
export function differencesOf(report, boardItems = []) {
	const items = new Map(boardItems.map((i) => [i.id, i.data]));
	const groups = new Map();
	for (const d of report.disagreements) {
		const answer = (a) => ({ section: a.section ?? null, recommendedType: a.recommendedType ?? null });
		const diff = { itemId: d.itemId, fast: answer(d.fast), standard: answer(d.standard) };
		const key = JSON.stringify(diff);
		const item = items.get(d.itemId);
		const g = groups.get(key) ?? {
			itemId: d.itemId,
			...(Number.isInteger(item?.number) && item.number > 0 && { number: item.number }),
			...(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull|discussions)\/\d+$/.test(item?.url ?? "") && { url: item.url }),
			runs: 0,
			fast: diff.fast,
			standard: diff.standard,
		};
		g.runs++;
		groups.set(key, g);
	}
	return [...groups.values()].sort((a, b) => b.runs - a.runs).slice(0, MAX_DIFFERENCES);
}

/** Builds the setting proposal for `value` from a report. `reasons` belongs to a proposal that switches back. */
export function buildSettingProposal({ id, createdAt, value, report, boardItems, reasons = [] }) {
	const stats = {
		pairs: report.pairs,
		handedUp: report.handedUp,
		answered: report.compared,
		sameSection: report.sectionAgreement.same,
		sameRouteType: report.routeAgreement.same,
	};
	if (reasons.includes("agreement")) {
		const recent = report.recentSectionAgreement;
		stats.recent = { answered: recent.pairs, sameSection: recent.same, needed: Math.ceil(recent.pairs * MIN_SECTION_AGREEMENT) };
	}
	if (reasons.includes("overrides")) {
		const tier = (t) => ({ items: t.items, changed: t.any.count });
		stats.overrides = { fast: tier(report.decisions.fast), standard: tier(report.decisions.standard) };
	}
	return {
		id,
		createdAt,
		kind: "setting",
		setting: { key: "fastTier", value },
		title: SETTING_TITLES[value],
		stats,
		...(value === "shadow" && { reasons }),
		differences: differencesOf(report, boardItems),
		status: "open",
		decidedAt: null,
		reason: "",
	};
}

async function readProposals() {
	const dir = join(boardDir(), "proposals");
	let names = [];
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	return (await Promise.all(names.map((n) => readJson(join(dir, n))))).filter(Boolean);
}

// A fast tier proposal in the shape of a rule proposal, whose text tells the maintainer to edit the config
const isRuleShapedFastTier = (p) => p.kind === undefined && typeof p.text === "string" && p.text.includes("`fastTier`");

async function storeProposal(proposal, dryRun) {
	const problems = validateProposal(proposal.id, proposal);
	if (problems.length) throw new Error(`The proposal is invalid, nothing was written: ${problems.join(", ")}`);
	if (dryRun) return;
	const [status, body] = await sendWrite(instanceName(), { op: "set", path: `proposals/${proposal.id}`, data: proposal });
	if (status !== 200) throw new Error(body?.error ?? `The board server answered ${status}`);
}

async function propose(argv) {
	const dryRun = argv.includes("--dry-run");
	const none = (why) => console.log(JSON.stringify({ ok: true, written: false, why }));
	const tier = loadConfig().fastTier;
	if (tier === "off") return none("fastTier is off");
	const all = await readProposals();
	const open = all.find((p) => p.status === "open" && ((isSettingProposal(p) && p.setting?.key === "fastTier") || isRuleShapedFastTier(p)));
	if (open) return none(`${open.id} is still open`);
	// A decided proposal resets the count, so the next one rests only on what was recorded after it
	const decided = all.filter((p) => isSettingProposal(p) && p.setting?.key === "fastTier" && Number.isFinite(Date.parse(p.decidedAt ?? ""))).map((p) => Date.parse(p.decidedAt));
	const last = decided.length ? Math.max(...decided) : -Infinity;
	const value = tier === "shadow" ? "on" : "shadow";
	const from = value === "on" ? last : Math.max(last, Date.now() - WEEK_MS);
	const since = Number.isFinite(from) ? new Date(from).toISOString() : undefined;
	const report = await fullReport(since);
	const counts = { since: since ?? null, pairs: report.pairs, handedUp: report.handedUp, answered: report.compared, sameSection: report.sectionAgreement.same, sectionAgreement: report.sectionAgreement.share };
	let reasons = [];
	if (value === "on") {
		if (report.pairs < MIN_PAIRS) return console.log(JSON.stringify({ ok: true, written: false, why: `${report.pairs} pairs, fewer than ${MIN_PAIRS}`, ...counts }));
		if (!(report.sectionAgreement.share >= MIN_SECTION_AGREEMENT)) return console.log(JSON.stringify({ ok: true, written: false, why: `section agreement ${pct(report.sectionAgreement.share)} is below ${pct(MIN_SECTION_AGREEMENT)}`, ...counts }));
	} else {
		reasons = switchBackReasons(report);
		if (!reasons.length) return console.log(JSON.stringify({ ok: true, written: false, why: "the fast tier agrees with the standard tier and with the maintainer's decisions", ...counts }));
	}
	const now = new Date();
	const base = `learn-${now.toISOString().slice(0, 10)}-fast-tier-${value}`;
	const taken = new Set(all.map((p) => p.id));
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	const proposal = buildSettingProposal({ id, createdAt: now.toISOString(), value, report, boardItems: await readBoardItems(), reasons });
	await storeProposal(proposal, dryRun);
	console.log(JSON.stringify({ ok: true, written: !dryRun, id, value, ...counts, ...(dryRun && { proposal }) }));
}

async function convert(argv) {
	const dryRun = argv.includes("--dry-run");
	const id = argv.find((a) => !a.startsWith("--"));
	if (!id) throw new Error("Usage: gary shadow convert <proposal id> [--dry-run]");
	const old = (await readProposals()).find((p) => p.id === id);
	if (!old) throw new Error(`There is no proposal ${id}.`);
	if (isSettingProposal(old)) return console.log(JSON.stringify({ ok: true, written: false, why: `${id} is a setting proposal already` }));
	if (!isRuleShapedFastTier(old)) throw new Error(`${id} is a rule proposal that does not name fastTier. It stays as it is.`);
	const value = ["on", "shadow"].find((v) => old.text.includes(`\`"${v}"\``));
	if (!value) throw new Error(`The text of ${id} does not say which value fastTier should get.`);
	const report = await fullReport(value === "on" ? undefined : new Date(Date.now() - WEEK_MS).toISOString());
	const reasons = value === "shadow" ? switchBackReasons(report) : [];
	if (value === "shadow" && !reasons.length) throw new Error(`The report of the last week gives no reason to switch back, so ${id} cannot be rebuilt. Dismiss it on the board.`);
	const proposal = {
		...buildSettingProposal({ id, createdAt: old.createdAt, value, report, boardItems: await readBoardItems(), reasons }),
		status: old.status,
		decidedAt: old.decidedAt ?? null,
		reason: old.reason ?? "",
	};
	await storeProposal(proposal, dryRun);
	console.log(JSON.stringify({ ok: true, written: !dryRun, id, value, ...(dryRun && { proposal }) }));
}

async function report(argv) {
	const i = argv.indexOf("--since");
	const week = argv.includes("--week");
	if (week && i >= 0) throw new Error("Pass --since or --week, not both");
	const since = week ? new Date(Date.now() - WEEK_MS).toISOString() : i >= 0 ? argv[i + 1] : undefined;
	if (i >= 0 && !Number.isFinite(Date.parse(since ?? ""))) throw new Error("--since needs an ISO time");
	const r = await fullReport(since);
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
	if (sub === "propose") return propose(rest);
	if (sub === "convert") return convert(rest);
	throw new Error("Usage: gary shadow record <json file> | report [--since <ISO> | --week] [--json] | propose [--dry-run] | convert <proposal id> [--dry-run]");
}
