// gary instances [--json]: lists the instances with repo, port, pause and board server, and marks the one
// this directory resolves to.
import { join } from "node:path";
import { instanceDir, instanceFacts, listInstances, resolveInstance, rootDir } from "./lib/config.mjs";
import { isPaused } from "./lib/control.mjs";

async function answers(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
		return (await res.json())?.name === "gary";
	} catch {
		return false;
	}
}

export async function main(argv) {
	let current = null;
	try {
		current = resolveInstance().name;
	} catch {
		// No instance or several match. The list still shows them all
	}
	const rows = await Promise.all(
		listInstances().map(async (name) => {
			const f = instanceFacts(name);
			return { name, repo: f.repo, port: f.port, paused: isPaused(join(instanceDir(name), "state")), serverAnswers: await answers(f.port), current: name === current };
		}),
	);
	if (argv.includes("--json")) return console.log(JSON.stringify(rows, null, 2));
	if (!rows.length) return console.log(`No instance in ${rootDir()}. Run \`gary setup\`.`);
	for (const r of rows) {
		console.log(`${r.current ? "*" : " "} ${r.name.padEnd(20)} ${String(r.repo ?? "-").padEnd(32)} port ${String(r.port).padEnd(6)} ${r.paused ? "paused " : "running"} ${r.serverAnswers ? "board up" : "board down"}`);
	}
}
