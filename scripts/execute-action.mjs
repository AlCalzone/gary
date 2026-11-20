// Usage: gary action [--dry-run] [--check-fresh] [--autonomous] [action.json]
// Reads the action from stdin when no file is given.
// --check-fresh refuses when the thread moved since the item's review, like a click on the board does.
// --autonomous marks an action nobody clicked: only label (within autoLabels) and assign may run, and never on an
// item in focus. Exit 3 then.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runAction } from "./lib/actions.mjs";
import { ID_PATTERN, boardDir, readJson } from "./lib/board-store.mjs";
import { focusHold, focusRefusal } from "./lib/focus.mjs";
import { checkFresh } from "./lib/guard.mjs";

const ID_PREFIX = { pr: "pr-", issue: "issue-", discussion: "disc-" };

const FLAGS = ["--dry-run", "--check-fresh", "--autonomous"];

export async function main(args) {
	const dryRun = args.includes("--dry-run");
	const checkFreshness = args.includes("--check-fresh");
	const autonomous = args.includes("--autonomous");
	const files = args.filter((a) => !FLAGS.includes(a));

	let outcome;
	try {
		if (files.length > 1 || files.some((f) => f.startsWith("--"))) {
			throw new Error("Usage: gary action [--dry-run] [--check-fresh] [--autonomous] [action.json]");
		}
		const input = readFileSync(files[0] ?? 0, "utf8");
		let request;
		try {
			request = JSON.parse(input);
		} catch (e) {
			throw new Error(`Invalid JSON: ${e.message}`);
		}
		if (!request || typeof request !== "object" || Array.isArray(request)) {
			throw new Error("The action must be a JSON object");
		}
		let { action, kind, number, repo, params, text, itemId } = request;
		// A board item supplies kind, number and repo. Ids are opaque, so they come from the stored doc
		let item = null;
		if (itemId !== undefined) {
			if (typeof itemId !== "string" || !ID_PATTERN.test(itemId)) throw new Error(`Invalid itemId "${itemId}"`);
			item = await readJson(join(boardDir(), "items", itemId + ".json"));
			if (!item && (kind === undefined || number === undefined)) throw new Error(`Item ${itemId} is not on the board`);
		}
		if (item) {
			kind ??= item.kind;
			number ??= item.number;
			repo ??= item.repo;
		}
		const heldId = itemId ?? (ID_PREFIX[kind] && Number.isSafeInteger(number) ? ID_PREFIX[kind] + number : null);
		const focus = autonomous && heldId ? focusHold(heldId) : null;
		if (focus) {
			outcome = { ok: false, refused: true, result: focusRefusal(heldId, focus) };
			process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
			process.exitCode = 3;
			return;
		}
		if (checkFreshness) {
			if (!item) throw new Error("--check-fresh needs the itemId of a board item");
			const fresh = await checkFresh({ action, kind, number, item, params, force: request.force === true });
			if (!fresh.ok) throw new Error(fresh.reason);
		}
		outcome = await runAction({ action, kind, number, repo, params, text, dryRun, autonomous });
	} catch (e) {
		outcome = { ok: false, result: e.message };
	}

	process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
	process.exitCode = outcome.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
