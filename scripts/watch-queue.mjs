// Prints one JSON line per queued, unclaimed board action, so a watching session wakes when a request is clicked.
//   gary watch-queue                print the instance's queue, then follow it
//   gary watch-queue --all          the same for every instance, also ones added later
//   gary watch-queue [--all] --once print the current queue and exit
// Each line is { "instance", "id", "itemId", "action" }.
// A drive that waits for its review bot gets one more line with "event": "review-arrived" when the review is
// there, or "review-timeout" after 30 minutes. The watcher reads the PR once a minute per waiting drive.
// A watched PR, a PR by the bot or a taken-over PR, gets a line with "action": "drive", "event": "maintainer-feedback",
// "pr" and "at" when the maintainer reviewed or commented after our last push and no round handled it yet. The
// watcher reads at most 20 such PRs every 3 minutes, the first time right at its start.
// A PR with an automatic review gets lines with "action": "auto_review": "event": "offer-accepted" when its author
// reacted positively to the format offer, "offer-reply" with "at" when he commented after it, and "re-requested"
// with "at" when he re-requested the review. The watcher reads at most 20 such PRs every 3 minutes.
import { mkdirSync, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readAutoReviews, watchEvents, watchedRecords } from "./lib/auto-review.mjs";
import { ID_PATTERN, boardDir, readJson } from "./lib/board-store.mjs";
import { autoReviewOf, instanceName, instanceNames, instancesDir, loadInstance, withInstance } from "./lib/config.mjs";
import { isInstancePaused } from "./lib/control.mjs";
import { readDrives } from "./lib/fixes.mjs";
import { sensitiveOurs, touchesSensitive } from "./lib/facts.mjs";
import { dropWatch, pushWork, stageOf, unhandledFeedback, watchedPrs } from "./lib/watch.mjs";
import { fetchItem, fetchOfferFacts } from "./snapshot.mjs";

const RESCAN_MS = 5000;
const DEBOUNCE_MS = 100;
// GARY_DRIVE_POLL_MS shortens the poll in tests
const DRIVE_POLL_MS = Number(process.env.GARY_DRIVE_POLL_MS) || 60000;
export const DRIVE_WAIT_MS = 30 * 60000;
// GARY_OFFER_POLL_MS shortens the poll of the automatic reviews in tests
const OFFER_POLL_MS = Number(process.env.GARY_OFFER_POLL_MS) || 180000;
// GARY_WATCH_POLL_MS shortens the poll of the watched PRs in tests
const WATCH_POLL_MS = Number(process.env.GARY_WATCH_POLL_MS) || 180000;
const MAX_WATCHED = 20;

/**
 * What a waiting drive waits for: "review-arrived" when its review bot reviewed or commented after the request,
 * "review-timeout" when the wait is over, null while it still waits. `entry` is the PR's fresh snapshot entry.
 */
export function driveEvent(drive, entry, now = Date.now()) {
	const since = Date.parse(drive.reviewRequestedAt ?? "");
	if (!Number.isFinite(since)) return null;
	const bot = String(drive.reviewBot ?? "").toLowerCase();
	const arrived = (entry?.facts?.timeline ?? []).some((e) => (e.kind === "review" || e.kind === "thread_comment") && bot && String(e.author).toLowerCase().startsWith(bot) && Date.parse(e.at) > since);
	if (arrived) return "review-arrived";
	return now - since > DRIVE_WAIT_MS ? "review-timeout" : null;
}

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

	// One event per review request of a drive
	const driveEvents = new Set();
	async function scanDrives() {
		for (const instance of instances()) {
			if (isInstancePaused(instance)) continue;
			let drives = {};
			try {
				drives = await readDrives(instance);
			} catch (e) {
				console.error(`Reading the drives of ${instance} failed: ${e.message}`);
			}
			for (const [itemId, drive] of Object.entries(drives)) {
				if (stageOf(drive) !== "review") continue;
				const key = `${instance}/${itemId}/${drive.reviewRequestedAt}`;
				if (typeof drive.reviewRequestedAt !== "string" || typeof drive.actionId !== "string" || driveEvents.has(key)) continue;
				let event = driveEvent(drive, null);
				if (!event) {
					try {
						event = driveEvent(drive, await withInstance(instance, () => fetchItem("pr", drive.number, drive.repo)));
					} catch (e) {
						// The next poll reads it again
						console.error(`Reading PR #${drive.number} of ${instance} failed: ${e.message}`);
					}
				}
				if (!event) continue;
				driveEvents.add(key);
				process.stdout.write(JSON.stringify({ instance, id: drive.actionId, itemId, action: "drive", event }) + "\n");
			}
		}
	}
	let drivesRunning = Promise.resolve();
	const queueDrives = () => (drivesRunning = drivesRunning.then(scanDrives));

	// One line per piece of the maintainer's feedback on a watched PR. A merged or closed PR is not read again
	const feedbackEvents = new Set();
	const gone = new Set();
	async function scanWatches() {
		for (const instance of instances()) {
			if (isInstancePaused(instance)) continue;
			let candidates = [];
			let me;
			try {
				const i = loadInstance(instance);
				me = i.config.me;
				// Without an account that may push no round can run
				if (!i.config.bot && !i.config.allowOwnTokenPushes) continue;
				const busy = await pushWork(instance);
				candidates = (await withInstance(instance, () => watchedPrs(instance, i.repos[0], i.config.bot?.login ?? null)))
					.filter((p) => stageOf(p.drive) === "watch" && !busy.has(p.itemId) && !gone.has(`${instance}/${p.itemId}`))
					.slice(0, MAX_WATCHED);
			} catch (e) {
				console.error(`Reading the watched PRs of ${instance} failed: ${e.message}`);
			}
			for (const p of candidates) {
				let entry;
				try {
					entry = await withInstance(instance, () => fetchItem("pr", p.number, p.repo));
				} catch (e) {
					// The next poll reads it again
					console.error(`Reading PR #${p.number} of ${instance} failed: ${e.message}`);
					continue;
				}
				if (entry.githubState !== "open") {
					gone.add(`${instance}/${p.itemId}`);
					await dropWatch(p.itemId, instance).catch((e) => console.error(`Removing the watch of PR #${p.number} of ${instance} failed: ${e.message}`));
					continue;
				}
				if (touchesSensitive(entry) && !sensitiveOurs(entry)) continue;
				const at = unhandledFeedback("me", { drive: p.drive, feedback: entry.facts, item: p.item, record: p.record });
				if (!at || !me) continue;
				const key = `${instance}/${p.itemId}/${at}`;
				if (feedbackEvents.has(key)) continue;
				feedbackEvents.add(key);
				process.stdout.write(JSON.stringify({ instance, id: `watch-${p.itemId}`, itemId: p.itemId, action: "drive", event: "maintainer-feedback", pr: p.number, at }) + "\n");
			}
		}
	}
	let watchesRunning = Promise.resolve();
	const queueWatches = () => (watchesRunning = watchesRunning.then(scanWatches));

	// One line per answer to an automatic review
	const reviewEvents = new Set();
	async function scanAutoReviews() {
		for (const instance of instances()) {
			if (isInstancePaused(instance)) continue;
			let watched = [];
			try {
				const i = loadInstance(instance);
				if (!autoReviewOf(i.config, i.profile).enabled) continue;
				watched = watchedRecords(await readAutoReviews(instance));
			} catch (e) {
				console.error(`Reading the automatic reviews of ${instance} failed: ${e.message}`);
			}
			for (const { itemId, record } of watched) {
				let events = [];
				try {
					const url = record.offer?.url ?? record.reviews.at(-1).url;
					events = watchEvents(record, await withInstance(instance, () => fetchOfferFacts(record.number, url, record.repo)));
				} catch (e) {
					// The next poll reads it again
					console.error(`Reading PR #${record.number} of ${instance} failed: ${e.message}`);
				}
				for (const ev of events) {
					const key = `${instance}/${itemId}/${ev.event}/${ev.at ?? ""}`;
					if (reviewEvents.has(key)) continue;
					reviewEvents.add(key);
					process.stdout.write(JSON.stringify({ instance, id: `auto-review-${itemId}`, itemId, action: "auto_review", pr: record.number, ...ev }) + "\n");
				}
			}
		}
	}
	let reviewsRunning = Promise.resolve();
	const queueAutoReviews = () => (reviewsRunning = reviewsRunning.then(scanAutoReviews));

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
	await queueDrives();
	await queueAutoReviews();
	await queueWatches();
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
	setInterval(queueDrives, DRIVE_POLL_MS);
	setInterval(queueAutoReviews, OFFER_POLL_MS);
	setInterval(queueWatches, WATCH_POLL_MS);
	process.on("SIGTERM", () => process.exit(0));
	process.on("SIGINT", () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
