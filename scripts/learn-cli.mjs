// gary decisions [--since <ISO>] [--json]: prints the decision log. --since is exclusive.
// gary proposals [--json]: lists every proposal with its status.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { boardDir, readJson } from "./lib/board-store.mjs";
import { readDecisions } from "./lib/learning.mjs";

function gist(e) {
	switch (e.type) {
		case "dismissed_route": return `${e.route?.type} "${e.route?.title}"${e.reason ? `: ${e.reason}` : ""}`;
		case "chose_alternative": return `${e.chosen?.type} instead of ${e.recommended?.type}`;
		case "edited_text": return `${e.route?.type}: edited the text`;
		case "thread_override": return `${e.decision} a thread judged ${e.thread?.verdict}${e.note ? `: ${e.note}` : ""}`;
		case "edited_comment": return `rewrote a comment on ${e.comment?.path}`;
		case "unchecked_comment": return `unchecked a comment on ${e.comment?.path}`;
		case "agent_note": return e.text;
		case "answered_finding": return `${e.finding?.severity ?? "finding"} "${e.finding?.text}": ${e.text}`;
		case "snoozed": return e.untilActivity ? "hidden until it changes" : `snoozed for ${e.days} days`;
		case "accepted_proposal": return `${e.proposal?.id}: ${e.proposal?.setting?.key} from ${e.from} to ${e.proposal?.setting?.value}`;
		case "dismissed_proposal": return `${e.proposal?.id}${e.reason ? `: ${e.reason}` : ""}`;
		default: return "";
	}
}

export async function decisionsMain(argv) {
	const i = argv.indexOf("--since");
	const since = i >= 0 ? argv[i + 1] : undefined;
	if (i >= 0 && !Number.isFinite(Date.parse(since ?? ""))) throw new Error("--since needs an ISO time");
	const entries = await readDecisions({ since });
	if (argv.includes("--json")) return console.log(JSON.stringify(entries, null, 2));
	for (const e of entries) console.log(`${e.at}  ${e.type.padEnd(18)} ${(e.itemId ?? "-").padEnd(11)} ${String(gist(e)).replace(/\s+/g, " ").slice(0, 120)}`);
	console.log(`${entries.length} entries`);
}

export async function proposalsMain(argv) {
	const dir = join(boardDir(), "proposals");
	let names = [];
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const list = (await Promise.all(names.map((n) => readJson(join(dir, n))))).filter(Boolean).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
	if (argv.includes("--json")) return console.log(JSON.stringify(list, null, 2));
	for (const p of list) {
		console.log(`${String(p.status).padEnd(9)} ${p.id}  ${p.title}  -> ${p.kind === "setting" ? `${p.setting?.key}=${p.setting?.value}` : `${p.target}:${p.file}`}${p.status === "dismissed" && p.reason ? `  (${p.reason})` : ""}`);
	}
	console.log(`${list.length} proposals`);
}
