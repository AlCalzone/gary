// gary instances [--json]: lists the instances with kind, repos, checkout and pause, whether the one board server
// serves them, and marks the one this directory resolves to. Invalid settings and unknown fields are shown too.
import { listInstances, resolveInstance, rootConfig, rootDir } from "./lib/config.mjs";

/** The instances the board server lists, or null when it does not answer. */
async function served(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
		const body = await res.json();
		return body?.name === "gary" && Array.isArray(body.instances) ? body.instances : null;
	} catch {
		return null;
	}
}

export async function main(argv) {
	let current = null;
	try {
		current = resolveInstance().name;
	} catch {
		// No instance or several match. The list still shows them all
	}
	const { port } = rootConfig();
	const serving = await served(port);
	const rows = listInstances().map((i) => ({ ...i, served: !!serving?.includes(i.name), current: i.name === current }));
	if (argv.includes("--json")) return console.log(JSON.stringify(rows, null, 2));
	if (!rows.length) return console.log(`No instance in ${rootDir()}. Run \`gary setup\`.`);
	console.log(`Board server on port ${port}: ${serving ? "up" : "down"}`);
	for (const r of rows) {
		console.log(`${r.current ? "*" : " "} ${r.name.padEnd(20)} ${(r.kind ?? "invalid").padEnd(11)} ${r.repos.join(", ").padEnd(32)} ${r.paused ? "paused " : "running"} ${r.served ? "on the board" : "not on the board"}`);
		if (r.settingsError) console.log(`    error: ${r.settingsError.replaceAll("\n", "\n    ")}`);
		for (const w of r.settingsWarnings ?? []) console.log(`    warning: ${w}`);
	}
}
