// gary claim <itemId> <fix|review|push> --run <run> [--ttl <minutes>]: claims work on an item. Exit 3 when another run holds it.
// gary release <itemId> <kind> --run <run>: removes the claim of that run.
// gary claims [--json]: lists the claims of the instance.
import { listClaims, releaseClaim, takeClaim } from "./lib/claims.mjs";

function option(argv, name) {
	const i = argv.indexOf(name);
	if (i < 0) return { value: undefined, rest: argv };
	return { value: argv[i + 1], rest: argv.filter((_, j) => j !== i && j !== i + 1) };
}

export async function claimMain(argv) {
	const run = option(argv, "--run");
	const ttl = option(run.rest, "--ttl");
	const [itemId, kind, ...extra] = ttl.rest;
	if (!itemId || !kind || extra.length || run.value === undefined) throw new Error("Usage: gary claim <itemId> <fix|review|push> --run <run> [--ttl <minutes>]");
	const ttlMinutes = ttl.value === undefined ? undefined : Number(ttl.value);
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
