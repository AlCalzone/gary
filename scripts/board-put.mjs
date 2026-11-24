// Writes one board document through the local board server, so the write queues behind maintainer clicks.
//   gary put items <id> <json file>           the file is the complete item and replaces the stored one
//   gary put --merge items <id> <json file>   merge the fields into the item, null removes a field
//   gary put items <id> --delete              remove the item
//   gary put meta <json file>                 replace meta.json
//   gary put proposals <id> <json file>       write one proposal. --check validates it and writes nothing
//   gary put learn <json file>                write the learn cursor <state>/learn.json
// A replace keeps the maintainer's `hidden` and `snoozedUntil`, and `priority` when the file has none.
// An item write is validated against the result. --no-validate skips that, for migrations.
// While a focus holds an item, only a merge of the facts from GitHub and the maintainer's fields goes through. Exit 3 otherwise.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ID_PATTERN, applyWrite, docPath, mergeFields, readJson, replaceFields, tokenFile } from "./lib/board-store.mjs";
import { instanceName, loadInstance, loadProfile, rootConfig } from "./lib/config.mjs";
import { sensitiveOurs, touchesSensitive } from "./lib/facts.mjs";
import { accountMode } from "./lib/gh.mjs";
import { isEditProposal, occurrences, proposalTarget, validateProposal, writeLearn } from "./lib/learning.mjs";
import { VALIDATED_FIELDS, validateItem } from "./lib/validate-item.mjs";
import { fixForOf, fixPrNumbers, fixStateOf, loadFixSources } from "./lib/fixes.mjs";
import { focusHold, focusRefusal } from "./lib/focus.mjs";

// `FOCUS_FACT_FIELDS` names what a write may change on an item in focus: the facts from GitHub, the rank and the maintainer's fields
export const FOCUS_FACT_FIELDS = [
	"repo", "kind", "number", "title", "url", "author", "authorType", "labels", "isDraft", "ci", "updatedAt", "mergeable", "reviewDecision", "isAnswered",
	"discussionCategory", "openThreads", "reviews", "lastEventUrl", "waitingOn", "dueAt", "dueSource", "series", "priority", "hidden", "snoozedUntil", "handled",
];

/** Why the write may not touch an item in focus, or null. */
export function focusWriteRefusal(instance, write) {
	if (!write.path?.startsWith("items/")) return null;
	const id = write.path.slice("items/".length);
	const focus = focusHold(id, instance);
	if (!focus) return null;
	const extra = write.op === "merge" ? Object.keys(write.data ?? {}).filter((k) => !FOCUS_FACT_FIELDS.includes(k)) : null;
	if (extra && !extra.length) return null;
	return `${focusRefusal(id, focus)} Only a merge of the facts from GitHub goes through${extra ? `, and ${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} none` : ""}.`;
}

function fail(message, problems) {
	console.log(JSON.stringify({ ok: false, error: message, ...(problems && { problems }) }));
	process.exit(1);
}

/** Validates the item as it will be after the write. A merge that touches none of the checked fields passes. */
async function check(instance, write) {
	if (!["merge", "replace"].includes(write.op) || !write.path.startsWith("items/")) return;
	if (write.op === "merge" && !VALIDATED_FIELDS.some((k) => Object.hasOwn(write.data, k))) return;
	const id = write.path.slice("items/".length);
	const cur = await readJson(docPath(instance, write.path));
	const sources = await loadFixSources(instance);
	// fixFor is code-owned: it comes from Gary's record of its fix PRs, whatever the doc says
	if (write.op === "replace" && write.data.kind === "pr") {
		const forItem = fixPrNumbers(sources.records).get(write.data.number);
		if (forItem) write.data.fixFor = fixForOf(forItem, write.data.repo);
		else delete write.data.fixFor;
	}
	const merged = write.op === "merge" ? mergeFields(cur ?? {}, write.data) : replaceFields(cur, write.data);
	const fix = merged.kind === "issue" || merged.kind === "discussion" ? fixStateOf(id, sources) : null;
	const { errors, warnings } = validateItem(id, merged, { mode: accountMode(), profile: loadProfile(), repos: loadInstance(instance).repos, kind: loadInstance(instance).kind, fix, sensitive: touchesSensitive(sources.snapshot[id]), sensitiveOurs: sensitiveOurs(sources.snapshot[id]) });
	for (const w of warnings) console.error(`warning: ${id}: ${w.message}`);
	if (errors.length) fail(`${id} breaks ${errors.length} rule${errors.length === 1 ? "" : "s"}, nothing was written`, errors.map((e) => e.message));
}

/** The problems in a meta.json document. Only the fields the learning loop reads are checked. */
export function validateMeta(meta) {
	const problems = [];
	if (meta.rulesHash !== undefined && !(typeof meta.rulesHash === "string" && meta.rulesHash.length > 0 && meta.rulesHash.length <= 200)) {
		problems.push("rulesHash must be a non-empty string");
	}
	if (meta.rulesPending !== undefined && !(Array.isArray(meta.rulesPending) && meta.rulesPending.every((id) => typeof id === "string" && ID_PATTERN.test(id)))) {
		problems.push(`rulesPending must be a list of item ids matching ${ID_PATTERN}`);
	}
	return problems;
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
	fail("Usage: gary put [--merge] [--no-validate] [--check] items <id> <json file> | items <id> --delete | meta <json file> | proposals <id> <json file> | learn <json file>");
}

// An edit proposal must match its file now, so a pass learns of a wrong `before` at once
async function editTargetProblems(p, instance) {
	let file;
	try {
		({ file } = await proposalTarget(p, instance));
	} catch (e) {
		return [e.message];
	}
	let content;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return [`${p.file} does not exist`];
	}
	const n = occurrences(content, p.before);
	if (n !== 1) return [`before occurs ${n === 0 ? "nowhere" : "more than once"} in ${p.file}. It must be one block that occurs exactly once`];
	// The board shows before and after as a diff, so a block cut inside a line shows half a sentence
	const start = content.indexOf(p.before);
	const end = start + p.before.length;
	const whole = (start === 0 || content[start - 1] === "\n") && (p.before.endsWith("\n") || end === content.length || content[end] === "\n");
	return whole ? [] : [`before starts or ends inside a line of ${p.file}. Copy whole lines, from the start of the first to the end of the last, and write after as the whole new lines`];
}

/** Sends one board write through the board server, or applies it directly when no server answers. Returns `[status, body]`. */
export async function sendWrite(instance, write) {
	const { port } = rootConfig();
	let token = "";
	try {
		token = readFileSync(tokenFile(), "utf8").trim();
	} catch {
		// Without a token file no server ever started, so the direct write below applies
	}

	let reply = null;
	if (token) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/db`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Board-Token": token },
				body: JSON.stringify({ instance, ...write }),
				signal: AbortSignal.timeout(10000),
			});
			reply = [res.status, await res.json().catch(() => ({}))];
		} catch {
			reply = null;
		}
	}

	if (!reply) {
		console.error(`Board server on port ${port} is not reachable. Writing ${write.path} directly.`);
		reply = await applyWrite(instance, write);
	}

	return reply;
}

export async function main(argv) {
	const noValidate = argv.includes("--no-validate");
	const checkOnly = argv.includes("--check");
	const write = parse(argv.filter((a) => a !== "--no-validate" && a !== "--merge" && a !== "--check"), argv.includes("--merge"));
	const instance = instanceName();
	if (write.op === "learn") {
		const problems = await writeLearn(write.data);
		if (problems.length) fail("learn.json is invalid, nothing was written", problems);
		console.log(JSON.stringify({ ok: true }));
		return;
	}
	if (!docPath(instance, write.path)) fail(`Invalid document path ${write.path}`);
	if (write.path.startsWith("proposals/")) {
		const problems = validateProposal(write.path.slice("proposals/".length), write.data);
		if (!problems.length && isEditProposal(write.data)) problems.push(...(await editTargetProblems(write.data, instance)));
		if (problems.length) fail("The proposal is invalid, nothing was written", problems);
		if (checkOnly) return console.log(JSON.stringify({ ok: true, checked: true }));
	}
	if (write.path === "meta") {
		const problems = validateMeta(write.data);
		if (problems.length) fail("meta.json is invalid, nothing was written", problems);
	}
	const held = focusWriteRefusal(instance, write);
	if (held) {
		console.log(JSON.stringify({ ok: false, refused: true, error: held }));
		process.exit(3);
	}
	if (!noValidate) await check(instance, write);

	const [status, body] = await sendWrite(instance, write);
	if (status !== 200) fail(body?.error ?? `The board server answered ${status}`);
	console.log(JSON.stringify({ ok: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
