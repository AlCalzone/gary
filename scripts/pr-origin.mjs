// gary pr-origin [--json] [--refresh]
// Finds the local Claude Code session that opened each open PR by the bot that Gary did not open, and caches it in
// <state>/origins.json. It reads the PRs from the staged snapshot, or the baseline when nothing is staged. A cached
// PR is not searched again, only its `lastActiveAt` moves. `--refresh` searches every PR again.
import { instanceName, loadInstance } from "./lib/config.mjs";
import { fixPrNumbers, readFixRecords, readSnapshotItems } from "./lib/fixes.mjs";
import { sessionsDir, updateOrigins } from "./lib/origins.mjs";

const USAGE = "Usage: gary pr-origin [--json] [--refresh]";

/** The open PRs by `bot` in the snapshot that are not in fixes.json, as `[{ number, repo, branch, createdAt }]`. */
export async function botPrsOutsideGary(bot, repo) {
	if (!bot) return [];
	const fixes = fixPrNumbers(await readFixRecords());
	const out = [];
	for (const [id, entry] of Object.entries(await readSnapshotItems())) {
		const number = Number(/^pr-(\d+)$/.exec(id)?.[1]);
		if (!Number.isSafeInteger(number) || fixes.has(number)) continue;
		if (String(entry?.author ?? "").toLowerCase() !== bot.toLowerCase()) continue;
		out.push({ number, repo, branch: typeof entry.headRef === "string" ? entry.headRef : null, createdAt: entry.createdAt ?? null });
	}
	return out.sort((a, b) => a.number - b.number);
}

export async function main(argv) {
	if (argv.some((a) => a !== "--json" && a !== "--refresh")) throw new Error(USAGE);
	const instance = loadInstance(instanceName());
	const prs = await botPrsOutsideGary(instance.config.bot?.login ?? null, instance.repos[0]);
	// An entry from before the snapshot kept `createdAt` gets its origin after the next snapshot
	const origins = await updateOrigins(prs.filter((p) => p.createdAt), { refresh: argv.includes("--refresh") });
	if (argv.includes("--json")) {
		console.log(JSON.stringify({ ok: true, sessions: sessionsDir(), origins }));
		return;
	}
	const lines = Object.entries(origins).map(([id, o]) =>
		o.found ? `#${id.slice(3)} opened by session ${o.sessionId} in ${o.cwd}, last active ${o.lastActiveAt}` : `#${id.slice(3)} no local session found`);
	console.log(lines.join("\n") || "No open PRs by the bot outside Gary.");
}
