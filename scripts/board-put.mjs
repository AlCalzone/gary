// Writes one board document through the local board server, so the write queues behind maintainer clicks.
//   gary put items <id> <json file>   merge fields, null removes a field
//   gary put items <id> --delete      remove the item
//   gary put meta <json file>         replace meta.json
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { applyWrite, boardDir, docPath, tokenFile } from "./lib/board-store.mjs";
import { loadConfig } from "./lib/config.mjs";

function fail(message) {
	console.log(JSON.stringify({ ok: false, error: message }));
	process.exit(1);
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

function parse(argv) {
	const [collection, ...rest] = argv;
	if (collection === "meta" && rest.length === 1) return { op: "set", path: "meta", data: readDoc(rest[0]) };
	if ((collection === "items" || collection === "actions") && rest.length === 2) {
		const [id, arg] = rest;
		if (arg === "--delete") return { op: "delete", path: `${collection}/${id}` };
		return { op: "merge", path: `${collection}/${id}`, data: readDoc(arg) };
	}
	fail("Usage: gary put items <id> <json file> | items <id> --delete | meta <json file>");
}

export async function main(argv) {
	const write = parse(argv);
	const dir = boardDir();
	if (!docPath(dir, write.path)) fail(`Invalid document path ${write.path}`);

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
