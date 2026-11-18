// Prints one JSON line per queued, unclaimed board action, so a watching session wakes when a request is clicked.
//   gary watch-queue                print the instance's queue, then follow it
//   gary watch-queue --all          the same for every instance, also ones added later
//   gary watch-queue [--all] --once print the current queue and exit
// Each line is { "instance", "id", "itemId", "action" }.
import { mkdirSync, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ID_PATTERN, boardDir, readJson } from "./lib/board-store.mjs";
import { instanceName, instanceNames, instancesDir } from "./lib/config.mjs";
import { isInstancePaused } from "./lib/control.mjs";

const RESCAN_MS = 5000;
const DEBOUNCE_MS = 100;

function isOpen(doc) {
	return doc.status === "queued" && !(typeof doc.result === "string" && doc.result.startsWith("claimed by"));
}

export async function main(argv) {
	const once = argv.includes("--once");
	const all = argv.includes("--all");
	const fixed = all ? null : instanceName();
	const instances = () => (all ? instanceNames() : [fixed]);
	if (fixed) mkdirSync(join(boardDir(fixed), "actions"), { recursive: true });

	const printed = new Set();
	const skipped = new Set();

	async function scanOne(instance) {
		// While an instance is paused nothing of it is printed, so the master starts nothing. Its docs wait in the queue
		if (isInstancePaused(instance)) return [];
		const dir = join(boardDir(instance), "actions");
		let names;
		try {
			names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
		} catch (e) {
			if (e.code !== "ENOENT") console.error(`Reading ${dir} failed: ${e.message}`);
			return [];
		}
		const found = [];
		for (const name of names) {
			const id = name.slice(0, -5);
			const key = `${instance}/${id}`;
			if (printed.has(key) || !ID_PATTERN.test(id)) continue;
			const doc = await readJson(join(dir, name));
			if (!doc) {
				if (!skipped.has(key)) console.error(`Skipping ${instance}/${name}: not a JSON object`);
				skipped.add(key);
				continue;
			}
			skipped.delete(key);
			if (isOpen(doc)) found.push({ instance, id, key, doc });
		}
		return found;
	}

	async function scan() {
		const found = (await Promise.all(instances().map(scanOne))).flat();
		found.sort((a, b) => String(a.doc.createdAt ?? "").localeCompare(String(b.doc.createdAt ?? "")) || a.key.localeCompare(b.key));
		for (const { instance, id, key, doc } of found) {
			printed.add(key);
			process.stdout.write(JSON.stringify({ instance, id, itemId: doc.itemId, action: doc.action }) + "\n");
		}
	}

	// Serialize scans so a burst of events never prints a doc twice
	let running = Promise.resolve();
	const queueScan = () => (running = running.then(scan));

	await queueScan();
	if (once) process.exit(0);

	let timer = null;
	const watchDir = all ? instancesDir() : join(boardDir(fixed), "actions");
	try {
		const watcher = watch(watchDir, { recursive: all }, () => {
			clearTimeout(timer);
			timer = setTimeout(queueScan, DEBOUNCE_MS);
		});
		watcher.on("error", (e) => console.error(`Watching ${watchDir} failed: ${e.message}`));
	} catch (e) {
		console.error(`Watching ${watchDir} failed: ${e.message}`);
	}
	// fs.watch can miss a rename, and --all picks up new instances, so rescan on a timer too
	setInterval(queueScan, RESCAN_MS);
	process.on("SIGTERM", () => process.exit(0));
	process.on("SIGINT", () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
