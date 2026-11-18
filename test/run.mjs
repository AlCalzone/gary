// Runs the test suites one after the other and exits with 1 when one fails.
//   node test/run.mjs          the suites without a browser
//   node test/run.mjs --page   the page suites, which need Chrome or Chromium
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { TEST_DIR } from "./lib.mjs";

const SUITES = [
	["node", "actions.test.mjs"],
	["node", "server.test.mjs"],
	["node", "accounts.test.mjs"],
	["node", "learning.test.mjs"],
	["zsh", "sharing.test.zsh"],
	["zsh", "validate.test.zsh"],
];
const PAGE_SUITES = [
	["node", "page/run-mock.mjs"],
	["node", "page/served.mjs"],
	["node", "page/served-nobot.mjs"],
	["node", "page/served-nobot.mjs", "own"],
];

const list = process.argv.includes("--page") ? PAGE_SUITES : SUITES;
let failed = 0;
for (const [bin, file, ...args] of list) {
	const r = spawnSync(bin === "node" ? process.execPath : bin, [join(TEST_DIR, file), ...args], { stdio: "inherit" });
	if (r.error) console.log(`${file}: could not start ${bin}: ${r.error.message}`);
	if (r.status !== 0) failed++;
}
console.log(failed ? `${failed} of ${list.length} suites failed` : `all ${list.length} suites passed`);
process.exitCode = failed ? 1 : 0;
