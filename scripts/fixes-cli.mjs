// gary fix-record <itemId> --pr <number> --branch <name> --run <run> --by routine|maintainer: records a fix PR Gary opened.
// gary fixes [--json]: the fix state of every issue and discussion, for the routine.
import { loadInstance, instanceName } from "./lib/config.mjs";
import { fixStates, recordFix } from "./lib/fixes.mjs";

function options(argv, names) {
	const out = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (names.includes(argv[i])) out[argv[i].slice(2)] = argv[++i];
		else rest.push(argv[i]);
	}
	return { out, rest };
}

export async function recordMain(argv) {
	const { out, rest } = options(argv, ["--pr", "--branch", "--run", "--by"]);
	if (rest.length !== 1 || !out.pr) throw new Error("Usage: gary fix-record <itemId> --pr <number> --branch <name> --run <run> --by routine|maintainer");
	const entry = await recordFix({ itemId: rest[0], number: Number(out.pr), branch: out.branch, run: out.run, startedBy: out.by, repo: loadInstance(instanceName()).repos[0] });
	console.log(JSON.stringify({ ok: true, itemId: rest[0], ...entry }));
}

export async function fixesMain(argv) {
	const states = await fixStates();
	if (argv.includes("--json")) return console.log(JSON.stringify(states, null, 2));
	for (const [id, f] of Object.entries(states)) {
		const pr = f.pr ? `PR #${f.pr.number}${f.pr.title ? ` ${f.pr.title}` : ""}` : "job running";
		console.log(`${id.padEnd(14)} ${f.state.padEnd(8)} ${pr} (started by the ${f.startedBy}${f.since ? ` at ${f.since}` : ""})`);
	}
	console.log(`${Object.keys(states).length} item${Object.keys(states).length === 1 ? "" : "s"} with a fix`);
}
