// gary focus: the maintainer handles one item 1 on 1 in an agent session, and Gary holds everything on it meanwhile.
// The master finds or starts the session with its harness's own tools and passes what it found. Nothing here knows a harness.
//   gary focus brief <itemId> --harness <h> [--master <id>] [--session <id>] [--worktree <dir>] [--json]
//     The first prompt for a new session, or with --session the note for a session the focus attaches to.
//     In a contributions instance, --worktree names the worktree from gary own-pr workdir or gary focus workdir.
//   gary focus workdir <itemId> --request <action id>
//     For a thread of a contributions instance that is not the maintainer's own pushable PR: adds a new detached
//     worktree for reading under the state directory. Exit 3 when refused.
//   gary focus start <itemId> --harness <h> --session <id> [--link <url>] [--title <text>] [--request <action id>]
//                    [--attach --match pr|branch|focus|origin|worktree] [--transcript <file>]
//     Records the focus and settles the focus request. Exit 3 while another session holds the item.
//   gary focus fail <itemId> --request <action id> --reason <text>
//     Marks the focus request failed, so the board says why no session started.
//   gary focus done (<itemId> --session <id> --summary-file <file> | --message-file <file>)
//     The session reported done. Ends the focus and queues a fresh analysis with the summary as its note.
//   gary focus end <itemId>
//     Ends the focus without a summary, like the board's "End focus".
//   gary focus check <itemId> [--activity <ISO>] [--archived]
//     Records the session's last activity. 30 quiet minutes pause the focus, an archived session ends it.
//   gary focus list [--json]
//     The focus records of the instance.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { boardDir, readJson } from "./lib/board-store.mjs";
import { listClaims } from "./lib/claims.mjs";
import { allowedRepo, instanceName, loadInstance, modelsOf, paths, stateDir } from "./lib/config.mjs";
import { OWN_ID, focusAttachNote, focusBriefing, parseDoneMessage } from "./lib/focus-brief.mjs";
import { FOCUS_MATCHES, MAX_SUMMARY, checkFocus, endFocus, failFocus, readFocus, readFocuses, startFocus } from "./lib/focus.mjs";
import { readSnapshotItems } from "./lib/fixes.mjs";
import { locate, ownPrRefusal, prepareReadWorktree } from "./lib/own-pr.mjs";
import { readOrigins } from "./lib/origins.mjs";
import { sinceAnchor, sinceSummary } from "./lib/since.mjs";

const USAGE = "Usage: gary focus brief <itemId> --harness <h> [--master <id>] [--session <id>] [--worktree <dir>] | start <itemId> --harness <h> --session <id> [--link <url>] [--title <text>] [--request <id>] [--attach --match pr|branch|focus|origin|worktree] [--transcript <file>] | fail <itemId> --request <id> --reason <text> | done (<itemId> --session <id> --summary-file <file> | --message-file <file>) | end <itemId> | check <itemId> [--activity <ISO>] [--archived] | list [--json]";
const VALUES = ["--harness", "--master", "--session", "--link", "--title", "--request", "--match", "--transcript", "--reason", "--summary-file", "--message-file", "--activity", "--worktree"];
const FLAGS = ["--attach", "--archived", "--json"];

class Refused extends Error {}

function parse(argv) {
	const out = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (VALUES.includes(argv[i])) {
			if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
			out[argv[i].slice(2)] = argv[++i];
		} else if (FLAGS.includes(argv[i])) out[argv[i].slice(2)] = true;
		else if (argv[i].startsWith("--")) throw new Error(USAGE);
		else rest.push(argv[i]);
	}
	return { out, rest };
}

function readText(file, what) {
	try {
		return readFileSync(file === "-" ? 0 : file, "utf8");
	} catch (e) {
		throw new Error(`Cannot read the ${what} ${file}: ${e.message}`);
	}
}

function defaultBranch(checkout) {
	if (!checkout) return null;
	try {
		return execFileSync("git", ["-C", checkout, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
	} catch {
		return null;
	}
}

async function itemActions(itemId) {
	const dir = join(boardDir(), "actions");
	let names = [];
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch {}
	const docs = await Promise.all(names.map((n) => readJson(join(dir, n))));
	return docs.filter((a) => a?.itemId === itemId);
}

async function brief(itemId, out) {
	if (!out.harness) throw new Error("--harness must name the harness, like t3code");
	const instance = loadInstance(instanceName());
	const item = await readJson(join(boardDir(), "items", itemId + ".json"));
	if (!item) throw new Error(`${itemId} has no item on the board`);
	const entry = (await readSnapshotItems())[itemId] ?? null;
	const place = instance.kind === "contributions" ? await contributionsPlace(instance, item, entry) : null;
	const own = place?.mode === "own_pr" ? place : null;
	const actions = await itemActions(itemId);
	const since = sinceSummary(entry?.activity, sinceAnchor(item, actions, { activity: entry?.activity, me: instance.config.me }), { me: instance.config.me, bot: instance.config.bot?.login, actions });
	const p = paths();
	const focusSession = out.session ?? OWN_ID;
	// A job that started before the focus finishes. The session waits for it before it pushes
	const working = [...new Set((await listClaims()).filter((c) => c.itemId === itemId && !c.expired).map((c) => c.kind))];
	const ctx = { instance: instance.name, item: { ...item, id: itemId }, since, harness: out.harness, master: out.master ?? null, bot: instance.config.bot?.login ?? null, paths: p, focusSession, working, contributions: !!own, discuss: place?.mode === "discuss" };
	const checkout = place ? place.clone : p.checkout;
	const branch = defaultBranch(checkout);
	const text = out.session ? focusAttachNote(ctx) : focusBriefing({ ...ctx, defaultBranch: branch, worktree: out.worktree ?? null, headRef: own?.headRef ?? null });
	const origin = (await readOrigins())[itemId];
	return {
		ok: true,
		itemId,
		kind: item.kind,
		number: item.number,
		repo: item.repo,
		url: item.url ?? null,
		title: item.title ?? null,
		headRef: own?.headRef ?? entry?.headRef ?? null,
		checkout,
		// On the maintainer's own PR the clone may be the maintainer's own, so the session works in a worktree of Gary's
		...(own && { headRepo: own.headRepo, fresh: own.fresh, branchWorktree: own.branchWorktree, worktree: out.worktree ?? null }),
		// A thread of someone else is only read and discussed, in a worktree of Gary's
		...(place?.mode === "discuss" && { fresh: place.fresh, worktree: out.worktree ?? null }),
		...(place && { mode: place.mode }),
		defaultBranch: branch,
		model: modelsOf(instance.config).models.review,
		previous: await readFocus(itemId),
		working,
		origin: origin?.found ? { sessionId: origin.sessionId, cwd: origin.cwd, transcript: origin.transcript, lastActiveAt: origin.lastActiveAt } : null,
		...(out.session ? { note: text } : { briefing: text }),
	};
}

/**
 * Where a focus in a contributions instance works. `mode` is `own_pr` for the maintainer's own PR that Gary may push
 * to, with the clone, whether Gary clones it fresh and the worktree that has the PR's branch checked out. Every other
 * thread gets `discuss`: the session reads and discusses, and pushes nothing.
 */
async function contributionsPlace(instance, item, entry) {
	if (!allowedRepo(instance.name, item.repo)) throw new Refused(`${item.repo ?? "The item"} is no thread of this instance.`);
	const roots = instance.config.checkoutRoots ?? [];
	if (ownPrRefusal(item, entry, instance.config.me)) {
		const { clone } = await locate({ stateDir: stateDir(), roots, baseRepo: item.repo, headRepo: null, headRef: null });
		return { mode: "discuss", clone: clone.path, fresh: clone.fresh };
	}
	const { headRepo, headRef } = entry.ownPr;
	const { clone, branchWorktree } = await locate({ stateDir: stateDir(), roots, baseRepo: item.repo, headRepo, headRef });
	return { mode: "own_pr", clone: clone.path, fresh: clone.fresh, branchWorktree, headRepo, headRef };
}

async function workdir(itemId, out) {
	const instance = loadInstance(instanceName());
	if (instance.kind !== "contributions") throw new Refused(`gary focus workdir is for a contributions instance. A focus session of ${instance.name} gets its worktree from the harness.`);
	const item = await readJson(join(boardDir(), "items", itemId + ".json"));
	if (!item) throw new Refused(`${itemId} has no item on the board.`);
	const place = await contributionsPlace(instance, item, (await readSnapshotItems())[itemId] ?? null);
	if (place.mode !== "discuss") throw new Refused(`${itemId} is your own PR. Its worktree comes from gary own-pr workdir.`);
	if (!out.request || !/^[\w.-]+$/.test(out.request)) throw new Error("Name the click with --request <action id>.");
	const doc = await readJson(join(boardDir(), "actions", out.request + ".json"));
	if (!doc || doc.itemId !== itemId || doc.action !== "focus" || doc.status !== "queued") throw new Refused(`${out.request} is no queued focus request for ${itemId}.`);
	const made = await prepareReadWorktree({ instance: instance.name, itemId, stateDir: stateDir(), roots: instance.config.checkoutRoots ?? [], repo: item.repo, kind: item.kind, number: item.number });
	return { ok: true, itemId, repo: item.repo, number: item.number, ...made };
}

async function start(itemId, out) {
	const instance = loadInstance(instanceName());
	if (instance.kind === "contributions") {
		const item = await readJson(join(boardDir(), "items", itemId + ".json"));
		if (!item) throw new Error(`${itemId} has no item on the board`);
		if (!allowedRepo(instance.name, item.repo)) throw new Refused(`${item.repo ?? "The item"} is no thread of this instance.`);
	}
	if (out.attach && !out.match) throw new Error(`--attach needs --match ${FOCUS_MATCHES.join("|")}`);
	if (!out.attach && out.match) throw new Error("--match goes with --attach");
	try {
		const record = await startFocus({ itemId, harness: out.harness, session: { id: out.session, link: out.link, title: out.title }, how: out.attach ? "attached" : "started", match: out.match ?? null, requestId: out.request, transcript: out.transcript ?? null });
		return { ok: true, record };
	} catch (e) {
		if (/already in focus/.test(e.message)) throw new Refused(e.message);
		throw e;
	}
}

async function done(rest, out) {
	let itemId = rest[0];
	let session = out.session;
	let summary;
	if (out["message-file"]) {
		const m = parseDoneMessage(readText(out["message-file"], "message"));
		if (!m) throw new Error("The message is no done message of a focus session");
		if (m.instance !== instanceName()) throw new Error(`The message names instance ${m.instance}, not ${instanceName()}`);
		if (itemId && itemId !== m.item) throw new Error(`The message names ${m.item}, not ${itemId}`);
		itemId = m.item;
		session = m.session;
		summary = m.summary ?? "";
	} else {
		if (!itemId || !session || !out["summary-file"]) throw new Error(USAGE);
		summary = readText(out["summary-file"], "summary");
	}
	if (summary.length > MAX_SUMMARY) summary = summary.slice(0, MAX_SUMMARY - 1) + "…";
	const r = await endFocus({ itemId, by: "done", summary, session });
	if (!r.actionId) throw new Refused(`${itemId} is not in focus. Nothing changed.`);
	return { ok: true, itemId, ended: true, actionId: r.actionId };
}

async function list(json) {
	const records = await readFocuses();
	if (json) return { ok: true, records };
	const lines = Object.values(records).map((r) => `${r.itemId} ${r.status} ${r.harness} ${r.session?.title ?? r.session?.id}${r.status === "ended" ? ` ended ${r.endedAt} (${r.endedBy})` : `, last activity ${r.lastActivity}`}`);
	return { ok: true, text: lines.join("\n") || "No item is in focus." };
}

export async function main(argv) {
	const [command, ...args] = argv;
	let outcome;
	try {
		const { out, rest } = parse(args);
		const itemId = rest[0];
		const one = () => {
			if (rest.length !== 1) throw new Error(USAGE);
			return itemId;
		};
		if (command === "brief") outcome = await brief(one(), out);
		else if (command === "start") outcome = await start(one(), out);
		else if (command === "workdir") outcome = await workdir(one(), out);
		else if (command === "fail") outcome = { ok: true, ...(await failFocus({ itemId: one(), requestId: out.request, reason: out.reason })) };
		else if (command === "done") outcome = await done(rest, out);
		else if (command === "end") {
			const r = await endFocus({ itemId: one(), by: "end" });
			if (!r.actionId) throw new Refused(`${itemId} is not in focus. Nothing changed.`);
			outcome = { ok: true, itemId, ended: true, actionId: r.actionId };
		} else if (command === "check") {
			const r = await checkFocus({ itemId: one(), activityAt: out.activity, archived: out.archived === true });
			outcome = { ok: true, itemId, status: r.record?.status ?? null, changed: r.changed, ...(r.actionId && { actionId: r.actionId }) };
		} else if (command === "list") outcome = await list(out.json === true);
		else throw new Error(USAGE);
	} catch (e) {
		outcome = { ok: false, ...(e instanceof Refused && { refused: true }), result: e.message };
	}
	if (typeof outcome.text === "string") console.log(outcome.text);
	else console.log(JSON.stringify(outcome));
	process.exitCode = outcome.ok ? 0 : outcome.refused ? 3 : 1;
}
