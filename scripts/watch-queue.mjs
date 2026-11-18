// Prints one JSON line per queued, unclaimed board action, so a watching session wakes when a request is clicked.
//   gary watch-queue          print the current queue, then follow it
//   gary watch-queue --once   print the current queue and exit
import { mkdirSync, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ID_PATTERN, boardDir, readJson } from "./lib/board-store.mjs";

const RESCAN_MS = 5000;
const DEBOUNCE_MS = 100;

function isOpen(doc) {
	return doc.status === "queued" && !(typeof doc.result === "string" && doc.result.startsWith("claimed by"));
}

export async function main(argv) {
	const once = argv.includes("--once");
	const dir = join(boardDir(), "actions");
	mkdirSync(dir, { recursive: true });

	const printed = new Set();
	const skipped = new Set();

	async function scan() {
		let names;
		try {
			names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
		} catch (e) {
			console.error(`Reading ${dir} failed: ${e.message}`);
			return;
		}
		const found = [];
		for (const name of names) {
			const id = name.slice(0, -5);
			if (printed.has(id) || !ID_PATTERN.test(id)) continue;
			const doc = await readJson(join(dir, name));
			if (!doc) {
				if (!skipped.has(id)) console.error(`Skipping ${name}: not a JSON object`);
				skipped.add(id);
				continue;
			}
			skipped.delete(id);
			if (isOpen(doc)) found.push({ id, doc });
		}
		found.sort((a, b) => String(a.doc.createdAt ?? "").localeCompare(String(b.doc.createdAt ?? "")) || a.id.localeCompare(b.id));
		for (const { id, doc } of found) {
			printed.add(id);
			process.stdout.write(JSON.stringify({ id, itemId: doc.itemId, action: doc.action }) + "\n");
		}
	}

	// Serialize scans so a burst of events never prints a doc twice
	let running = Promise.resolve();
	const queueScan = () => (running = running.then(scan));

	await queueScan();
	if (once) process.exit(0);

	let timer = null;
	const watcher = watch(dir, () => {
		clearTimeout(timer);
		timer = setTimeout(queueScan, DEBOUNCE_MS);
	});
	watcher.on("error", (e) => console.error(`Watching ${dir} failed: ${e.message}`));
	// fs.watch can miss a rename, so rescan on a timer too
	setInterval(queueScan, RESCAN_MS);
	process.on("SIGTERM", () => process.exit(0));
	process.on("SIGINT", () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
