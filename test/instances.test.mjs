// Several instances under one root: resolution, setup, pause, doctor, the board server and the MCP server.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const portB = await freePort();

// The layout from before instances, moved by setup only
mkdirSync(join(root, "state", "board", "items"), { recursive: true });
writeFileSync(join(root, "config.json"), JSON.stringify({ profile: PROFILE, me: "octocat", checkout: widgetsCheckout, bot: { login: "widgets-bot", tokenFile: token }, port: portA }));
writeFileSync(join(root, "state", "board", "items", "issue-21.json"), "{}");
writeFileSync(join(root, "personal.md"), "# shared\n");
let r = gary(["paths"]);
t.check("other commands print the one-line migration hint", r.status === 2 && /layout from before instances. Run `gary setup` once/.test(r.stdout + r.stderr), r.stdout + r.stderr);
r = gary(["setup", "--profile", gadgets, "--me", "octocat", "--bot-login", "widgets-bot", "--bot-token-file", token, "--no-links", "--port", String(portB)]);
t.check("setup moves the old layout into instances/widgets", r.status === 0 && /Moved the old layout into instance widgets\./.test(r.stderr) && existsSync(join(root, "instances", "widgets", "state", "board", "items", "issue-21.json")) && !existsSync(join(root, "config.json")), r.stdout + r.stderr);
t.check("setup names the new instance after the repo in lower case", /Created instance gadgets\./.test(r.stderr) && existsSync(join(root, "instances", "gadgets", "config.json")), r.stderr);
t.check("the shared personal.md stays in the root", readFileSync(join(root, "personal.md"), "utf8") === "# shared\n");

// Setup refusals and the free port
r = gary(["setup", "--profile", PROFILE, "--me", "octocat", "--no-bot", "--no-links", "--instance", "other"]);
t.check("setup refuses a second instance for the same repo", r.status === 1 && /Instance widgets already triages acme\/widgets/.test(r.stderr), r.stderr);
const third = join(T, "profile-third");
cpSync(PROFILE, third, { recursive: true });
writeFileSync(join(third, "profile.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8")), name: "third", repo: "acme/third" }));
r = gary(["setup", "--profile", third, "--me", "octocat", "--no-bot", "--no-links", "--checkout", widgetsCheckout]);
t.check("setup refuses a checkout another instance uses", r.status === 1 && /already uses the checkout/.test(r.stderr), r.stderr);
r = gary(["setup", "--profile", third, "--me", "octocat", "--no-bot", "--no-links", "--port", String(portA)]);
t.check("setup refuses a port another instance uses", r.status === 1 && new RegExp(`already uses port ${portA}`).test(r.stderr), r.stderr);
r = gary(["setup", "--profile", third, "--me", "octocat", "--no-bot", "--no-links", "--instance", "Bad_Name"]);
t.check("setup refuses a bad instance name", r.status === 1 && /not a valid instance name/.test(r.stderr), r.stderr);
r = gary(["setup", "--profile", gadgets, "--me", "octocat", "--no-bot", "--no-links"]);
t.check("setup refuses an existing instance without --force", r.status === 1 && /Instance gadgets already exists/.test(r.stderr), r.stderr);
r = gary(["--instance", "third", "setup", "--profile", third, "--me", "octocat", "--no-bot", "--no-links"]);
const thirdPort = JSON.parse(readFileSync(join(root, "instances", "third", "config.json"), "utf8")).port;
t.check("setup picks the next free port from 7878", r.status === 0 && thirdPort >= 7878 && thirdPort !== portA && thirdPort !== portB, { thirdPort, err: r.stderr });

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

// Two board servers side by side
const servers = [];
const start = (name) => {
	const child = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--instance", name], { cwd: plain, env, stdio: ["ignore", "ignore", "pipe"] });
	let err = "";
	child.stderr.on("data", (d) => (err += d));
	servers.push(child);
	return async () => {
		for (let i = 0; i < 50 && !err.includes("Board of"); i++) await sleep(100);
		return err;
	};
};
const readyA = start("widgets");
const readyB = start("gadgets");
const [logA, logB] = [await readyA(), await readyB()];
try {
	t.check("each server names its instance", /Board of widgets on/.test(logA) && /Board of gadgets on/.test(logB), { logA, logB });
	const health = async (port) => (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json());
	t.check("/api/health carries the instance", (await health(portA)).instance === "widgets" && (await health(portB)).instance === "gadgets");
	const tokenOf = (name) => readFileSync(join(root, "instances", name, "state", "server-token"), "utf8").trim();
	t.check("each instance has its own server token", tokenOf("widgets") !== tokenOf("gadgets"));
	const state = async (port, name) => (await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "X-Board-Token": tokenOf(name) } })).json());
	const sA = await state(portA, "widgets");
	const sB = await state(portB, "gadgets");
	t.check("board info carries the instance", sA.board.instance === "widgets" && sB.board.instance === "gadgets" && sB.board.repo === "acme/Gadgets", { a: sA.board, b: sB.board });
	t.check("the states stay separate", sA.items.some((i) => i.id === "issue-21") && !sB.items.some((i) => i.id === "issue-21"));
	gary(["pause"], { cwd: gadgetsClone });
	await sleep(300);
	t.check("pausing gadgets shows only on its board", (await state(portB, "gadgets")).board.paused === true && (await state(portA, "widgets")).board.paused === false);
	gary(["resume"], { cwd: gadgetsClone });

	r = gary(["instances", "--json"], { cwd: worktree });
	const rows = JSON.parse(r.stdout);
	t.check("gary instances lists both with port and server", rows.length === 2 && rows.every((x) => x.serverAnswers) && rows.find((x) => x.name === "widgets").port === portA, rows);
	t.check("gary instances marks the current one", rows.find((x) => x.current)?.name === "widgets", rows);
	r = gary(["instances"], { cwd: worktree });
	t.check("the plain list marks it with a star", /^\* widgets/m.test(r.stdout) && /^ {2}gadgets/m.test(r.stdout), r.stdout);

	r = gary(["doctor"], { cwd: widgetsCheckout });
	t.check("doctor checks the resolved instance and its own board", /instance\s+widgets, from the working directory/.test(r.stdout) && /runs this instance's board server/.test(r.stdout), r.stdout);
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
	t.check("MCP board_status names the instance from the directory", status.instance === "widgets" && status.portAnswers === true, status);
	const started = JSON.parse(m[4].content[0].text);
	t.check("MCP board_start finds that instance's running board", started.running === true && started.owner === false && started.instance === "widgets", started);
	m = await mcp(plain);
	t.check("MCP tools fail clearly without an instance", m[2].isError && /belongs to no instance/.test(m[2].content[0].text) && m[3].isError && /belongs to no instance/.test(m[3].content[0].text), m);
} finally {
	for (const s of servers) s.kill("SIGTERM");
}
await sleep(300);
removeDir(T);
t.done();
