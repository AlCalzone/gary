// Where a bot PR outside fixes.json came from: the local Claude Code session found in fixture transcripts, the cache in
// origins.json, the watch that waits while that session is active, and the origin the board server serves.
// Runs offline against the fake gh. The transcripts live in a temp directory.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { BOT, ME } from "./fixtures/github.mjs";

const t = runner("origins");
const T = tempDir();
const port = await freePort();
const { home, root, env: baseEnv } = makeHome(T, { port });
const SESSIONS = join(T, "sessions");
const OVERRIDES = join(T, "overrides.json");
writeFileSync(OVERRIDES, "{}");
const env = { ...baseEnv, GARY_SESSIONS_DIR: SESSIONS, FAKE_GH_OVERRIDES: OVERRIDES, FAKE_GH_WRITES: join(T, "gh-writes.jsonl") };
const state = join(home, "state");
const gary = (...args) => spawnSync(process.execPath, [GARY, ...args], { env, encoding: "utf8" });
const json = (r) => {
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { unparsed: r.stdout + r.stderr };
	}
};
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const lines = (r) => r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const feedbackLines = (r) => lines(r).filter((l) => l.event === "maintainer-feedback");

const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
const CREATED = { 19: ago(360), 21: ago(300), 41: ago(240), 43: ago(200), 44: ago(180), 45: ago(120) };
const url = (n) => `https://github.com/acme/widgets/pull/${n}`;

// ---------- the transcripts ----------
const CWD = join(homedir(), "repositories", "widgets", "master");
const GARY_CWD = join(homedir(), ".config", "gary", "instances", "widgets");
const projectDir = (cwd) => join(SESSIONS, cwd.replace(/[^A-Za-z0-9]/g, "-"));
const ID = { a: "aaaaaaaa-0000-4000-8000-000000000001", b: "bbbbbbbb-0000-4000-8000-000000000002", c: "cccccccc-0000-4000-8000-000000000003", d: "dddddddd-0000-4000-8000-000000000004", e: "eeeeeeee-0000-4000-8000-000000000005", f: "ffffffff-0000-4000-8000-000000000006", g: "99999999-0000-4000-8000-000000000007" };
const transcriptOf = (key, cwd = CWD) => join(projectDir(cwd), ID[key] + ".jsonl");
function session(key, events, { cwd = CWD, mtime = NOW } = {}) {
	const sessionId = ID[key];
	const out = [{ type: "mode", mode: "default", sessionId }];
	let n = 0;
	for (const e of events) {
		const base = { timestamp: e.at, cwd, sessionId };
		if (e.prompt) out.push({ ...base, type: "user", message: { role: "user", content: e.prompt } });
		else {
			const id = `toolu_${key}${++n}`;
			const input = e.mcp ? e.input ?? {} : { command: e.bash };
			out.push({ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: e.mcp ?? "Bash", input }] } });
			out.push({ ...base, timestamp: e.resultAt ?? e.at, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: e.result ?? "" }] } });
		}
	}
	const file = transcriptOf(key, cwd);
	mkdirSync(projectDir(cwd), { recursive: true });
	writeFileSync(file, out.map((o) => JSON.stringify(o)).join("\n") + "\n");
	utimesSync(file, new Date(mtime), new Date(mtime));
	return file;
}
const touch = (key, minutesAgo, cwd = CWD) => utimesSync(transcriptOf(key, cwd), new Date(NOW - minutesAgo * 60000), new Date(NOW - minutesAgo * 60000));
const before = (n, minutes) => new Date(Date.parse(CREATED[n]) - minutes * 60000).toISOString();
const after = (n, minutes) => new Date(Date.parse(CREATED[n]) + minutes * 60000).toISOString();

const PROMPT = "Look into why the LED stays red after a restore. " + "The log shows the restore finishing but the LED state never updates. ".repeat(4);
const SECRET = "ghp_fixture_secret_from_a_tool_result";
// A opens PR 19 with gh pr create, in the same command as the push
session("a", [
	{ prompt: PROMPT, at: before(19, 2880) },
	{ bash: `cat .env`, result: `TOKEN=${SECRET}`, at: before(19, 2000) },
	{ bash: "git push -u origin fix/led-red && gh pr create --head fix/led-red --title 'fix: LED' --body-file /tmp/b.md", result: url(19) + "\n", at: before(19, 1) },
], { mtime: NOW - 120 * 60000 });
// B pushes the head branch of PR 41 without naming it and finds the PR's URL after it was opened on GitHub
session("b", [
	{ prompt: "Update the README", at: before(41, 60) },
	{ bash: "git push -u origin HEAD", result: "To github.com:acme/widgets.git\n * [new branch]      HEAD -> docs/readme\nbranch 'docs/readme' set up to track 'origin/docs/readme'.", at: before(41, 10) },
	{ bash: "gh pr list --head docs/readme", result: `41\tdocs: the README\tdocs/readme\t${url(41)}`, at: after(41, 3) },
]);
// C is a Gary worker: it reads PRs 19 and 41, pushes a round to 19 and tries to open 41 again
session("c", [
	{ prompt: "/triage-routine", at: after(19, 30) },
	{ bash: "gh pr view 19 --json url", result: url(19), at: after(19, 31) },
	{ mcp: "mcp__github__get_pull_request", input: { pullNumber: 41 }, result: JSON.stringify({ html_url: url(41) }), at: after(41, 5) },
	{ bash: "git push origin fix/led-red", result: " fix/led-red -> fix/led-red", at: after(19, 60) },
	{ bash: "gh pr view 19 --json url", result: url(19), at: after(19, 61) },
	{ bash: "gh pr create --head docs/readme --title again", result: `a pull request for branch "docs/readme" into branch "main" already exists:\n${url(41)}`, at: after(41, 20) },
], { cwd: GARY_CWD });
// D opens PR 44 through an MCP tool
session("d", [
	{ prompt: "Add the W2 sensor", at: before(44, 30) },
	{ mcp: "mcp__github__create_pull_request", input: { head: "feat/w2", title: "Add W2" }, result: JSON.stringify({ number: 44, html_url: url(44) }), at: before(44, 0) },
]);
// E is Gary's fix worker that opened PR 21, which fixes.json records
session("e", [
	{ prompt: "Fix issue 23", at: before(21, 30) },
	{ bash: "gh pr create --draft --head gary/fix-issue-23", result: url(21), at: before(21, 0) },
], { cwd: GARY_CWD });
// F opened PR 45, but its file is older than the PR, so it is not read
session("f", [
	{ prompt: "Old session", at: before(45, 30) },
	{ bash: "gh pr create --head old/branch", result: url(45), at: before(45, 0) },
], { mtime: Date.parse(CREATED[45]) - 3600000 });

const bot = (n, headRef, extra = {}) => ({ kind: "pr", author: BOT, createdAt: CREATED[n], headRef, ...extra });
const snapshot = {
	"pr-19": bot(19, "fix/led-red"),
	"pr-21": bot(21, "gary/fix-issue-23"),
	"pr-41": bot(41, "docs/readme"),
	"pr-43": bot(43, "chore/deps"),
	"pr-44": bot(44, "feat/w2"),
	"pr-45": bot(45, "old/branch"),
	"pr-50": { kind: "pr", author: "hubot", createdAt: CREATED[41], headRef: "docs/readme" },
};
writeFileSync(join(state, "snapshot.json"), JSON.stringify({ items: snapshot }));
writeFileSync(join(state, "fixes.json"), JSON.stringify({ "issue-23": [{ number: 21, url: url(21), branch: "gary/fix-issue-23", run: "run-1", startedBy: "routine", at: CREATED[21] }] }));

// ---------- gary pr-origin ----------
let r = gary("pr-origin", "--json");
let o = json(r).origins ?? {};
const first = o;
t.check("pr-origin runs and lists the bot PRs outside fixes.json", r.status === 0 && JSON.stringify(Object.keys(o).sort()) === JSON.stringify(["pr-19", "pr-41", "pr-43", "pr-44", "pr-45"]), r.stdout + r.stderr);
t.check("gh pr create finds the session that opened PR 19", o["pr-19"]?.found === true && o["pr-19"].sessionId === ID.a && o["pr-19"].via === "gh_pr_create" && o["pr-19"].cwd === CWD, o["pr-19"]);
t.check("the origin keeps the session's start and its transcript's time as the last activity", o["pr-19"]?.startedAt === before(19, 2880) && o["pr-19"].lastActiveAt === ago(120), o["pr-19"]);
t.check("the first prompt is cut to 100 characters", o["pr-19"]?.prompt?.length === 100 && o["pr-19"].prompt.endsWith("…") && PROMPT.startsWith(o["pr-19"].prompt.slice(0, 99)), o["pr-19"]?.prompt);
t.check("a push of the head branch followed by the PR's URL finds the session that opened PR 41", o["pr-41"]?.found === true && o["pr-41"].sessionId === ID.b && o["pr-41"].via === "push", o["pr-41"]);
t.check("a session that only reads, pushes to or re-creates a PR later is no origin", o["pr-19"]?.sessionId !== ID.c && o["pr-41"]?.sessionId !== ID.c);
t.check("an MCP create-PR call finds the session that opened PR 44", o["pr-44"]?.found === true && o["pr-44"].sessionId === ID.d && o["pr-44"].via === "mcp", o["pr-44"]);
t.check("a PR without a session is cached as not found", o["pr-43"]?.found === false && typeof o["pr-43"].checkedAt === "string" && Object.keys(o["pr-43"]).length === 2, o["pr-43"]);
t.check("a transcript older than the PR is not read", o["pr-45"]?.found === false, o["pr-45"]);
t.check("Gary's fix PR and a contributor's PR get no origin", !("pr-21" in o) && !("pr-50" in o));
const stored = readFileSync(join(state, "origins.json"), "utf8");
t.check("origins.json keeps only the session id, directory, times, prompt, transcript name and how it was found", JSON.stringify(Object.keys(read(join(state, "origins.json"))["pr-19"]).sort()) === JSON.stringify(["checkedAt", "cwd", "found", "lastActiveAt", "prompt", "sessionId", "startedAt", "transcript", "via"]) && !stored.includes(SECRET) && !stored.includes("gh pr create"), stored);

// The second run reads the cache: a new session for PR 43 is not searched, and only lastActiveAt moves
session("g", [
	{ prompt: "Bump the deps", at: before(43, 30) },
	{ bash: "gh pr create --head chore/deps", result: url(43), at: before(43, 0) },
]);
touch("a", 90);
r = gary("pr-origin", "--json");
o = json(r).origins ?? {};
t.check("the second run takes the origin from the cache and moves only lastActiveAt", r.status === 0 && o["pr-19"]?.lastActiveAt === ago(90) && JSON.stringify({ ...o["pr-19"], lastActiveAt: null }) === JSON.stringify({ ...first["pr-19"], lastActiveAt: null }), [o["pr-19"], first["pr-19"]]);
t.check("the second run does not search a PR it found no session for", JSON.stringify(o["pr-43"]) === JSON.stringify(first["pr-43"]) && JSON.stringify(o["pr-41"]) === JSON.stringify(first["pr-41"]), o["pr-43"]);
r = gary("pr-origin", "--json", "--refresh");
o = json(r).origins ?? {};
t.check("--refresh searches again", o["pr-43"]?.found === true && o["pr-43"].sessionId === ID.g && o["pr-19"]?.sessionId === ID.a, o["pr-43"]);
r = gary("pr-origin");
t.check("the text output names each PR's session", r.status === 0 && r.stdout.includes(`#19 opened by session ${ID.a} in ${CWD}`) && r.stdout.includes("#45 no local session found"), r.stdout + r.stderr);
t.check("pr-origin refuses unknown flags", gary("pr-origin", "--all").status !== 0);
// The root config names the transcript directory when GARY_SESSIONS_DIR is not set
const rootConfig = join(root, "config.json");
const saved = readFileSync(rootConfig, "utf8");
writeFileSync(rootConfig, JSON.stringify({ ...JSON.parse(saved), sessionsDir: SESSIONS }));
const { GARY_SESSIONS_DIR: _, ...withoutDir } = env;
r = spawnSync(process.execPath, [GARY, "pr-origin", "--json"], { env: withoutDir, encoding: "utf8" });
t.check("sessionsDir in the root config.json names the transcript directory", r.status === 0 && json(r).sessions === SESSIONS && json(r).origins?.["pr-19"]?.sessionId === ID.a, r.stdout + r.stderr);
writeFileSync(rootConfig, saved);

// ---------- the watch ----------
const SHA = "9".repeat(40);
const ourCommit = (committedDate) => ({ commit: { committedDate, author: { user: { login: BOT } }, committer: { user: { login: BOT } } } });
const review = (submittedAt) => ({ author: { login: ME, __typename: "User" }, state: "CHANGES_REQUESTED", submittedAt, url: `${url(19)}#pullrequestreview-${Date.parse(submittedAt)}` });
const pushed = after(19, 30);
const reviewed = after(19, 120);
writeFileSync(OVERRIDES, JSON.stringify({ "pr-19": { recentCommits: { nodes: [ourCommit(pushed)] }, allReviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [review(reviewed)] }, timelineComments: { totalCount: 0, nodes: [] } } }));
writeFileSync(join(state, "snapshot.json"), JSON.stringify({ items: { "pr-19": bot(19, "fix/led-red", { headSha: SHA, feedback: { ourLastCommitAt: pushed, lastMeAt: reviewed } }) } }));
const actionsDir = join(state, "board", "actions");
const actions = () => readdirSync(actionsDir).filter((n) => n.endsWith(".json"));

// The session wrote 5 minutes ago. The cache still says 90 minutes, so the watch reads the file's time itself
touch("a", 5);
r = gary("watch-queue", "--once");
t.check("while the session that opened the PR is active, the watch prints no maintainer-feedback line", r.status === 0 && feedbackLines(r).length === 0, r.stdout + r.stderr);
r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", reviewed);
t.check("while it is active, pr-watch round refuses with exit 3 and names the session", r.status === 3 && json(r).refused === true && json(r).result.includes(ID.a) && json(r).result.includes("~/repositories/widgets/master") && /quiet for 30 minutes/.test(json(r).result) && actions().length === 0, r.stdout + r.stderr);
r = gary("pr-watch", "round", "--pr", "19", "--by", "others", "--at", reviewed);
t.check("the refusal holds for other people's feedback too", r.status === 3 && json(r).result.includes(ID.a), r.stdout);

touch("a", 31);
r = gary("watch-queue", "--once");
t.check("after 30 quiet minutes the unhandled feedback prints its line", JSON.stringify(feedbackLines(r)) === JSON.stringify([{ instance: "widgets", id: "watch-pr-19", itemId: "pr-19", action: "drive", event: "maintainer-feedback", pr: 19, at: reviewed }]), r.stdout + r.stderr);
r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", reviewed);
t.check("after 30 quiet minutes pr-watch round queues the round", r.status === 0 && json(r).queued === true && actions().length === 1, r.stdout + r.stderr);

// ---------- feedback a round refused while the session was active ----------
const driveFile = join(state, "drive", "pr-19.json");
const reviewed2 = after(19, 150);
const reviewed3 = after(19, 180);
const reviewsOf = (...times) => writeFileSync(OVERRIDES, JSON.stringify({ "pr-19": { recentCommits: { nodes: [ourCommit(pushed)] }, allReviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: times.map(review) }, timelineComments: { totalCount: 0, nodes: [] } } }));
const clearActions = () => {
	for (const n of actions()) rmSync(join(actionsDir, n));
};
reviewsOf(reviewed, reviewed2);
clearActions();
touch("a", 31);
const watcher = spawn(process.execPath, [GARY, "watch-queue"], { env: { ...env, GARY_WATCH_POLL_MS: "150" }, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
watcher.stdout.on("data", (d) => (out += d));
const printed = (when) => out.split("\n").filter((l) => /maintainer-feedback/.test(l) && JSON.parse(l).at === when).length;
const waitFor = async (fn) => {
	for (let i = 0; i < 50 && !fn(); i++) await sleep(100);
	return fn();
};
try {
	t.check("the watcher prints the new feedback once", await waitFor(() => printed(reviewed2) === 1), out);
	touch("a", 5);
	r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", reviewed2);
	const held = read(driveFile).held;
	t.check("a round refused for the live session records the feedback as held", r.status === 3 && held?.feedbackAt === reviewed2 && held.by === "me" && held.session === ID.a && typeof held.since === "string" && actions().length === 0, [r.stdout, held]);
	await sleep(800);
	t.check("while the session stays active, the watcher prints it no second time", printed(reviewed2) === 1, out);
	touch("a", 31);
	t.check("once the session has been quiet for 30 minutes, the watcher prints the held feedback again", await waitFor(() => printed(reviewed2) === 2), out);
	r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", reviewed2);
	t.check("the round then starts and clears the hold", r.status === 0 && json(r).queued === true && actions().length === 1 && !("held" in read(driveFile)), r.stdout + r.stderr);
	await sleep(800);
	r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", reviewed2);
	t.check("the held feedback starts exactly one round", printed(reviewed2) === 2 && r.status === 3 && actions().length === 1, [out, r.stdout]);

	// A refusal for another reason, here a running push job, records no hold and prints nothing again
	clearActions();
	reviewsOf(reviewed, reviewed2, reviewed3);
	t.check("the watcher prints newer feedback once", await waitFor(() => printed(reviewed3) === 1), out);
	writeFileSync(join(actionsDir, "pr-19-revise.json"), JSON.stringify({ itemId: "pr-19", action: "revise", status: "queued", createdAt: new Date().toISOString(), result: "" }));
	r = gary("pr-watch", "round", "--pr", "19", "--by", "me", "--at", reviewed3);
	t.check("a round refused because a job runs records no hold", r.status === 3 && /already works/.test(json(r).result) && !("held" in read(driveFile)), r.stdout);
	clearActions();
	await sleep(800);
	t.check("feedback refused for another reason is not printed again", printed(reviewed3) === 1, out);
} finally {
	watcher.kill();
}

// ---------- the board server ----------
const item = (number, author = BOT) => ({
	kind: "pr", repo: "acme/widgets", number, title: `PR ${number}`, url: url(number), author, authorType: author === BOT ? "bot" : "contributor",
	section: "review", priority: 1, effortMinutes: 5, reviewDepth: "full", state: "Fine.", hint: "Merge", routes: [{ id: "r1", type: "merge", as: "me", title: "Merge", recommended: true }],
});
for (const [n, author] of [[19], [21], [45], [50, "hubot"]]) writeFileSync(join(state, "board", "items", `pr-${n}.json`), JSON.stringify(item(n, author)));
touch("a", 7);
const child = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
try {
	for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await sleep(100);
	const token = readFileSync(join(root, "state", "server-token"), "utf8").trim();
	const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "X-Board-Token": token } });
	const items = (await res.json()).items ?? [];
	const served = (id) => items.find((i) => i.id === id);
	const s19 = served("pr-19")?.origin;
	t.check("the server serves the origin with the directory as ~/…, the resume command and the transcript's time", s19?.found === true && s19.sessionId === ID.a && s19.dir === "~/repositories/widgets/master" && s19.resume === `cd ~/repositories/widgets/master && claude --resume ${ID.a}` && s19.lastActiveAt === ago(7) && s19.startedAt === before(19, 2880) && !("transcript" in s19) && !("cwd" in s19), s19 ?? stderr);
	t.check("a bot PR without a found session is served as not found", JSON.stringify(served("pr-45")?.origin) === JSON.stringify({ found: false }), served("pr-45"));
	t.check("Gary's fix PR and a contributor's PR are served without an origin", served("pr-21") && !("origin" in served("pr-21")) && served("pr-50") && !("origin" in served("pr-50")));
	t.check("without unhandled feedback the PR gets no hold", !("hold" in served("pr-19")), served("pr-19")?.hold);

	// His review in the snapshot that no round handled, while the session was active 7 minutes ago
	const stateNow = async () => (await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "X-Board-Token": token } })).json()).items ?? [];
	writeFileSync(join(state, "snapshot.json"), JSON.stringify({ items: { "pr-19": bot(19, "fix/led-red", { headSha: SHA, feedback: { ourLastCommitAt: pushed, lastMeAt: reviewed3, lastMeKind: "review" } }) } }));
	let hold = (await stateNow()).find((i) => i.id === "pr-19")?.hold;
	t.check("while the session is active, the server serves the hold with his review, its time and when it ends", JSON.stringify(hold) === JSON.stringify({ feedbackAt: reviewed3, feedbackKind: "review", lastActiveAt: ago(7), until: ago(-23) }), hold);
	const reviewed4 = after(19, 200);
	writeFileSync(driveFile, JSON.stringify({ ...read(driveFile), held: { feedbackAt: reviewed4, by: "me", session: ID.a, since: ago(6) } }));
	hold = (await stateNow()).find((i) => i.id === "pr-19")?.hold;
	t.check("feedback a refused round recorded is served too, without a kind the snapshot does not know", hold?.feedbackAt === reviewed4 && hold.feedbackKind === null, hold);
	touch("a", 31);
	hold = (await stateNow()).find((i) => i.id === "pr-19")?.hold;
	t.check("once the session has been quiet for 30 minutes, the server drops the hold", hold === undefined, hold);
} finally {
	child.kill();
}

// ---------- the resume command ----------
const lib = await import("../scripts/lib/origins.mjs");
t.check("a directory with a space is quoted after the ~", lib.resumeCommand({ cwd: join(homedir(), "my repos", "it's"), sessionId: ID.a }) === `cd ~/'my repos/it'\\''s' && claude --resume ${ID.a}`);
t.check("a directory outside the home stays absolute", lib.resumeCommand({ cwd: "/srv/widgets", sessionId: ID.a }) === `cd /srv/widgets && claude --resume ${ID.a}`);
t.check("no transcript directory means no origins", (await lib.findOrigins([{ number: 19, repo: "acme/widgets", branch: "x", createdAt: CREATED[19] }], join(T, "missing"))).get(19) === null);

t.check("no test wrote to GitHub", !existsSync(env.FAKE_GH_WRITES) || readFileSync(env.FAKE_GH_WRITES, "utf8").trim() === "");
rmSync(SESSIONS, { recursive: true, force: true });
removeDir(T);
t.done();
