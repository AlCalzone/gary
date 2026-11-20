// gary reconcile [request]        ask for a reconcile pass. The master starts it from the queue
// gary reconcile due [--json]     say whether a pass is due and why
// gary reconcile names [--json]   the names rules may refer to today, the retired ones and the ones gone since the last pass
// gary reconcile files [--json]   the rule files of the instance, its profile skills and the core files a pass reads
// gary reconcile start            mark a pass as started. Exit 3 when another one runs
// gary reconcile done [--until <ISO>]   mark the pass as done. --until is the `at` of the newest log entry it read
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, instanceName, loadInstance, personalFiles } from "./lib/config.mjs";
import { currentNames, finishReconcile, namesHash, namesList, readReconcile, reconcileDue, requestReconcile, retiredNames, startReconcile } from "./lib/reconcile.mjs";

async function mdFiles(dir) {
	try {
		return (await readdir(dir)).filter((n) => n.endsWith(".md")).sort().map((n) => join(dir, n));
	} catch (e) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
}

// Every core skill with its references, the routine's own references first
async function coreSkills() {
	const out = [];
	for (const name of (await readdir(join(ROOT, "skills"))).sort()) {
		out.push(join(ROOT, "skills", name, "SKILL.md"));
		if (name !== "triage-routine") out.push(...(await mdFiles(join(ROOT, "skills", name, "references"))));
	}
	return out;
}

async function profileSkills(dir) {
	try {
		return (await readdir(join(dir, "skills"))).sort().map((n) => join(dir, "skills", n, "SKILL.md"));
	} catch (e) {
		if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
		throw e;
	}
}

const print = (argv, data, text) => console.log(argv.includes("--json") ? JSON.stringify(data, null, 2) : text);

export async function main(argv) {
	const [sub = "request", ...rest] = argv.filter((a) => a !== "--json");
	const instance = instanceName();
	switch (sub) {
		case "request": {
			const at = await requestReconcile(instance);
			return print(argv, { ok: true, instance, requestedAt: at }, `Reconcile requested for ${instance}. The master starts it from the queue, or the next hourly run does.`);
		}
		case "due": {
			const d = reconcileDue(await readReconcile(instance));
			const why = d.running ? "a pass runs" : d.reasons.length ? d.reasons.join(", ") : "nothing changed";
			return print(argv, { instance, ...d }, `${d.due ? "Due" : "Not due"}: ${why}.${d.removed.length ? ` Gone since the last pass: ${d.removed.join(", ")}.` : ""}`);
		}
		case "names": {
			const d = reconcileDue(await readReconcile(instance));
			const data = { current: currentNames(), retired: retiredNames(), removed: d.removed, hash: namesHash() };
			const lines = [...Object.entries(data.current).map(([k, v]) => `${k}: ${v.join(", ")}`), ...Object.entries(data.retired).map(([k, v]) => `retired ${k}: ${Object.entries(v).map(([a, b]) => `${a} -> ${b}`).join(", ")}`)];
			if (d.removed.length) lines.push(`gone since the last pass: ${d.removed.join(", ")}`);
			return print(argv, data, lines.join("\n"));
		}
		case "files": {
			const i = loadInstance(instance);
			const refs = join(ROOT, "skills", "triage-routine", "references");
			const data = {
				profile: [...(await mdFiles(join(i.profileDir, "rules"))), ...(await mdFiles(join(i.profileDir, "templates")))],
				personal: personalFiles(),
				core: [join(ROOT, "SPEC.md"), ...(await mdFiles(refs)), ...(await coreSkills())],
				profileSkills: await profileSkills(i.profileDir),
			};
			return print(argv, data, Object.entries(data).map(([k, v]) => `${k}:\n${v.map((f) => `  ${f}`).join("\n")}`).join("\n"));
		}
		case "start": {
			if (await startReconcile(instance)) return print(argv, { ok: true, instance }, `Reconcile started for ${instance}.`);
			console.log(argv.includes("--json") ? JSON.stringify({ ok: false, instance, why: "another pass runs" }) : "Another reconcile pass runs. Nothing to do.");
			process.exitCode = 3;
			return;
		}
		case "done": {
			const i = rest.indexOf("--until");
			const next = await finishReconcile(instance, { reviewedUntil: i >= 0 ? rest[i + 1] : undefined });
			return print(argv, { ok: true, instance, ...next, names: undefined }, `Reconcile done for ${instance} at ${next.lastReconcileAt}. ${namesList().length} names recorded.`);
		}
		default:
			throw new Error(`Unknown subcommand "${sub}". Use request, due, names, files, start or done`);
	}
}
