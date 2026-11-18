// gary shadow record <file>: appends shadow comparison entries (one object or a list) to <state>/shadow.jsonl.
// gary shadow report [--since <ISO>] [--json]: pairs the fast and standard answers per run and item and
// prints how often they agree and how often the fast tier handed the item up.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ID_PATTERN } from "./lib/board-store.mjs";
import { stateDir } from "./lib/config.mjs";

export const TIERS = ["fast", "standard"];
const FIELDS = ["at", "run", "itemId", "repo", "tier", "model", "section", "hasRoutes", "recommendedType", "handedUp", "reason"];
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
	const share = (n, of) => (of ? Math.round((n / of) * 1000) / 1000 : null);
	return {
		pairs: pairs.length,
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
	const since = i >= 0 ? argv[i + 1] : undefined;
	if (i >= 0 && !Number.isFinite(Date.parse(since ?? ""))) throw new Error("--since needs an ISO time");
	const r = buildReport(await readEntries(), { since });
	if (argv.includes("--json")) return console.log(JSON.stringify(r, null, 2));
	console.log(`${r.pairs} pairs${since ? ` since ${since}` : ""}`);
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
}

export async function main(argv) {
	const [sub, ...rest] = argv;
	if (sub === "record") return record(rest[0]);
	if (sub === "report") return report(rest);
	throw new Error("Usage: gary shadow record <json file> | gary shadow report [--since <ISO>] [--json]");
}
