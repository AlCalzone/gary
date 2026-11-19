// Usage: gary push-check --pr <number> [--sha <head sha>] [--repo <owner/name>]
// Says from GitHub's state right now whether an agent may push to a PR from a checkout of its branch.
// Prints one JSON object. The exit code is 0 when the push is allowed and 3 when it is refused.
import { instanceName, loadInstance } from "./lib/config.mjs";
import { fetchItem } from "./snapshot.mjs";

const USAGE = "Usage: gary push-check --pr <number> [--sha <head sha>] [--repo <owner/name>]";
const OPTIONS = ["--pr", "--sha", "--repo"];

function options(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (!OPTIONS.includes(argv[i]) || argv[i + 1] === undefined) throw new Error(USAGE);
		out[argv[i].slice(2)] = argv[++i];
	}
	return out;
}

/**
 * Why an agent may not push to the PR of this fresh snapshot entry from a checkout, or null when it may.
 * `sha` is the head the agent's work is based on. The entry must list every changed file of the PR.
 */
export function pushCheckRefusal(entry, sha) {
	if (entry.githubState !== "open") return `PR #${entry.number} is ${entry.githubState}.`;
	if (sha !== undefined && entry.headSha !== sha) return `The head of PR #${entry.number} is ${entry.headSha}, not ${sha}. Someone pushed to it.`;
	const files = entry.sensitiveFiles ?? [];
	if (files.length && entry.facts?.sensitiveOurs !== true) {
		return `PR #${entry.number} changes sensitive files (${files.join(", ")}) and is not ours alone: ${entry.facts?.sensitiveNotOurs ?? "its commits could not be checked"}. No agent works in a checkout of it.`;
	}
	return null;
}

export async function main(argv) {
	const opts = options(argv);
	const number = Number(opts.pr);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error(USAGE);
	if (opts.sha !== undefined && !/^[0-9a-f]{40}$/.test(opts.sha)) throw new Error("--sha must be a full 40-character SHA");
	const repo = opts.repo ?? loadInstance(instanceName()).repos[0];
	const entry = await fetchItem("pr", number, repo, { allFiles: true });
	const refusal = pushCheckRefusal(entry, opts.sha);
	console.log(JSON.stringify({
		ok: !refusal,
		pr: number,
		repo,
		headSha: entry.headSha,
		sensitiveFiles: entry.sensitiveFiles ?? [],
		sensitiveOurs: entry.facts?.sensitiveOurs === true,
		...(refusal && { refused: refusal }),
	}));
	process.exitCode = refusal ? 3 : 0;
}
