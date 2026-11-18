// gary handled [--json]: lists the items the maintainer handled on the board, with what the last check saw and
// whether the thread changed on GitHub since, per the staged snapshot or the baseline. Read-only.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { boardDir, readJson } from "./lib/board-store.mjs";
import { stateDir } from "./lib/config.mjs";

async function snapshotItems() {
	for (const file of ["snapshot.pending.json", "snapshot.json"]) {
		const data = await readJson(join(stateDir(), file));
		if (data?.items) return data.items;
	}
	return {};
}

/** Whether the snapshot entry shows a change after `at`: a newer updatedAt or timeline event. Null without an entry. */
export function changedSince(entry, at) {
	if (!entry) return null;
	const since = Date.parse(at);
	return [entry.updatedAt, entry.lastEventAt].some((t) => Date.parse(t ?? "") > since);
}

export async function main(argv) {
	const dir = join(boardDir(), "items");
	let names = [];
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const snapshot = await snapshotItems();
	const rows = [];
	for (const n of names.sort()) {
		const id = n.slice(0, -".json".length);
		const item = await readJson(join(dir, n));
		if (!item?.handled) continue;
		rows.push({ id, repo: item.repo ?? null, kind: item.kind, number: item.number, handled: item.handled, live: item.live ?? null, changedSince: changedSince(snapshot[id], item.handled.at) });
	}
	if (argv.includes("--json")) return console.log(JSON.stringify(rows, null, 2));
	for (const r of rows) {
		const changed = r.changedSince === null ? "not in the snapshot" : r.changedSince ? "changed since" : "unchanged since";
		console.log(`${r.id.padEnd(12)} ${String(r.handled.routeType).padEnd(14)} ${r.handled.at}  verified: ${r.handled.verified ?? "not checked"}, ${changed}`);
	}
	console.log(`${rows.length} handled item${rows.length === 1 ? "" : "s"}`);
}
