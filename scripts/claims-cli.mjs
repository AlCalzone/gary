// gary claim <itemId> <fix|review|push> --run <run> [--ttl <minutes>] [--request <action id>]: claims work on an item.
// Exit 3 when another run holds it, and for a fix also when a fix PR is a draft or open, or another request is queued.
// gary release <itemId> <kind> --run <run>: removes the claim of that run.
// gary claims [--json]: lists the claims of the instance.
import { listClaims, releaseClaim, takeClaim } from "./lib/claims.mjs";
import { fixStateOf, loadFixSources } from "./lib/fixes.mjs";

function option(argv, name) {
	const i = argv.indexOf(name);
	if (i < 0) return { value: undefined, rest: argv };
	return { value: argv[i + 1], rest: argv.filter((_, j) => j !== i && j !== i + 1) };
}

export async function claimMain(argv) {
	const run = option(argv, "--run");
	const ttl = option(run.rest, "--ttl");
	const request = option(ttl.rest, "--request");
	const [itemId, kind, ...extra] = request.rest;
	if (!itemId || !kind || extra.length || run.value === undefined) throw new Error("Usage: gary claim <itemId> <fix|review|push> --run <run> [--ttl <minutes>] [--request <action id>]");
	const ttlMinutes = ttl.value === undefined ? undefined : Number(ttl.value);
	if (kind === "fix") {
		const sources = await loadFixSources();
		// A request worker names its own queued request. Any other queued start_fix belongs to someone else
		const otherRequest = sources.actions.find((a) => a.data.itemId === itemId && a.data.action === "start_fix" && a.data.status === "queued" && a.id !== request.value);
		const fix = fixStateOf(itemId, { ...sources, actions: [], claims: [] });
		const reason = otherRequest
			? `A fix request for ${itemId} is queued as ${otherRequest.id}`
			: fix && (fix.state === "draft" || fix.state === "open")
				? `A fix for ${itemId} is already open as ${fix.state === "draft" ? "draft " : ""}PR #${fix.pr.number}: ${fix.pr.url}`
				: null;
		if (reason) {
			console.log(JSON.stringify({ ok: false, error: reason, fix: fix ?? { state: "working" } }));
			process.exitCode = 3;
			return;
		}
	}
	const r = await takeClaim({ itemId, kind, run: run.value, ...(ttlMinutes !== undefined && { ttlMinutes }) });
	console.log(JSON.stringify(r.ok ? { ok: true, ...r.claim } : { ok: false, error: `${itemId} ${kind} is claimed by run ${r.holder?.run} until ${r.holder?.expiresAt}`, holder: r.holder }));
	if (!r.ok) process.exitCode = 3;
}

export async function releaseMain(argv) {
	const run = option(argv, "--run");
	const [itemId, kind, ...extra] = run.rest;
	if (!itemId || !kind || extra.length || run.value === undefined) throw new Error("Usage: gary release <itemId> <fix|review|push> --run <run>");
	const r = await releaseClaim({ itemId, kind, run: run.value });
	if (!r.released && r.holder) {
		console.log(JSON.stringify({ ok: false, error: `${itemId} ${kind} is claimed by run ${r.holder.run}, not ${run.value}`, holder: r.holder }));
		process.exitCode = 3;
		return;
	}
	console.log(JSON.stringify({ ok: true, released: r.released }));
}

export async function claimsMain(argv) {
	const list = await listClaims();
	if (argv.includes("--json")) return console.log(JSON.stringify(list, null, 2));
	for (const c of list) console.log(`${c.itemId.padEnd(14)} ${c.kind.padEnd(7)} ${String(c.run).padEnd(24)} until ${c.expiresAt}${c.expired ? " (expired)" : ""}`);
	console.log(`${list.length} claim${list.length === 1 ? "" : "s"}`);
}
