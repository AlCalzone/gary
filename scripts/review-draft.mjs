// The review drafts of a contributions instance, for PRs that request the maintainer's review.
//   gary review-draft plan --snapshot <run>/snapshot.json
//     Decides which drafts start in this run without a click, records each start and each hold, and prints
//     { ok, start: [{ id, repo, number, request }], held: [{ id, code, message }], skipped: [{ id, code }] }.
//   gary review-draft list [--json]
//     The records with what the board shows for each.
// Exit codes: 0 done, 3 not a contributions instance, 1 everything else.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { boardDir, readJson } from "./lib/board-store.mjs";
import { instanceName, loadConfig } from "./lib/config.mjs";
import { readSnapshotItems } from "./lib/fixes.mjs";
import { planDrafts, readReviewDrafts, reviewDraftSettings, reviewDraftState } from "./lib/review-drafts.mjs";

const USAGE = "Usage: gary review-draft plan --snapshot <run>/snapshot.json | list [--json]";

async function boardItems() {
	const dir = join(boardDir(), "items");
	let names = [];
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const out = {};
	for (const n of names) out[n.slice(0, -".json".length)] = await readJson(join(dir, n));
	return out;
}

export async function main(argv) {
	const config = loadConfig();
	if (config.kind !== "contributions") {
		const result = `gary review-draft is for a contributions instance. ${instanceName()} is a maintainer instance.`;
		console.log(JSON.stringify({ ok: false, kind: config.kind, result }));
		process.exitCode = 3;
		return;
	}
	const [sub, ...rest] = argv;
	if (sub === "plan") {
		const i = rest.indexOf("--snapshot");
		if (i < 0 || !rest[i + 1]) throw new Error(USAGE);
		const work = JSON.parse(await readFile(rest[i + 1], "utf8"));
		const out = await planDrafts({ changed: work.changed ?? [], entries: await readSnapshotItems(), items: await boardItems(), settings: reviewDraftSettings(config), me: config.me });
		console.log(JSON.stringify({ ok: true, ...out }));
		return;
	}
	if (sub === "list") {
		const records = await readReviewDrafts();
		const items = await boardItems();
		const entries = await readSnapshotItems();
		const rows = Object.entries(records).map(([id, record]) => ({ id, ...record, board: items[id] ? reviewDraftState(items[id], record, entries[id]) : null }));
		if (rest.includes("--json")) return console.log(JSON.stringify(rows, null, 2));
		if (!rows.length) return console.log("No review drafts.");
		for (const r of rows) console.log(`${r.id}  ${r.board?.state ?? "no item"}${r.held ? `  ${r.held.message}` : ""}`);
		return;
	}
	throw new Error(USAGE);
}
