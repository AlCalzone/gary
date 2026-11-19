// The mocked page suite: board/board.html with a fake window.claude, run in headless Chrome.
// Needs Chrome or Chromium. CHROME names the binary, default google-chrome.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, TEST_DIR, removeDir, tempDir } from "../lib.mjs";

const PAGE = join(TEST_DIR, "page");
const dir = tempDir();
const parts = ["mock.js", process.env.BOARD_HTML ?? join(ROOT, "board", "board.html"), "fixtures.js", "tests-head.js", "tests-badges.js", "routes-tests.js", "tests-tabs.js", "tests-round4.js", "tests-round8.js", "tests-round9.js", "tests-round10.js", "tests-round11.js", "tests-dialog.js"];
const html = parts.map((p) => readFileSync(p.startsWith("/") ? p : join(PAGE, p), "utf8")).join("\n");
const harness = join(dir, "harness.html");
writeFileSync(harness, html);

const chrome = process.env.CHROME ?? "google-chrome";
// External hosts fail at once, so pending avatar and font requests cannot hold up virtual time
const r = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", "--host-resolver-rules=MAP * ~NOTFOUND", `--user-data-dir=${join(dir, "profile")}`, "--virtual-time-budget=30000", "--dump-dom", `file://${harness}`], { encoding: "utf8", timeout: 90000 });
removeDir(dir);
const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(r.stdout ?? "");
if (!m) {
	console.log(`page (mocked): no result. Is ${chrome} installed? ${r.error?.message ?? r.stderr?.slice(0, 300) ?? ""}`);
	process.exit(1);
}
const text = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const lines = text.split("\n");
const pass = lines.filter((l) => l.startsWith("PASS")).length;
const fail = lines.filter((l) => l.startsWith("FAIL")).length;
for (const l of lines) if (l && !l.startsWith("PASS")) console.log(l.slice(0, 240));
console.log(`page (mocked): ${pass} passed, ${fail} failed`);
process.exitCode = fail || !pass ? 1 : 0;
