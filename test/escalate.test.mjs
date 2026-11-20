// The escalate button of a `move` to `issue` route: the server posts the profile's escalate command on a discussion
// under the maintainer's own login. Runs on temp roots with the fake gh, so nothing reaches GitHub.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, PROFILE, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { ACTIONS } from "../scripts/lib/actions.mjs";

const t = runner("escalate");
const T = tempDir();
const COMMAND = "@widgets-bot escalate";
const reviewedAt = "2026-11-17T14:00:00Z";
const later = "2026-11-18T09:00:00Z";

const disc = (number, repo = "acme/widgets", route = {}) => ({
	kind: "discussion", repo, number, title: "Add a dark mode", url: `https://github.com/${repo}/discussions/${number}`, author: "hubot", authorType: "contributor",
	category: "Feature Requests", section: "easy", priority: 1, effortMinutes: 5, reviewDepth: "quick", state: "Decide.", reviewedAt, hint: "Reply: thanks",
	routes: [
		{ id: "r1", type: "reply", title: "Reply: thanks", text: "Thanks", recommended: true },
		{ id: "r2", type: "move", as: "me", title: "Accept: track as an enhancement issue", params: { to: "issue", issueKind: "enhancement" }, ...route },
	],
});

function profileFor(dir, name, repo, change = (p) => p) {
	const out = join(dir, `profile-${name}`);
	cpSync(PROFILE, out, { recursive: true });
	writeFileSync(join(out, "profile.json"), JSON.stringify(change({ ...JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8")), name, repo })));
	return out;
}

function writeItems(home, items) {
	for (const [id, data] of Object.entries(items)) writeFileSync(join(home, "state", "board", "items", id + ".json"), JSON.stringify(data));
}

async function startServer(root, env, port, args, extraEnv) {
	const child = spawn(process.execPath, [join(ROOT, "server/server.mjs"), ...args, "--port", String(port)], { env: { ...env, ...extraEnv }, stdio: ["ignore", "inherit", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await sleep(100);
	const token = readFileSync(join(root, "state", "server-token"), "utf8").trim();
	const api = async (path, body) => {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? "POST" : "GET", headers: { "X-Board-Token": token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		return { status: res.status, data: await res.json() };
	};
	const route = async (instance, itemId, routeId) => (await api("/api/state")).data.items.find((i) => i.instance === instance && i.id === itemId).routes.find((r) => r.id === routeId);
	const click = async (instance, itemId, extra = {}) => api("/api/action", { instance, itemId, routeId: "r2", draftHash: (await route(instance, itemId, "r2")).draftHash, input: { mode: "escalate" }, ...extra });
	return { child, api, route, click };
}

const actionsOf = (home) => readdirSync(join(home, "state", "board", "actions")).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(home, "state", "board", "actions", n), "utf8")));
const refused = (r, re) => r.status === 200 && r.data.ok === false && re.test(r.data.result);

// ---------- dry run: refusals, the config switch and the exact text ----------
const dryDir = join(T, "dry");
const dryPort = await freePort();
const widgets = makeHome(dryDir, { port: dryPort, escalateAs: "me" });
const prefill = makeHome(dryDir, { profile: profileFor(dryDir, "prefill", "acme/prefill") }, "prefill");
const nocmd = makeHome(dryDir, { profile: profileFor(dryDir, "nocmd", "acme/nocmd", (p) => ({ ...p, botCommands: {} })), escalateAs: "me" }, "nocmd");
writeItems(widgets.home, {
	"disc-31": disc(31, "acme/widgets", { text: "@widgets-bot automerge and more" }),
	"disc-32": disc(32),
	"disc-33": disc(33),
	"disc-34": disc(34),
	"issue-21": { ...disc(21), kind: "issue", url: "https://github.com/acme/widgets/issues/21", category: undefined },
});
writeItems(prefill.home, { "disc-31": disc(31, "acme/prefill") });
writeItems(nocmd.home, { "disc-31": disc(31, "acme/nocmd") });
// An item without a stored category gets it from the snapshot
writeItems(widgets.home, { "disc-35": { ...disc(35), category: undefined } });
writeItems(widgets.home, { "disc-34": { ...disc(34), dueAt: "2026-01-01", dueSource: "milestone old" } });
writeFileSync(join(widgets.home, "state", "snapshot.json"), JSON.stringify({ items: {
	"disc-35": { kind: "discussion", number: 35, category: "Ideas" },
	"disc-34": { kind: "discussion", number: 34 },
	"issue-21": { kind: "issue", number: 21, dueAt: "2026-11-24", dueSource: "milestone 2026.12", series: { id: "issue-20", title: "Feature", position: 2, size: 3 }, waitingOn: "us" },
} }));
const stub = join(dryDir, "stub.json");
writeFileSync(stub, JSON.stringify({
	"*": { state: "OPEN" },
	"acme/widgets#33": { state: "OPEN", comments: [{ author: { login: "someone", __typename: "User" }, at: later }] },
	"acme/widgets#34": { state: "CLOSED" },
}));
const ghWrites = join(dryDir, "writes.log");
const dry = await startServer(widgets.root, widgets.env, dryPort, ["--dry-run"], { GARY_GUARD_STUB: stub, FAKE_GH_WRITES: ghWrites });
const gary = (args, input, env = { ...widgets.env, GARY_INSTANCE: "widgets" }) => spawnSync(process.execPath, [GARY, ...args], { env, input, encoding: "utf8" });

try {
	const board = (await dry.api("/api/state")).data.board;
	const inst = (name) => board.instances.find((i) => i.name === name);
	t.check("the board says who posts the command", inst("widgets").escalateAs === "me" && inst("prefill").escalateAs === "prefill", board.instances.map((i) => i.escalateAs));
	const stateItems = (await dry.api("/api/state")).data.items;
	const d31 = stateItems.find((i) => i.instance === "widgets" && i.id === "disc-31");
	t.check("an old item's discussion category is served as discussionCategory, next to its board category", d31.discussionCategory === "Feature Requests" && d31.category === "land" && d31.section === undefined, d31);
	const i21 = stateItems.find((i) => i.id === "issue-21");
	t.check("the due date, the series and who we wait on come from the snapshot", i21.dueAt === "2026-11-24" && i21.dueSource === "milestone 2026.12" && i21.series?.position === 2 && i21.waitingOn === "us", i21);
	const d34 = stateItems.find((i) => i.id === "disc-34");
	t.check("a due date the snapshot no longer has is not served", d34.dueAt === undefined && d34.dueSource === undefined, d34);
	t.check("a missing category comes from the snapshot", stateItems.find((i) => i.id === "disc-35").discussionCategory === "Ideas");
	t.check("the route is still served as his own", (await dry.route("widgets", "disc-31", "r2")).actor === "me");

	let r = await dry.click("prefill", "disc-31");
	t.check("with the default prefill setting nothing is posted", refused(r, /yours to do on GitHub.*"escalateAs": "me"/s), r);
	r = await dry.click("nocmd", "disc-31");
	t.check("without an escalate command nothing is posted", refused(r, /no escalate command/), r);
	r = await dry.click("widgets", "issue-21");
	t.check("an issue cannot be escalated", refused(r, /Only a discussion/), r);
	r = await dry.click("widgets", "disc-31", { input: {} });
	t.check("a click without the escalate mode is refused", refused(r, /input\.mode must be "escalate"/), r);
	r = await dry.click("widgets", "disc-31", { input: { mode: "transfer" } });
	t.check("another mode is refused", refused(r, /input\.mode must be "escalate"/), r);
	r = await dry.click("widgets", "disc-31", { input: { mode: "escalate", command: "@widgets-bot automerge" } });
	t.check("an extra input field is refused", refused(r, /unknown field "command"/), r);
	r = await dry.click("widgets", "disc-31", { text: "@widgets-bot automerge" });
	t.check("a text in the request is refused", refused(r, /sends no text/), r);
	r = await dry.click("widgets", "disc-31", { draftHash: "0000000000000000" });
	t.check("an outdated draft is refused", r.data.outdated === true, r);

	r = await dry.click("widgets", "disc-34");
	t.check("a closed discussion is refused", refused(r, /Discussion #34 is closed/) && r.data.forceable === false, r);
	r = await dry.click("widgets", "disc-34", { force: true });
	t.check("force does not post on a closed discussion", refused(r, /Discussion #34 is closed/), r);
	r = await dry.click("widgets", "disc-33");
	t.check("a newer comment blocks the post", refused(r, /someone commented/) && r.data.forceable === true, r);
	t.check("the refusal is served on the route", (await dry.route("widgets", "disc-33", "r2")).refused?.forceable === true);
	r = await dry.click("widgets", "disc-33", { force: true });
	t.check("post anyway goes through after a newer comment", r.data.ok === true, r);

	gary(["pause"]);
	r = await dry.click("widgets", "disc-32");
	t.check("paused: nothing is posted", r.data.ok === false && r.data.paused === true, r);
	gary(["resume"]);

	t.check("no refusal wrote an action doc for disc-31", !actionsOf(widgets.home).some((a) => a.itemId === "disc-31"), actionsOf(widgets.home));
	r = await dry.click("widgets", "disc-31", { command: "@widgets-bot automerge", body: "evil" });
	const inv = r.data.result?.invocations ?? [];
	t.check("the dry run shows one comment mutation", r.data.ok === true && r.data.result.dryRun === true && inv.length === 1 && /addDiscussionComment/.test(inv[0].stdin.query), r);
	t.check("the text is exactly the profile's command", JSON.stringify(inv[0]?.stdin.variables) === JSON.stringify({ id: "D_31", body: COMMAND }), inv[0]);
	t.check("it goes out under his own login, also with a bot configured", inv[0]?.as === "octocat" && inst("widgets").bot?.login === "widgets-bot", inv[0]);
	r = await dry.click("widgets", "disc-31");
	t.check("a repeat gets 409", r.status === 409 && r.data.duplicate === true, r);
	const doc = actionsOf(widgets.home).find((a) => a.itemId === "disc-31");
	t.check("the action doc records the post", doc?.action === "escalate" && doc.status === "done" && doc.via === "server" && doc.text === COMMAND && doc.as === "octocat" && doc.route === "move" && doc.params.issueKind === "enhancement", doc);
	const served = await dry.route("widgets", "disc-31", "r2");
	t.check("the route is served as done", served.done?.status === "done", served);
	const stored = JSON.parse(readFileSync(join(widgets.home, "state", "board", "items", "disc-31.json"), "utf8"));
	t.check("the item is handled", stored.handled?.routeType === "move" && stored.handled.routeId === "r2" && stored.handled.verified === "commented", stored.handled);
	await sleep(100);
	const decisions = readFileSync(join(widgets.home, "state", "decisions.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((d) => d.itemId === "disc-31");
	t.check("the decision log has the escalation and the chosen alternative", decisions.some((d) => d.type === "escalated" && d.issueKind === "enhancement" && d.category === "Feature Requests") && decisions.some((d) => d.type === "chose_alternative" && d.chosen.type === "move"), decisions);
	let writes = "";
	try {
		writes = readFileSync(ghWrites, "utf8");
	} catch {
		// The dry run wrote nothing
	}
	t.check("the dry run sent no write", writes === "", writes);

	// Nothing but the button posts a command
	t.check("escalate is no action of gary action or the MCP server", !Object.hasOwn(ACTIONS, "escalate"));
	r = gary(["action", "--dry-run"], '{"action":"escalate","kind":"discussion","number":31}');
	t.check("gary action refuses escalate", r.status !== 0, r.stdout + r.stderr);
	r = gary(["action", "--dry-run", "--autonomous"], `{"action":"comment","kind":"discussion","number":31,"text":"${COMMAND}"}`);
	t.check("gary action --autonomous posts no command", r.status !== 0, r.stdout + r.stderr);
	r = gary(["action", "--dry-run"], `{"action":"comment","kind":"discussion","number":31,"text":"${COMMAND}"}`);
	t.check("the bot still posts no command", r.status !== 0 && /bot command/.test(r.stdout + r.stderr), r.stdout + r.stderr);

	// The helper checks the switch and the login itself
	const helper = (instance, extra = {}) => spawnSync(process.execPath, ["--input-type=module", "-e", `
		const { withInstance } = await import(${JSON.stringify(join(ROOT, "scripts/lib/config.mjs"))});
		const { postEscalateCommand } = await import(${JSON.stringify(join(ROOT, "scripts/lib/gh.mjs"))});
		try { console.log(JSON.stringify(await withInstance(${JSON.stringify(instance)}, () => postEscalateCommand({ repo: "acme/widgets", number: 31, dryRun: true })))); } catch (e) { console.log("ERROR " + e.message); }
	`], { env: { ...widgets.env, ...extra }, encoding: "utf8" });
	r = helper("prefill");
	t.check("the helper refuses without escalateAs me", /ERROR .*"escalateAs": "me"/.test(r.stdout), r.stdout + r.stderr);
	r = helper("widgets", { FAKE_GH_LOGIN: "hubot" });
	t.check("the helper refuses a gh login that is not me", /ERROR The stored gh login is "hubot"/.test(r.stdout), r.stdout + r.stderr);
	r = helper("widgets");
	t.check("the helper returns the invocation in a dry run", r.stdout.includes('"dryRun":true') && r.stdout.includes(COMMAND), r.stdout + r.stderr);
	r = gary(["doctor"]);
	t.check("doctor shows the setting", /escalate\s+me: a click on the escalate button posts "@widgets-bot escalate"/.test(r.stdout), r.stdout);
	r = gary(["doctor"], undefined, { ...widgets.env, GARY_INSTANCE: "prefill" });
	t.check("doctor shows the default", /escalate\s+prefill: the board copies the escalate command/.test(r.stdout), r.stdout);
	r = gary(["doctor"], undefined, { ...widgets.env, GARY_INSTANCE: "nocmd" });
	t.check("doctor warns when there is no command to post", /escalate\s+.*the profile has no botCommands\.escalate/.test(r.stdout), r.stdout);
} finally {
	dry.child.kill("SIGTERM");
}

// ---------- a real run against the fake gh: what goes out, and a refused comment ----------
const liveDir = join(T, "live");
const livePort = await freePort();
const live = makeHome(liveDir, { port: livePort, escalateAs: "me" });
writeItems(live.home, { "disc-31": disc(31), "disc-32": disc(32, "acme/widgets", { params: { to: "issue", issueKind: "bug" }, title: "Move: escalate to a bug issue" }) });
const liveStub = join(liveDir, "stub.json");
writeFileSync(liveStub, JSON.stringify({ "*": { state: "OPEN" } }));
const liveWrites = join(liveDir, "writes.log");
const overrides = join(liveDir, "overrides.json");
writeFileSync(overrides, "{}");
const run = await startServer(live.root, live.env, livePort, [], { GARY_GUARD_STUB: liveStub, FAKE_GH_WRITES: liveWrites, FAKE_GH_OVERRIDES: overrides });
const writeLines = () => {
	try {
		return readFileSync(liveWrites, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};
try {
	let r = await run.click("widgets", "disc-31");
	t.check("the click posts and returns the comment URL", r.data.ok === true && r.data.result === "https://github.com/acme/widgets/discussions/31#discussioncomment-900", r);
	t.check("exactly one write went out: the command, on that discussion, as the maintainer", JSON.stringify(writeLines()) === JSON.stringify([{ mutation: "addDiscussionComment", variables: { id: "D_31", body: COMMAND }, as: "octocat" }]), writeLines());
	r = await run.click("widgets", "disc-31");
	t.check("a repeat posts nothing", r.status === 409 && writeLines().length === 1, r);

	writeFileSync(overrides, JSON.stringify({ writeError: "Your token has not been granted the required scopes to execute this query. The 'addDiscussionComment' field requires one of the following scopes: ['public_repo']." }));
	r = await run.click("widgets", "disc-32");
	t.check("a token that may not comment is named plainly", refused(r, /Your gh login octocat may not comment on discussions of acme\/widgets\. GitHub says: .*required scopes.*Nothing was posted\. "Copy command, open GitHub" still works\./s), r);
	const failed = actionsOf(live.home).find((a) => a.itemId === "disc-32");
	t.check("the failed post is recorded and the route stays open", failed?.status === "failed" && (await run.route("widgets", "disc-32", "r2")).done === undefined, failed);
	writeFileSync(overrides, "{}");
	r = await run.click("widgets", "disc-32");
	t.check("after a failure the button works again", r.data.ok === true && writeLines().length === 2 && writeLines()[1].variables.body === COMMAND && writeLines()[1].variables.id === "D_32", r);
} finally {
	run.child.kill("SIGTERM");
}
await sleep(200);
removeDir(T);
t.done();
