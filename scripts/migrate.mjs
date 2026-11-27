// gary migrate: moves instances to the single-server layout. Safe to run again, it changes only what is missing.
//   - every instance config gets `kind` and loses `port`
//   - the root config.json gets the port, from the first instance that had one
//   - every stored item without `repo` gets the instance's repo
//   - a server-token in an instance's state moves to <root>/state/
//   - `fixReview.reviewer` goes: "copilot" is the default, "off" becomes `maxRounds: 0`
import { parseJsonc, setJsoncValue } from "./lib/jsonc.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./lib/board-store.mjs";
import { DEFAULT_PORT, hasFlatLayout, instanceDir, instanceNames, instancePath, rootConfigFile, rootDir, rootStateDir } from "./lib/config.mjs";

/**
 * The instance config without `fixReview.reviewer`, or null when it has none. "copilot" is dropped, because it asks the
 * default bots. "off" becomes `maxRounds: 0`, which gives fix PRs no rounds.
 */
export function withoutFixReviewer(config) {
	const fr = config?.fixReview;
	if (!fr || typeof fr !== "object" || Array.isArray(fr) || !Object.hasOwn(fr, "reviewer")) return null;
	const { reviewer, ...rest } = fr;
	return { ...config, fixReview: reviewer === "off" ? { ...rest, maxRounds: 0 } : rest };
}

/**
 * The config text without the line that holds `"reviewer"` alone, or null when there is no such line.
 * "off" turns the line into `"maxRounds": 0` and drops another `maxRounds` line. Everything else stays, comments too.
 */
export function editReviewerLine(text) {
	const line = /^([ \t]*)"reviewer"[ \t]*:[ \t]*"(copilot|off)"[ \t]*(,?)[ \t]*\r?\n/m.exec(text);
	if (!line) return null;
	const [whole, indent, value, comma] = line;
	let before = text.slice(0, line.index);
	let after = text.slice(line.index + whole.length);
	if (value === "off") {
		const rounds = /^[ \t]*"maxRounds"[ \t]*:[ \t]*\d+[ \t]*,?[ \t]*\r?\n/m;
		// The object closes at the first "}" after the line, and an older maxRounds line sits before that
		const end = after.indexOf("}");
		const start = before.lastIndexOf("{");
		before = before.slice(0, start) + before.slice(start).replace(rounds, "");
		after = after.slice(0, end).replace(rounds, "") + after.slice(end);
		return `${before}${indent}"maxRounds": 0${/^\s*}/.test(after) ? "" : ","}\n${after}`;
	}
	// A dropped last line leaves a comma on the line before
	if (!comma && /^\s*}/.test(after)) before = before.replace(/,([ \t]*\r?\n)$/, "$1");
	return before + after;
}

/** Writes `config` to `file`. The comments stay when only the one-line `fixReview` changed. */
async function writeFixReview(file, config) {
	const text = readFileSync(file, "utf8");
	const edited = editReviewerLine(text);
	if (edited && JSON.stringify(parseJsonc(edited)) === JSON.stringify(config)) {
		await writeAtomic(file, edited, { raw: true });
		return;
	}
	try {
		const next = setJsoncValue(text, "fixReview", config.fixReview);
		if (JSON.stringify(parseJsonc(next)) === JSON.stringify(config)) {
			await writeAtomic(file, next, { raw: true });
			return;
		}
	} catch {
		// A fixReview over several lines is written with the whole file below
	}
	await writeAtomic(file, config);
}

function readJson(file) {
	try {
		return parseJsonc(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** Runs the migration and returns one line per change. Throws on the layout from before instances. */
export async function migrate() {
	if (hasFlatLayout()) throw new Error(`${rootDir()} still has the layout from before instances. Run \`gary setup\` once, it moves it first.`);
	mkdirSync(rootDir(), { recursive: true });
	const report = [];
	const ports = [];
	for (const name of instanceNames()) {
		const file = join(instanceDir(name), "config.json");
		const config = readJson(file);
		if (!config) {
			report.push(`skipped ${name}: ${file} is not readable JSON`);
			continue;
		}
		let changed = false;
		if (config.kind === undefined) {
			config.kind = "maintainer";
			changed = true;
			report.push(`${name}: set kind maintainer`);
		}
		if (Object.hasOwn(config, "port")) {
			ports.push(config.port);
			delete config.port;
			changed = true;
			report.push(`${name}: moved port ${ports.at(-1)} out of the instance config`);
		}
		if (changed) await writeAtomic(file, config);
		const migrated = withoutFixReviewer(config);
		if (migrated) {
			await writeFixReview(file, migrated);
			report.push(`${name}: ${config.fixReview.reviewer === "off" ? "replaced fixReview.reviewer off with fixReview.maxRounds 0" : `removed fixReview.reviewer ${JSON.stringify(config.fixReview.reviewer)}, the review bots are the default`}`);
		}

		const repo = typeof config.profile === "string" ? readJson(join(instancePath(name, config.profile), "profile.json"))?.repo : null;
		const items = join(instanceDir(name), "state", "board", "items");
		if (existsSync(items) && repo) {
			let added = 0;
			for (const n of readdirSync(items).filter((n) => n.endsWith(".json") && !n.startsWith("."))) {
				const doc = readJson(join(items, n));
				if (doc && typeof doc === "object" && !doc.repo) {
					await writeAtomic(join(items, n), { ...doc, repo });
					added++;
				}
			}
			if (added) report.push(`${name}: added repo ${repo} to ${added} item${added === 1 ? "" : "s"}`);
		} else if (existsSync(items)) report.push(`${name}: no repo in the profile, items left as they are`);

		const token = join(instanceDir(name), "state", "server-token");
		if (existsSync(token)) {
			const shared = join(rootStateDir(), "server-token");
			mkdirSync(rootStateDir(), { recursive: true });
			if (existsSync(shared)) {
				unlinkSync(token);
				report.push(`${name}: removed its server-token, the root one stays`);
			} else {
				renameSync(token, shared);
				report.push(`${name}: moved its server-token to ${shared}`);
			}
		}
	}

	const root = readJson(rootConfigFile());
	if (!root || root.port === undefined) {
		const port = ports.find((p) => Number.isInteger(p)) ?? DEFAULT_PORT;
		await writeAtomic(rootConfigFile(), { ...(root ?? {}), port });
		report.push(`root: set port ${port} in ${rootConfigFile()}`);
	}
	return report;
}

export async function main() {
	const report = await migrate();
	console.log(report.length ? report.join("\n") : "Nothing to migrate.");
}
