// The pause switch in <state>/control.json. It lives outside config.json, so a change needs no restart.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./board-store.mjs";
import { instanceDir, instanceName, instanceNames, stateDir } from "./config.mjs";

export const PAUSED_MESSAGE = "Gary is paused. Nothing was sent.";

export const controlFile = (dir = stateDir()) => join(dir, "control.json");

/** Reads the switch on every call, so `gary pause` takes effect at once. */
export function isPaused(dir) {
	try {
		return JSON.parse(readFileSync(controlFile(dir), "utf8"))?.paused === true;
	} catch {
		return false;
	}
}

/** Whether an instance is paused, by name. */
export const isInstancePaused = (instance) => isPaused(join(instanceDir(instance), "state"));

export async function setPaused(paused, dir = stateDir()) {
	mkdirSync(dir, { recursive: true });
	await writeAtomic(controlFile(dir), { paused, at: new Date().toISOString() });
}

async function toggle(paused, argv) {
	const names = argv.includes("--all") ? instanceNames() : [instanceName()];
	if (!names.length) throw new Error("There is no instance to change.");
	for (const name of names) {
		await setPaused(paused, join(instanceDir(name), "state"));
		console.error(`${paused ? "Paused" : "Resumed"} ${name}.`);
	}
	console.log(paused ? "The board and gary action send nothing to GitHub, and queued agent requests wait." : "Gary runs again.");
}

/** gary pause [--all], gary resume [--all] */
export const pauseMain = (argv = []) => toggle(true, argv);
export const resumeMain = (argv = []) => toggle(false, argv);
