// Usage: gary api-edit --pr <number> [--route <id>]
//        gary api-edit --pr <number> --sha <head sha> --file <route.json>
// Checks the API edit of a take_over or revise route against GitHub and prints what the click would commit.
// The first form reads the route from the stored item, the second a draft route `{ params, text }` before it is stored.
// It never commits. Only the click on the board does.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runApiEdit } from "./lib/api-edit.mjs";
import { boardDir, readJson } from "./lib/board-store.mjs";
import { instanceName, loadInstance } from "./lib/config.mjs";
import { prItemId } from "./lib/fixes.mjs";
import { isApiEdit, isObject } from "./lib/routes.mjs";

const USAGE = "Usage: gary api-edit --pr <number> [--route <id>] | --pr <number> --sha <head sha> --file <route.json>";
const OPTIONS = ["--pr", "--route", "--sha", "--file"];

function options(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (!OPTIONS.includes(argv[i]) || argv[i + 1] === undefined) throw new Error(USAGE);
		out[argv[i].slice(2)] = argv[++i];
	}
	return out;
}

/** The route to check and the head it was written for, from a draft file or from the stored item. */
async function routeOf(opts, number) {
	if (opts.file !== undefined) {
		if (opts.route !== undefined || opts.sha === undefined) throw new Error(USAGE);
		let route;
		try {
			route = JSON.parse(readFileSync(opts.file, "utf8"));
		} catch (e) {
			throw new Error(`Cannot read the route from ${opts.file}: ${e.message}`);
		}
		if (!isObject(route)) throw new Error("The route file must hold one JSON object { params, text }");
		return { route, sha: opts.sha };
	}
	if (opts.sha !== undefined) throw new Error(USAGE);
	const item = await readJson(join(boardDir(), "items", prItemId(number) + ".json"));
	if (!item) throw new Error(`PR #${number} is not on the board`);
	const routes = (Array.isArray(item.routes) ? item.routes : []).filter((r) => isApiEdit(r) && (opts.route === undefined || r.id === opts.route));
	if (routes.length !== 1) throw new Error(opts.route === undefined ? `PR #${number} has ${routes.length} API edit routes. Name one with --route` : `PR #${number} has no API edit route ${opts.route}`);
	return { route: routes[0], sha: item.reviewedSha };
}

export async function main(argv) {
	let outcome;
	try {
		const opts = options(argv);
		const number = Number(opts.pr);
		if (!Number.isSafeInteger(number) || number <= 0) throw new Error(USAGE);
		const { route, sha } = await routeOf(opts, number);
		const run = await runApiEdit({ repo: loadInstance(instanceName()).repos[0], number, reviewedSha: sha, params: route.params, text: typeof route.text === "string" ? route.text : "", dryRun: true });
		outcome = !run.ok ? run : {
			ok: true,
			dryRun: true,
			message: route.params.message,
			files: run.paths,
			diff: route.params.edits.map((e) => [`--- ${e.path}`, ...e.original.split("\n").map((l) => `-${l}`), ...e.replacement.split("\n").map((l) => `+${l}`)].join("\n")).join("\n"),
			invocations: run.invocations,
		};
	} catch (e) {
		outcome = { ok: false, result: e.message };
	}
	console.log(JSON.stringify(outcome, null, 2));
	process.exitCode = outcome.ok ? 0 : outcome.paused ? 4 : 1;
}
