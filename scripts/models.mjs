// gary models [--json] [--all]: the model of every role, for the skills that start sessions and subagents.
// Without --all it prints the resolved instance, with --all the master's model and every instance.
import { MODEL_ROLES, SettingsError, instanceName, instanceNames, modelsFor, modelsOf, rootDir } from "./lib/config.mjs";

const SOURCE = { instance: "instance config", root: "root config", default: "default" };

function fallbackLine(fallback) {
	if (!fallback) return "none, review and standard use the same model";
	return `${fallback.model}, ${fallback.relation === "smaller" ? "smaller than review" : "another model than review"}`;
}

function print({ models, sources, fallback }) {
	for (const role of MODEL_ROLES) console.log(`${role.padEnd(9)} ${models[role].padEnd(24)} ${SOURCE[sources[role]]}`);
	console.log(`${"fallback".padEnd(9)} ${fallbackLine(fallback)}`);
}

export async function main(argv) {
	const json = argv.includes("--json");
	if (!argv.includes("--all")) {
		const out = { instance: instanceName(), ...modelsFor(instanceName()) };
		if (json) console.log(JSON.stringify(out, null, 2));
		else print(out);
		return;
	}
	const names = instanceNames();
	if (!names.length) throw new SettingsError(`There is no instance in ${rootDir()}. Run \`gary setup\` first.`);
	// An instance config cannot set the master's model, so an empty one resolves it
	const all = { master: modelsOf({}).models.master, instances: {} };
	for (const name of names) {
		try {
			all.instances[name] = modelsFor(name);
		} catch (e) {
			if (!(e instanceof SettingsError)) throw e;
			all.instances[name] = { error: e.message };
		}
	}
	if (json) return console.log(JSON.stringify(all, null, 2));
	console.log(`master    ${all.master}`);
	for (const [name, entry] of Object.entries(all.instances)) {
		console.log(`== ${name}`);
		if (entry.error) console.log(`error: ${entry.error.replaceAll("\n", "\n  ")}`);
		else print(entry);
	}
}
