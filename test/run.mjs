// Runs the test suites one after the other and exits with 1 when one fails.
//   node test/run.mjs          the suites without a browser
//   node test/run.mjs --page   the page suites, which need Chrome or Chromium
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { TEST_DIR } from "./lib.mjs";

const SUITES = [
	["node", "config.test.mjs"],
	["node", "actions.test.mjs"],
	["node", "server.test.mjs"],
	["node", "server-shim.test.mjs"],
	["node", "accounts.test.mjs"],
	["node", "learning.test.mjs"],
	["node", "answers.test.mjs"],
	["node", "settings.test.mjs"],
	["node", "models.test.mjs"],
	["node", "pause.test.mjs"],
	["node", "instances.test.mjs"],
	["node", "migrate.test.mjs"],
	["node", "facts.test.mjs"],
	["node", "since.test.mjs"],
	["node", "tiers.test.mjs"],
	["node", "claims.test.mjs"],
	["node", "fixes.test.mjs"],
	["node", "fix-review.test.mjs"],
	["node", "pr-watch.test.mjs"],
	["node", "auto-review.test.mjs"],
	["node", "escalate.test.mjs"],
	["node", "api-edit.test.mjs"],
	["node", "ours.test.mjs"],
	["node", "origins.test.mjs"],
	["zsh", "sharing.test.zsh"],
	["zsh", "validate.test.zsh"],
];
const PAGE_SUITES = [
	["node", "page/run-mock.mjs"],
	["node", "page/served.mjs"],
	["node", "page/served-nobot.mjs"],
	["node", "page/served-nobot.mjs", "own"],
	["node", "page/served-tabs.mjs"],
];

const list = process.argv.includes("--page") ? PAGE_SUITES : SUITES;
let failed = 0;
for (const [bin, file, ...args] of list) {
	// A suite that hangs fails after its timeout, so the rest still runs
	const r = spawnSync(bin === "node" ? process.execPath : bin, [join(TEST_DIR, file), ...args], { stdio: "inherit", timeout: 300000, killSignal: "SIGKILL" });
	if (r.error) console.log(`${file}: ${r.error.code === "ETIMEDOUT" ? "timed out after 300 s" : `could not start ${bin}: ${r.error.message}`}`);
	if (r.status !== 0) failed++;
}
console.log(failed ? `${failed} of ${list.length} suites failed` : `all ${list.length} suites passed`);
process.exitCode = failed ? 1 : 0;
