// gary wants [--json]: lists, per board item, the labels and assignees its `wants` asks for that GitHub does not
// show yet. GitHub's state comes from the staged snapshot, or the baseline when nothing is staged. Read-only.
// Without a bot and without allowOwnTokenPushes no account may write, so the list is empty and `skipped` says why.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { boardDir, readJson } from "./lib/board-store.mjs";
import { stateDir } from "./lib/config.mjs";
import { accountMode } from "./lib/gh.mjs";

export const NO_WRITER = "No account may write: there is no bot and allowOwnTokenPushes is false. No label or assignee change is attempted.";

const lower = (list) => new Set((list ?? []).map((x) => x.toLowerCase()));

/** What one item still wants, compared to its snapshot entry, or null when nothing is left. */
export function pendingWants(item, entry) {
	const w = item.wants ?? {};
	const labels = lower(entry.labels);
	const assignees = lower(entry.assignees);
	const add = (w.labels?.add ?? []).filter((l) => !labels.has(l.toLowerCase()));
	const remove = (w.labels?.remove ?? []).filter((l) => labels.has(l.toLowerCase()));
	const assign = (w.assignees ?? []).filter((a) => !assignees.has(a.toLowerCase()));
	if (!add.length && !remove.length && !assign.length) return null;
	return { labels: { add, remove }, assignees: { add: assign } };
}

async function readSnapshot() {
	for (const [file, source] of [["snapshot.pending.json", "staged"], ["snapshot.json", "baseline"]]) {
		const data = await readJson(join(stateDir(), file));
		if (data?.items) return { source, fetchedAt: data.fetchedAt ?? null, items: data.items };
	}
	return { source: null, fetchedAt: null, items: {} };
}

export async function main(argv) {
	if (accountMode() === "none") {
		if (argv.includes("--json")) return console.log(JSON.stringify({ snapshot: null, fetchedAt: null, items: [], unknown: [], skipped: NO_WRITER }, null, 2));
		return console.log(NO_WRITER);
	}
	const dir = join(boardDir(), "items");
	let names = [];
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const snapshot = await readSnapshot();
	const items = [];
	// Items whose snapshot entry is gone, or predates the labels and assignees in it
	const unknown = [];
	for (const name of names.sort()) {
		const id = name.slice(0, -".json".length);
		const item = await readJson(join(dir, name));
		if (!item?.wants) continue;
		const entry = snapshot.items[id];
		if (!entry || !Array.isArray(entry.labels)) {
			unknown.push(id);
			continue;
		}
		const pending = pendingWants(item, entry);
		if (pending) items.push({ id, repo: item.repo, kind: item.kind, number: item.number, ...pending, reason: item.wantsReason ?? null });
	}
	const out = { snapshot: snapshot.source, fetchedAt: snapshot.fetchedAt, items, unknown };
	if (argv.includes("--json")) return console.log(JSON.stringify(out, null, 2));
	if (!snapshot.source) console.log("No snapshot yet. Run `gary snapshot` first.");
	for (const i of items) {
		const parts = [
			...i.labels.add.map((l) => `+${l}`),
			...i.labels.remove.map((l) => `-${l}`),
			...i.assignees.add.map((a) => `@${a}`),
		];
		console.log(`${i.id.padEnd(12)} ${parts.join(" ").padEnd(30)} ${i.reason ?? ""}`);
	}
	if (unknown.length) console.log(`not in the snapshot: ${unknown.join(", ")}`);
	console.log(`${items.length} item${items.length === 1 ? "" : "s"} want changes, compared to the ${snapshot.source ?? "missing"} snapshot`);
}
