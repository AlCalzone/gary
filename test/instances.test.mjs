// Several instances under one root: resolution, setup, pause, doctor, the board server and the MCP server.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BOT_TOKEN } from "./fixtures/github.mjs";
import { GARY, PROFILE, ROOT, freePort, removeDir, runner, tempDir, testEnv } from "./lib.mjs";

const t = runner("instances");
const T = tempDir();
const root = join(T, "root");
const env = testEnv({ GARY_HOME: root });
const gitEnv = { ...env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const gary = (args, { cwd = T, extra = {}, input } = {}) => spawnSync(process.execPath, [GARY, ...args], { cwd, env: { ...env, ...extra }, input, encoding: "utf8" });
const token = join(T, "bot-token");
writeFileSync(token, BOT_TOKEN + "\n", { mode: 0o600 });

// Two profiles, two checkouts, a worktree and a plain clone
const gadgets = join(T, "profile-gadgets");
cpSync(PROFILE, gadgets, { recursive: true });
writeFileSync(join(gadgets, "profile.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8")), name: "gadgets", repo: "acme/Gadgets" }));
const widgetsCheckout = join(T, "widgets");
mkdirSync(join(widgetsCheckout, "src"), { recursive: true });
git(widgetsCheckout, "init", "-q");
writeFileSync(join(widgetsCheckout, "README"), "x");
git(widgetsCheckout, "add", "-A");
git(widgetsCheckout, "commit", "-q", "-m", "init");
git(widgetsCheckout, "remote", "add", "origin", "https://github.com/acme/widgets.git");
const worktree = join(T, "widgets-wt");
git(widgetsCheckout, "worktree", "add", "-q", "-b", "fix", worktree);
const gadgetsClone = join(T, "elsewhere", "gadgets-clone");
mkdirSync(gadgetsClone, { recursive: true });
git(gadgetsClone, "init", "-q");
git(gadgetsClone, "remote", "add", "origin", "git@github.com:ACME/gadgets.git");
const plain = join(T, "plain");
mkdirSync(plain);

const portA = await freePort();

// The layout from before instances, moved by setup only
mkdirSync(join(root, "state", "board", "items"), { recursive: true });
writeFileSync(join(root, "config.json"), JSON.stringify({ profile: PROFILE, me: "octocat", checkout: widgetsCheckout, bot: { login: "widgets-bot", tokenFile: token }, port: portA }));
writeFileSync(join(root, "state", "board", "items", "issue-21.json"), "{}");
writeFileSync(join(root, "personal.md"), "# shared\n");
let r = gary(["paths"]);
t.check("other commands print the one-line migration hint", r.status === 2 && /layout from before instances. Run `gary setup` once/.test(r.stdout + r.stderr), r.stdout + r.stderr);
r = gary(["setup", "--profile", gadgets, "--me", "octocat", "--bot-login", "widgets-bot", "--bot-token-file", token, "--no-links"]);
t.check("setup moves the old layout into instances/widgets", r.status === 0 && /Moved the old layout into instance widgets\./.test(r.stderr) && existsSync(join(root, "instances", "widgets", "state", "board", "items", "issue-21.json")) && !("profile" in JSON.parse(readFileSync(join(root, "config.json"), "utf8"))), r.stdout + r.stderr);
t.check("setup names the new instance after the repo in lower case", /Created instance gadgets\./.test(r.stderr) && existsSync(join(root, "instances", "gadgets", "config.json")), r.stderr);
t.check("the shared personal.md stays in the root", readFileSync(join(root, "personal.md"), "utf8") === "# shared\n");
const rootCfg = () => JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const instCfg = (name) => JSON.parse(readFileSync(join(root, "instances", name, "config.json"), "utf8"));
t.check("the old instance's port moves to the root config", rootCfg().port === portA && !("port" in instCfg("widgets")) && instCfg("widgets").kind === "maintainer", { root: rootCfg(), widgets: instCfg("widgets") });
t.check("a new instance gets kind and no port", instCfg("gadgets").kind === "maintainer" && !("port" in instCfg("gadgets")), instCfg("gadgets"));

// Setup refusals and the free port
r = gary(["setup", "--profile", PROFILE, "--me", "octocat", "--no-bot", "--no-links", "--instance", "other"]);
t.check("setup refuses a second instance for the same repo", r.status === 1 && /Instance widgets already triages acme\/widgets/.test(r.stderr), r.stderr);
const third = join(T, "profile-third");
cpSync(PROFILE, third, { recursive: true });
writeFileSync(join(third, "profile.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8")), name: "third", repo: "acme/third" }));
r = gary(["setup", "--profile", third, "--me", "octocat", "--no-bot", "--no-links", "--checkout", widgetsCheckout]);
t.check("setup refuses a checkout another instance uses", r.status === 1 && /already uses the checkout/.test(r.stderr), r.stderr);
r = gary(["setup", "--profile", third, "--me", "octocat", "--no-bot", "--no-links", "--instance", "Bad_Name"]);
t.check("setup refuses a bad instance name", r.status === 1 && /not a valid instance name/.test(r.stderr), r.stderr);
r = gary(["setup", "--profile", gadgets, "--me", "octocat", "--no-bot", "--no-links"]);
t.check("setup refuses an existing instance without --force", r.status === 1 && /Instance gadgets already exists/.test(r.stderr), r.stderr);
r = gary(["--instance", "third", "setup", "--profile", third, "--me", "octocat", "--no-bot", "--no-links"]);
t.check("setup adds a third instance without touching the root port", r.status === 0 && rootCfg().port === portA && !("port" in instCfg("third")), { root: rootCfg(), err: r.stderr });

// Resolution order
const which = (args, opts) => {
	const res = gary([...args, "paths"], opts);
	try {
		return JSON.parse(res.stdout).instance ?? res.stdout + res.stderr;
	} catch {
		return res.stdout + res.stderr;
	}
};
t.check("inside a checkout", which([], { cwd: join(widgetsCheckout, "src") }) === "widgets");
t.check("inside a worktree of the checkout", which([], { cwd: worktree }) === "widgets");
t.check("a clone whose origin is the repo, ssh form, other case", which([], { cwd: gadgetsClone }) === "gadgets");
t.check("GARY_INSTANCE wins over the directory", which([], { cwd: widgetsCheckout, extra: { GARY_INSTANCE: "gadgets" } }) === "gadgets");
t.check("--instance before the command wins over GARY_INSTANCE", which(["--instance", "third"], { cwd: widgetsCheckout, extra: { GARY_INSTANCE: "gadgets" } }) === "third");
r = gary(["paths", "--instance=gadgets"], { cwd: widgetsCheckout });
t.check("--instance after the command", JSON.parse(r.stdout).instance === "gadgets", r.stdout);
r = gary(["paths"], { cwd: plain });
t.check("no match with several instances fails with the list and the hint", r.status === 2 && /belongs to no instance/.test(r.stdout) && /gadgets \(acme\/Gadgets\)/.test(r.stdout) && /Pass --instance <name>/.test(r.stdout), r.stdout);
r = gary(["--instance", "nope", "paths"], { cwd: plain });
t.check("an unknown --instance fails with the list", r.status === 2 && /no instance "nope".*Instances: gadgets/.test(JSON.parse(r.stdout).error), r.stdout);
// Two instances that both match: the third points its checkout at the gadgets clone, whose origin is gadgets
const thirdCfg = join(root, "instances", "third", "config.json");
writeFileSync(thirdCfg, JSON.stringify({ ...JSON.parse(readFileSync(thirdCfg, "utf8")), checkout: gadgetsClone }));
r = gary(["paths"], { cwd: gadgetsClone });
t.check("two matches fail the same way", r.status === 2 && /matches several instances: gadgets, third/.test(r.stdout), r.stdout);
removeDir(join(root, "instances", "third"));

// paths shape
const p = JSON.parse(gary(["paths"], { cwd: widgetsCheckout }).stdout);
t.check("paths has every key in order", JSON.stringify(Object.keys(p)) === JSON.stringify(["instance", "root", "home", "config", "personal", "profile", "state", "checkout", "core"]), Object.keys(p));
t.check("paths: home is the instance directory, personal starts with the shared file", p.home === join(root, "instances", "widgets") && p.personal[0] === join(root, "personal.md") && p.personal.length === 1 && p.state === join(p.home, "state"), p);
writeFileSync(join(root, "instances", "widgets", "personal.md"), "# widgets only\n");
t.check("an instance personal.md comes after the shared one", JSON.stringify(JSON.parse(gary(["paths"], { cwd: widgetsCheckout }).stdout).personal) === JSON.stringify([join(root, "personal.md"), join(root, "instances", "widgets", "personal.md")]));

// Pause one, --all, announcements
r = gary(["pause"], { cwd: widgetsCheckout });
t.check("pause names the instance first on stderr", r.status === 0 && r.stderr.split("\n")[0] === "Paused widgets.", r.stderr);
const paused = (name) => JSON.parse(readFileSync(join(root, "instances", name, "state", "control.json"), "utf8")).paused;
t.check("pausing one instance leaves the other running", paused("widgets") === true && !existsSync(join(root, "instances", "gadgets", "state", "control.json")));
r = gary(["action", "--dry-run"], { cwd: gadgetsClone, input: '{"action":"comment","kind":"pr","number":12,"text":"x"}' });
t.check("the other instance still acts", r.status === 0 && r.stderr.split("\n")[0] === "Instance gadgets.", r.stderr + r.stdout);
r = gary(["action", "--dry-run"], { cwd: widgetsCheckout, input: '{"action":"comment","kind":"pr","number":12,"text":"x"}' });
t.check("the paused one refuses", r.status === 1 && /Gary is paused/.test(r.stdout), r.stdout);
r = gary(["resume", "--all"], { cwd: plain });
t.check("resume --all names every instance", r.status === 0 && /Resumed gadgets\./.test(r.stderr) && /Resumed widgets\./.test(r.stderr) && paused("widgets") === false, r.stderr);
r = gary(["pause", "--all"], { cwd: plain });
t.check("pause --all pauses both", paused("widgets") && paused("gadgets"), r.stderr);
gary(["resume", "--all"], { cwd: plain });

mkdirSync(join(root, "instances", "gadgets", "state", "board", "actions"), { recursive: true });
writeFileSync(join(root, "instances", "gadgets", "state", "board", "actions", "issue-22-1.json"), JSON.stringify({ itemId: "issue-22", action: "full_review", status: "queued", createdAt: "2026-11-18T08:00:00Z" }));
r = gary(["--instance", "gadgets", "watch-queue", "--once"], { cwd: plain });
t.check("gary --instance <name> watch-queue reads that instance's queue", r.status === 0 && /"itemId":"issue-22"/.test(r.stdout), r.stdout + r.stderr);
r = gary(["--instance", "widgets", "watch-queue", "--once"], { cwd: plain });
t.check("the other instance's queue stays apart", r.status === 0 && !/issue-22/.test(r.stdout), r.stdout);

// watch-queue --all and paths --root from any directory
r = gary(["watch-queue", "--all", "--once"], { cwd: plain });
const lines = r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
t.check("watch-queue --all prints the requests of every instance with the instance", r.status === 0 && lines.length === 1 && lines[0].instance === "gadgets" && lines[0].itemId === "issue-22" && lines[0].id === "issue-22-1", lines);
gary(["pause"], { cwd: gadgetsClone });
r = gary(["watch-queue", "--all", "--once"], { cwd: plain });
t.check("watch-queue --all skips a paused instance", r.status === 0 && r.stdout.trim() === "", r.stdout);
gary(["resume"], { cwd: gadgetsClone });
r = gary(["paths", "--root"], { cwd: plain });
t.check("paths --root works without an instance", r.status === 0 && JSON.parse(r.stdout).root === root && JSON.parse(r.stdout).core === ROOT, r.stdout + r.stderr);
r = gary(["paths"], { cwd: plain });
t.check("paths without an instance still names core and root", r.status === 2 && JSON.parse(r.stdout).core === ROOT && JSON.parse(r.stdout).root === root, r.stdout);

// A stand-in for the one board server in its own process, so these checks do not depend on server.mjs.
// It must not run in this process, because spawnSync blocks this event loop
const fake = spawn(process.execPath, ["-e", `require("node:http").createServer((q, s) => { s.writeHead(200, { "Content-Type": "application/json" }); s.end(JSON.stringify(q.url === "/api/health" ? { ok: true, name: "gary", instances: ["widgets"] } : {})); }).listen(${portA}, "127.0.0.1", () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => fake.stdout.once("data", resolve));
try {
	r = gary(["instances", "--json"], { cwd: worktree });
	const rows = JSON.parse(r.stdout);
	t.check("gary instances --json lists name, kind, repos, checkout and paused", rows.length === 2 && rows.every((x) => x.kind === "maintainer" && Array.isArray(x.repos) && "checkout" in x && typeof x.paused === "boolean"), rows);
	t.check("gary instances says which ones the board serves", rows.find((x) => x.name === "widgets").served === true && rows.find((x) => x.name === "gadgets").served === false, rows);
	t.check("gary instances marks the current one", rows.find((x) => x.current)?.name === "widgets", rows);
	r = gary(["instances"], { cwd: worktree });
	t.check("the plain list marks it with a star", /^\* widgets/m.test(r.stdout) && /^ {2}gadgets/m.test(r.stdout) && new RegExp(`port ${portA}: up`).test(r.stdout), r.stdout);

	r = gary(["doctor"], { cwd: widgetsCheckout });
	t.check("doctor sees that the board serves the resolved instance", /instance\s+widgets, from the working directory/.test(r.stdout) && /it serves this instance/.test(r.stdout), r.stdout);
	r = gary(["doctor"], { cwd: gadgetsClone });
	t.check("doctor warns when the board does not list the instance", /does not list this instance yet/.test(r.stdout), r.stdout);
	r = gary(["doctor", "--all"], { cwd: plain });
	t.check("doctor --all checks every instance", /== gadgets/.test(r.stdout) && /== widgets/.test(r.stdout), r.stdout);
	r = gary(["doctor"], { cwd: plain });
	t.check("doctor from an unknown directory fails clearly", r.status === 1 && /belongs to no instance/.test(r.stdout), r.stdout);

	// MCP server: resolves once from its working directory
	const mcp = (cwd) => new Promise((resolve) => {
		const child = spawn(process.execPath, [join(ROOT, "mcp-server/index.mjs")], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
		send({ jsonrpc: "2.0", method: "notifications/initialized" });
		send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "board_status", arguments: {} } });
		send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "comment", arguments: { kind: "pr", number: 12, text: "x" } } });
		send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "board_start", arguments: {} } });
		setTimeout(() => {
			child.kill();
			const byId = Object.fromEntries(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((m) => [m.id, m.result]));
			resolve(byId);
		}, 2500);
	});
	let m = await mcp(worktree);
	const status = JSON.parse(m[2].content[0].text);
	t.check("MCP board_status lists the served instances and the session's instance", status.portAnswers === true && JSON.stringify(status.instances) === '["widgets"]' && status.sessionInstance === "widgets", status);
	const started = JSON.parse(m[4].content[0].text);
	t.check("MCP board_start finds the running board", started.running === true && started.owner === false && JSON.stringify(started.instances) === '["widgets"]', started);
	m = await mcp(plain);
	const plainStatus = JSON.parse(m[2].content[0].text);
	t.check("MCP board tools work from any directory", !m[2].isError && plainStatus.portAnswers === true && plainStatus.sessionInstance === null && /belongs to no instance/.test(plainStatus.sessionInstanceError), plainStatus);
	t.check("MCP action tools fail clearly without an instance", m[3].isError && /belongs to no instance/.test(m[3].content[0].text), m[3]);

	// Settings problems: an unknown field only warns at run time but fails doctor, an invalid profile is an error
	const gfile = join(gadgets, "profile.json");
	const gprofile = readFileSync(gfile, "utf8");
	writeFileSync(gfile, JSON.stringify({ ...JSON.parse(gprofile), futureField: 1 }));
	r = gary(["instances", "--json"], { cwd: plain });
	let row = JSON.parse(r.stdout).find((x) => x.name === "gadgets");
	t.check("gary instances lists an unknown field as a warning", row.valid === true && !row.settingsError && /unknown field "futureField"/.test(row.settingsWarnings?.[0]), row);
	r = gary(["doctor", "--instance", "gadgets"], { cwd: plain });
	t.check("doctor fails on an unknown field", r.status === 1 && /fail\s+profile\s+unknown fields: .*futureField/.test(r.stdout), r.stdout);
	writeFileSync(gfile, JSON.stringify({ ...JSON.parse(gprofile), automatedComments: [{ name: "x", pattern: "(" }] }));
	r = gary(["instances", "--json"], { cwd: plain });
	row = JSON.parse(r.stdout).find((x) => x.name === "gadgets");
	t.check("gary instances lists an invalid instance with its error", r.status === 0 && row.valid === false && row.repos.length === 0 && /not a valid regular expression/.test(row.settingsError), row);
	r = gary(["instances"], { cwd: plain });
	t.check("the plain list shows the error", /gadgets\s+invalid/.test(r.stdout) && /error: Profile .* is invalid/.test(r.stdout), r.stdout);
	r = gary(["doctor", "--instance", "gadgets"], { cwd: plain });
	t.check("doctor fails on an invalid profile", r.status === 1 && /fail\s+profile\s+Profile .* is invalid/.test(r.stdout), r.stdout);
	writeFileSync(gfile, gprofile);
	r = gary(["doctor", "--instance", "gadgets"], { cwd: plain });
	t.check("doctor shows the fast tier", /ok\s+fast tier\s+off/.test(r.stdout), r.stdout);
	t.check("doctor says a format check is configured", /ok\s+format check\s+on: 2 autofix commands after the setup `ln -s \{checkout\}\/node_modules node_modules`/.test(r.stdout), r.stdout);
	writeFileSync(gfile, JSON.stringify({ ...JSON.parse(gprofile), autofixCommands: [], autofixSetup: null }));
	r = gary(["doctor", "--instance", "gadgets"], { cwd: plain });
	t.check("doctor says when there is no format check", /ok\s+format check\s+off: the profile names no autofixCommands/.test(r.stdout), r.stdout);
	writeFileSync(gfile, gprofile);

	// What a first run needs
	r = gary(["doctor", "--instance", "gadgets"], { cwd: plain });
	t.check("doctor says the bot may push", /^ok\s+push access\s+widgets-bot may push to acme\/Gadgets$/m.test(r.stdout), r.stdout);
	t.check("doctor checks git and the MCP SDK", /^ok\s+git\s+git version/m.test(r.stdout) && /^ok\s+mcp sdk\s+@modelcontextprotocol\/sdk loads/m.test(r.stdout), r.stdout);
	t.check("doctor checks claude", /^(ok|warn)\s+claude\s/m.test(r.stdout), r.stdout);
	t.check("doctor prints no required tools as none", /^ok\s+required tools\s+none$/m.test(r.stdout), r.stdout);
	r = gary(["doctor", "--instance", "gadgets"], { cwd: plain, extra: { FAKE_GH_REPO_ACCESS: "read" } });
	t.check("doctor warns when the bot may not push", /^warn\s+push access\s+widgets-bot may not push to acme\/Gadgets\./m.test(r.stdout), r.stdout);
	r = gary(["doctor", "--instance", "gadgets"], { cwd: plain, extra: { FAKE_GH_REPO_ACCESS: "none" } });
	t.check("doctor warns when the repo cannot be read", /^warn\s+push access\s+could not read acme\/Gadgets as widgets-bot/m.test(r.stdout), r.stdout);
	const gconfig = join(root, "instances", "gadgets", "config.json");
	const gconfigText = readFileSync(gconfig, "utf8");
	writeFileSync(gconfig, JSON.stringify({ ...JSON.parse(gconfigText), bot: null, allowOwnTokenPushes: true }));
	r = gary(["doctor", "--instance", "gadgets"], { cwd: plain });
	t.check("doctor checks the maintainer's own login with allowOwnTokenPushes", /^ok\s+push access\s+octocat may push to acme\/Gadgets$/m.test(r.stdout), r.stdout);
	writeFileSync(gconfig, JSON.stringify({ ...JSON.parse(gconfigText), bot: null, allowOwnTokenPushes: false }));
	r = gary(["doctor", "--instance", "gadgets"], { cwd: plain });
	t.check("doctor reads no repo when no account writes", /^ok\s+push access\s+not checked: no account writes/m.test(r.stdout), r.stdout);
	writeFileSync(gconfig, gconfigText);
	writeFileSync(gfile, JSON.stringify({ ...JSON.parse(gprofile), requiredTools: ["mcp__logs__loadLogFile"] }));
	r = gary(["doctor", "--instance", "gadgets"], { cwd: plain });
	t.check("doctor names the required tools and says it cannot check them", /^skip\s+required tools\s+mcp__logs__loadLogFile\. Not checked: doctor cannot see MCP tools/m.test(r.stdout), r.stdout);
	writeFileSync(gfile, gprofile);
	const noClaude = env.PATH.split(delimiter).filter((d) => !existsSync(join(d, "claude"))).join(delimiter);
	r = gary(["doctor", "--instance", "gadgets"], { cwd: plain, extra: { PATH: noClaude } });
	t.check("doctor only warns without claude, and says the headless worker needs it", /^warn\s+claude\s+.*headless worker with `claude -p`/m.test(r.stdout) && !/^fail\s+claude/m.test(r.stdout), r.stdout);
	r = spawnSync(process.execPath, ["--import", 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"22.11.0"})', GARY, "help"], { env, encoding: "utf8" });
	t.check("gary refuses Node below 24 with one line", r.status === 1 && r.stderr.trim() === "gary needs Node 24 or later. This is Node 22.11.0." && r.stdout === "", r);
} finally {
	fake.kill();
}
await sleep(300);
removeDir(T);
t.done();
