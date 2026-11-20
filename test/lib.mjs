// Shared helpers for the test suites: temp homes, the fake gh on PATH, free ports and a small check runner.
// A root gets port 9 unless a test passes its own, so `gary put` never reaches a real board server.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOT, BOT_TOKEN, ME } from "./fixtures/github.mjs";

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(TEST_DIR, "..");
export const GARY = join(ROOT, "bin", "gary");
export const PROFILE = join(TEST_DIR, "fixtures", "profile");
export const FAKE_GH_DIR = join(TEST_DIR, "fake-gh");

export function tempDir(prefix = "gary-test-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

// No test reads the real Claude Code session transcripts. A suite that needs some passes its own directory
const NO_SESSIONS = join(tmpdir(), "gary-test-no-sessions");

/** Environment with the fake gh first on PATH, no real token and no real session transcripts. */
export function testEnv(extra = {}) {
	const env = { ...process.env, PATH: FAKE_GH_DIR + delimiter + process.env.PATH, GARY_SESSIONS_DIR: NO_SESSIONS, ...extra };
	for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[name];
	return env;
}

/**
 * Creates a root with one instance (default "widgets") for the fixture profile and returns `{ home, root, env }`.
 * `home` is the instance directory.
 * `config` overrides config.json fields, like `{ bot: null }`. Its `port` goes into the root config.json.
 * A second call with another `name` and the same `dir` adds an instance to the same root.
 */
export function makeHome(dir, config = {}, name = "widgets") {
	const root = join(dir, "root");
	const home = join(root, "instances", name);
	mkdirSync(join(home, "state", "board", "items"), { recursive: true });
	mkdirSync(join(home, "state", "board", "actions"), { recursive: true });
	const tokenFile = join(dir, "bot-token");
	writeFileSync(tokenFile, BOT_TOKEN + "\n", { mode: 0o600 });
	writeFileSync(join(home, "state", "board", "meta.json"), "{}");
	const { port = 9, ...rest } = config;
	writeFileSync(join(home, "config.json"), JSON.stringify({ kind: "maintainer", profile: PROFILE, me: ME, bot: { login: BOT, tokenFile }, ...rest }, null, "\t"));
	// The root config holds the one server's port. A second makeHome in the same dir keeps the first port
	if (!existsSync(join(root, "config.json"))) writeFileSync(join(root, "config.json"), JSON.stringify({ port }));
	return { home, root, env: testEnv({ GARY_HOME: root }) };
}

export function freePort() {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

export function runner(name) {
	let pass = 0;
	let fail = 0;
	return {
		check(label, cond, detail) {
			if (cond) pass++;
			else {
				fail++;
				console.log("FAIL", label, detail === undefined ? "" : JSON.stringify(detail)?.slice(0, 600));
			}
		},
		done() {
			console.log(`${name}: ${pass} passed, ${fail} failed`);
			process.exitCode = fail ? 1 : 0;
			return fail === 0;
		},
	};
}

export const removeDir = (dir) => rmSync(dir, { recursive: true, force: true });
