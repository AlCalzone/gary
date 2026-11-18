// gary claim <itemId> <fix|review|push> --run <run> [--ttl <minutes>] [--request <action id>]: claims work on an item.
// Exit 3 when another run holds it, and for a fix also when a fix PR is a draft or open, or another request is queued.
// A fix claim without --request is the routine's own fix. It also exits 3 at the limit `maxPendingAutoFixes`.
// gary release <itemId> <kind> --run <run>: removes the claim of that run.
// gary claims [--json]: lists the claims of the instance.
import { listClaims, releaseClaim, takeClaim } from "./lib/claims.mjs";
import { loadConfig } from "./lib/config.mjs";
import { fixStateOf, loadFixSources, pendingAutoFixes } from "./lib/fixes.mjs";

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
	// Count after the claim is taken, so two runs that claim at once never pass the limit together
	if (r.ok && kind === "fix" && request.value === undefined) {
		const limit = loadConfig().maxPendingAutoFixes;
		const pending = pendingAutoFixes(await loadFixSources());
		if (pending > limit) {
			await releaseClaim({ itemId, kind, run: run.value });
			const error = limit === 0
				? "Automatic fixes are off: maxPendingAutoFixes is 0."
				: `The limit of pending automatic fixes is reached: ${pending - 1} of ${limit} are a draft, open or running. A merged or closed fix PR frees a slot.`;
			console.log(JSON.stringify({ ok: false, error, limit: { pending: pending - 1, max: limit } }));
			process.exitCode = 3;
			return;
		}
	}
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
