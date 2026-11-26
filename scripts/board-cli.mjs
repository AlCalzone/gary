// gary board: the board's own buttons for an agent, sent to the running board server, which checks and applies them the
// same way as a click. The chat session uses it. Nothing here writes a board file itself or reaches GitHub.
//   gary board list [--category <c>] [--kind pr|issue|discussion] [--state open|merged|closed] [--json]
//   gary board got-it <item>...                   "Got it" on fyi items, with the notification rule of a click
//   gary board snooze <item>... --days <1-90>     "Snooze"
//   gary board hide <item>...                     "Hide until it changes"
//   gary board restore <item>...                  "Show again": ends a snooze and a hide
//   gary board dismiss-route <item> --route <id> --reason <text>
//   gary board analyze <item>... [--note <text>]  "Analyze again", queued for the master
//   gary board review <item>...                   a full review, queued for the master
// <item> is a key like widgets/pr-12, as `list` prints it, or an item id of the instance that --instance names.
import { readFileSync } from "node:fs";
import { ID_PATTERN, tokenFile } from "./lib/board-store.mjs";
import { INSTANCE_NAME, explicitInstance, instanceName, rootConfig } from "./lib/config.mjs";

const USAGE = "Usage: gary board list [--category <c>] [--kind pr|issue|discussion] [--state open|merged|closed] [--json] | got-it <item>... | snooze <item>... --days <1-90> | hide <item>... | restore <item>... | dismiss-route <item> --route <id> --reason <text> | analyze <item>... [--note <text>] | review <item>...";
const VALUES = ["--category", "--kind", "--state", "--days", "--route", "--reason", "--note"];
const FLAGS = ["--json"];
const MAX_ITEMS = 200;

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

/** Sends one request to the running board server. Throws when no server answers, because only the server may apply it. */
async function api(path, body) {
	const { port } = rootConfig();
	let token;
	try {
		token = readFileSync(tokenFile(), "utf8").trim();
	} catch {
		throw new Error("The board server never ran on this machine. Start it with `gary serve` or the board_start tool.");
	}
	let res;
	try {
		res = await fetch(`http://127.0.0.1:${port}${path}`, {
			method: body ? "POST" : "GET",
			headers: body ? { "Content-Type": "application/json", "X-Board-Token": token } : { "X-Board-Token": token },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(60000),
		});
	} catch {
		throw new Error(`The board server on port ${port} does not answer. Start it with \`gary serve\` or the board_start tool.`);
	}
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

function keyOf(arg) {
	const at = arg.indexOf("/");
	const instance = at > 0 ? arg.slice(0, at) : instanceName();
	const id = at > 0 ? arg.slice(at + 1) : arg;
	if (!INSTANCE_NAME.test(instance) || !ID_PATTERN.test(id)) throw new Error(`${arg} is no item key like widgets/pr-12`);
	return { instance, id, key: `${instance}/${id}` };
}

const stateOf = (item) => String(item.liveState?.state ?? "open").toLowerCase();

async function list(out) {
	const r = await api("/api/state");
	if (r.status !== 200 || !Array.isArray(r.data?.items)) throw new Error(`The board server answered ${r.status}`);
	const only = explicitInstance();
	const rows = r.data.items
		.filter((i) => (!only || i.instance === only) && (!out.category || i.category === out.category) && (!out.kind || i.kind === out.kind) && (!out.state || stateOf(i) === out.state))
		.map((i) => ({
			key: `${i.instance}/${i.id}`,
			ref: i.ref ?? null,
			kind: i.kind,
			title: i.title ?? null,
			category: i.category ?? null,
			state: stateOf(i),
			url: i.url ?? null,
			hidden: i.hidden === true,
			snoozedUntil: i.snoozedUntil ?? null,
			gotIt: i.gotIt?.at ?? null,
			newsAt: i.newsAt ?? null,
			handled: i.handled?.at ?? null,
			focus: i.focus?.status ?? null,
			routes: (Array.isArray(i.routes) ? i.routes : []).map((x) => ({ id: x.id, type: x.type, title: x.title ?? null, as: x.as ?? null })),
		}));
	if (out.json) return { ok: true, count: rows.length, items: rows };
	const marks = (x) => [x.hidden && "hidden", x.snoozedUntil && `snoozed until ${x.snoozedUntil}`, x.gotIt && `got it ${x.gotIt}`, x.focus && `focus ${x.focus}`].filter(Boolean).join(", ");
	return { ok: true, text: rows.map((x) => `${x.key} ${x.ref ?? ""} ${x.category ?? "-"} ${x.state} ${x.title ?? ""}${marks(x) ? ` [${marks(x)}]` : ""}`).join("\n") || "No item matches." };
}

const nowIso = () => new Date().toISOString();

/** The action doc the page writes next to a board click, here marked as sent from the chat. */
function actionDoc({ instance, id }, action, params, text, status) {
	const at = nowIso();
	return { op: "set", path: `actions/${instance}/${id}-${Date.now()}`, data: { instance, itemId: id, action, params, text, status, via: status === "queued" ? "queue" : "chat", createdAt: at, finishedAt: status === "queued" ? null : at, result: "" } };
}

async function db(write) {
	const r = await api("/api/db", write);
	if (r.status !== 200) throw new Error(r.data?.error ?? `The board server answered ${r.status}`);
}

async function action(body) {
	const r = await api("/api/action", body);
	if (r.data?.ok) return r.data.result ?? "Done.";
	throw new Error(r.data?.result ?? r.data?.error ?? `The board server answered ${r.status}`);
}

const OPS = {
	"got-it": (k) => action({ instance: k.instance, action: "got_it", itemId: k.id }),
	async snooze(k, out) {
		const days = Number(out.days);
		if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--days must be a whole number from 1 to 90");
		await db({ op: "update", path: `items/${k.instance}/${k.id}`, data: { snoozedUntil: new Date(Date.now() + days * 86400000).toISOString() } });
		await db(actionDoc(k, "snooze", { days }, "", "done"));
		return `Snoozed for ${days} day${days === 1 ? "" : "s"}.`;
	},
	async hide(k) {
		await db({ op: "update", path: `items/${k.instance}/${k.id}`, data: { hidden: true } });
		await db(actionDoc(k, "dismiss", {}, "", "done"));
		return "Hidden until it changes.";
	},
	async restore(k) {
		await db({ op: "update", path: `items/${k.instance}/${k.id}`, data: { hidden: false, snoozedUntil: null } });
		return "Shown again.";
	},
	"dismiss-route": (k, out) => {
		if (!out.route) throw new Error("--route must name the route id, as `gary board list` prints it");
		return action({ instance: k.instance, action: "dismiss_route", itemId: k.id, routeId: out.route, text: out.reason ?? "" });
	},
	async analyze(k, out) {
		await db(actionDoc(k, "reanalyze", {}, out.note ?? "", "queued"));
		return "Queued Analyze again.";
	},
	async review(k) {
		await db(actionDoc(k, "full_review", {}, "", "queued"));
		return "Queued a full review.";
	},
};

export async function main(argv) {
	const [command, ...args] = argv;
	let outcome;
	try {
		const { out, rest } = parse(args);
		if (command === "list") outcome = await list(out);
		else if (Object.hasOwn(OPS, command)) {
			if (!rest.length) throw new Error(`gary board ${command} needs at least one item key`);
			if (command === "dismiss-route" && rest.length !== 1) throw new Error("gary board dismiss-route takes one item key");
			if (rest.length > MAX_ITEMS) throw new Error(`At most ${MAX_ITEMS} items per call`);
			const keys = rest.map(keyOf);
			const results = [];
			for (const k of keys) {
				try {
					results.push({ key: k.key, ok: true, result: await OPS[command](k, out) });
				} catch (e) {
					results.push({ key: k.key, ok: false, result: e.message });
				}
			}
			outcome = { ok: results.every((r) => r.ok), done: results.filter((r) => r.ok).length, refused: results.filter((r) => !r.ok).length, results };
		} else throw new Error(USAGE);
	} catch (e) {
		outcome = { ok: false, result: e.message };
	}
	if (typeof outcome.text === "string") console.log(outcome.text);
	else console.log(JSON.stringify(outcome));
	process.exitCode = outcome.ok ? 0 : 1;
}
