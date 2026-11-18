// Writes one board document through the local board server, so the write queues behind maintainer clicks.
//   gary put items <id> <json file>           the file is the complete item and replaces the stored one
//   gary put --merge items <id> <json file>   merge the fields into the item, null removes a field
//   gary put items <id> --delete              remove the item
//   gary put meta <json file>                 replace meta.json
//   gary put proposals <id> <json file>       write one rule proposal
//   gary put learn <json file>                write the learn cursor <state>/learn.json
// A replace keeps the maintainer's `hidden` and `snoozedUntil`, and `priority` when the file has none.
// An item write is validated against the result. --no-validate skips that, for migrations.
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { applyWrite, boardDir, docPath, mergeFields, readJson, replaceFields, tokenFile } from "./lib/board-store.mjs";
import { loadConfig, loadProfile } from "./lib/config.mjs";
import { accountMode } from "./lib/gh.mjs";
import { validateProposal, writeLearn } from "./lib/learning.mjs";
import { VALIDATED_FIELDS, validateItem } from "./lib/validate-item.mjs";

function fail(message, problems) {
	console.log(JSON.stringify({ ok: false, error: message, ...(problems && { problems }) }));
	process.exit(1);
}

/** Validates the item as it will be after the write. A merge that touches none of the checked fields passes. */
async function check(dir, write) {
	if (!["merge", "replace"].includes(write.op) || !write.path.startsWith("items/")) return;
	if (write.op === "merge" && !VALIDATED_FIELDS.some((k) => Object.hasOwn(write.data, k))) return;
	const id = write.path.slice("items/".length);
	const cur = await readJson(docPath(dir, write.path));
	const merged = write.op === "merge" ? mergeFields(cur ?? {}, write.data) : replaceFields(cur, write.data);
	const { errors, warnings } = validateItem(id, merged, { mode: accountMode(), profile: loadProfile() });
	for (const w of warnings) console.error(`warning: ${id}: ${w.message}`);
	if (errors.length) fail(`${id} breaks ${errors.length} rule${errors.length === 1 ? "" : "s"}, nothing was written`, errors.map((e) => e.message));
}

function readDoc(file) {
	let data;
	try {
		data = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		fail(`Cannot read ${file}: ${e.message}`);
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) fail(`${file} must hold a JSON object`);
	return data;
}

function parse(argv, merge) {
	const [collection, ...rest] = argv;
	if (collection === "meta" && rest.length === 1) return { op: "set", path: "meta", data: readDoc(rest[0]) };
	if (collection === "learn" && rest.length === 1) return { op: "learn", data: readDoc(rest[0]) };
	if (collection === "proposals" && rest.length === 2) return { op: "set", path: `proposals/${rest[0]}`, data: readDoc(rest[1]) };
	if ((collection === "items" || collection === "actions") && rest.length === 2) {
		const [id, arg] = rest;
		if (arg === "--delete") return { op: "delete", path: `${collection}/${id}` };
		if (collection === "actions") return { op: "merge", path: `actions/${id}`, data: readDoc(arg) };
		return { op: merge ? "merge" : "replace", path: `items/${id}`, data: readDoc(arg) };
	}
	fail("Usage: gary put [--merge] [--no-validate] items <id> <json file> | items <id> --delete | meta <json file> | proposals <id> <json file> | learn <json file>");
}

export async function main(argv) {
	const noValidate = argv.includes("--no-validate");
	const write = parse(argv.filter((a) => a !== "--no-validate" && a !== "--merge"), argv.includes("--merge"));
	const dir = boardDir();
	if (write.op === "learn") {
		const problems = await writeLearn(write.data);
		if (problems.length) fail("learn.json is invalid, nothing was written", problems);
		console.log(JSON.stringify({ ok: true }));
		return;
	}
	if (!docPath(dir, write.path)) fail(`Invalid document path ${write.path}`);
	if (write.path.startsWith("proposals/")) {
		const problems = validateProposal(write.path.slice("proposals/".length), write.data);
		if (problems.length) fail("The proposal is invalid, nothing was written", problems);
	}
	if (!noValidate) await check(dir, write);

	const port = loadConfig().port;
	let token = "";
	try {
		token = readFileSync(tokenFile(dir), "utf8").trim();
	} catch {
		// Without a token file no server ever started, so the direct write below applies
	}

	let reply = null;
	if (token) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/db`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Board-Token": token },
				body: JSON.stringify(write),
				signal: AbortSignal.timeout(10000),
			});
			reply = [res.status, await res.json().catch(() => ({}))];
		} catch {
			reply = null;
		}
	}

	if (!reply) {
		console.error(`Board server on port ${port} is not reachable. Writing ${write.path} directly.`);
		if (write.path !== "meta") await mkdir(dirname(docPath(dir, write.path)), { recursive: true });
		reply = await applyWrite(dir, write);
	}

	const [status, body] = reply;
	if (status !== 200) fail(body?.error ?? `The board server answered ${status}`);
	console.log(JSON.stringify({ ok: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
