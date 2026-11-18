// gary validate [<id> ...]: checks board items against the rules, read-only.
// Without ids it checks every item. --json prints the problems per item as JSON.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { boardDir, readJson } from "./lib/board-store.mjs";
import { loadProfile } from "./lib/config.mjs";
import { accountMode } from "./lib/gh.mjs";
import { validateItem } from "./lib/validate-item.mjs";

export async function main(argv) {
	const json = argv.includes("--json");
	const dir = join(boardDir(), "items");
	let ids = argv.filter((a) => !a.startsWith("--"));
	if (!ids.length) ids = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => n.slice(0, -5)).sort();

	const options = { mode: accountMode(), profile: loadProfile() };
	const results = [];
	for (const id of ids) {
		const item = await readJson(join(dir, id + ".json"));
		const { errors, warnings } = item ? validateItem(id, item, options) : { errors: [{ code: "unreadable", message: "missing or not a JSON object" }], warnings: [] };
		results.push({ id, errors, warnings });
	}

	const failed = results.filter((r) => r.errors.length);
	if (json) {
		console.log(JSON.stringify({ checked: results.length, failed: failed.length, items: results.filter((r) => r.errors.length || r.warnings.length) }, null, 2));
	} else {
		for (const r of results) {
			for (const e of r.errors) console.log(`error    ${r.id}: ${e.message}`);
			for (const w of r.warnings) console.log(`warning  ${r.id}: ${w.message}`);
		}
		const byCode = new Map();
		for (const r of results) for (const e of r.errors) byCode.set(e.code, [...(byCode.get(e.code) ?? []), r.id]);
		console.log(`\n${results.length} items checked, ${failed.length} fail`);
		for (const [code, list] of [...byCode].sort((a, b) => b[1].length - a[1].length)) {
			console.log(`  ${code.padEnd(20)} ${list.length}  ${[...new Set(list)].join(", ")}`);
		}
	}
	process.exitCode = failed.length ? 1 : 0;
}
