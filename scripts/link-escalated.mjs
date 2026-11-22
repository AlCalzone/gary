// gary link-escalated [--dry-run]: finds the issues that escalated discussions became and links Gary's fix PRs to them.
// It prints one JSON object. Exit 1 when a read or a write failed, and the next run tries again.
import { linkEscalated } from "./lib/escalation.mjs";

export async function main(argv) {
	if (argv.some((a) => a !== "--dry-run")) throw new Error("Usage: gary link-escalated [--dry-run]");
	const out = await linkEscalated({ dryRun: argv.includes("--dry-run") });
	console.log(JSON.stringify(out));
	if (!out.ok) process.exitCode = 1;
}
