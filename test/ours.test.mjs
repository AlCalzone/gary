// A PR with sensitive files that is ours alone: the fact, the lifted push refusal in the validator and at the click,
// and `gary push-check`, which reads GitHub right before a push. Runs on temp roots with the fake gh.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, PROFILE, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { BOT, HEAD, ME } from "./fixtures/github.mjs";
import { oursAlone, sensitiveOurs } from "../scripts/lib/facts.mjs";
import { sensitiveRefusal } from "../scripts/lib/routes.mjs";
import { validateItem } from "../scripts/lib/validate-item.mjs";

const t = runner("ours");
const T = tempDir();
const profile = JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8"));

// ---------- the conditions ----------
const person = (login, name = login) => ({ name, email: `1+${login}@users.noreply.github.com`, user: { login } });
const GITHUB = { name: "GitHub", email: "noreply@github.com", user: null };
const SIGNED = { isValid: true, wasSignedByGitHub: true };
const commit = (author, { committer = author, message = "fix: escalate", signature = null } = {}) => ({ commit: { message, signature, author: person(author), committer: committer === GITHUB ? GITHUB : person(committer) } });
const node = (extra = {}, commits = [commit(BOT)]) => ({ number: 12, isCrossRepository: false, author: { login: BOT }, allCommits: { totalCount: commits.length, nodes: commits }, ...extra });
const who = { me: ME, bot: BOT, garyFix: true, ai: { logins: [BOT, "renovate"], names: ["devin"], own: BOT } };
const ours = (n, w = who) => oursAlone(n, w);
const notOurs = (n, re, w = who) => ours(n, w).ours === false && re.test(ours(n, w).reason);

t.check("a recorded fix PR with only the bot's commits is ours", ours(node()).ours === true && ours(node()).reason === null, ours(node()));
t.check("a PR by the maintainer needs no fix record", ours(node({ author: { login: ME } }, [commit(ME), commit(BOT)]), { ...who, garyFix: false }).ours === true);
t.check("logins compare without regard to case", ours(node({ author: { login: BOT.toUpperCase() } }, [commit(BOT.toUpperCase())])).ours === true);
t.check("a fork PR is not ours", notOurs(node({ isCrossRepository: true }), /head branch is not in this repository/));
t.check("a PR that does not say where its head is is not ours", notOurs(node({ isCrossRepository: undefined }), /head branch/));
t.check("a contributor's PR is not ours", notOurs(node({ author: { login: "hubot" } }), /hubot opened it/));
t.check("a Copilot PR is not ours", notOurs(node({ author: { login: "copilot-swe-agent" } }), /copilot-swe-agent opened it/));
t.check("a dependency bot's PR is not ours", notOurs(node({ author: { login: "renovate" } }), /renovate opened it/));
t.check("a bot PR without a fix record is not ours", notOurs(node(), /no record of it/, { ...who, garyFix: false }));
t.check("a commit authored by someone else makes it not ours", notOurs(node({}, [commit(BOT), commit("hubot", { committer: BOT })]), /commit 2 of 2 was authored by hubot/));
t.check("a commit committed by someone else makes it not ours", notOurs(node({}, [commit(BOT, { committer: "hubot" })]), /commit 1 of 1 was committed by hubot/));
t.check("a commit author without an account makes it not ours", notOurs(node({}, [{ commit: { message: "x", author: { name: "Someone", email: "s@example.com", user: null }, committer: person(BOT) } }]), /authored by Someone/));
t.check("a truncated commit list makes it not ours", notOurs(node({ allCommits: { totalCount: 101, nodes: Array.from({ length: 100 }, () => commit(BOT)) } }), /100 of 101 commits read/));
t.check("a missing commit list makes it not ours", notOurs(node({ allCommits: undefined }), /incomplete/) && notOurs(node({ allCommits: { totalCount: 1, nodes: [] } }), /incomplete/));
t.check("a commit GitHub made and signed for the bot counts", ours(node({}, [commit(BOT, { committer: GITHUB, signature: SIGNED })])).ours === true);
t.check("a GitHub committer without GitHub's signature does not count", notOurs(node({}, [commit(BOT, { committer: GITHUB })]), /committed by GitHub/) && notOurs(node({}, [commit(BOT, { committer: GITHUB, signature: { isValid: true, wasSignedByGitHub: false } })]), /committed by GitHub/));
t.check("an AI agent as co-author is fine", ours(node({}, [commit(BOT, { message: "fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>" }), commit(BOT, { message: "fix: y\n\nCo-authored-by: Devin AI <devin@example.com>" })])).ours === true);
t.check("the maintainer and the bot as co-authors are fine", ours(node({}, [commit(BOT, { message: `fix: x\n\nCo-authored-by: ${ME} <5+${ME}@users.noreply.github.com>\nCo-authored-by: Someone <${BOT}@users.noreply.github.com>` })])).ours === true);
t.check("a co-author with the name the maintainer commits under is fine", ours(node({ author: { login: ME } }, [{ commit: { message: "a", author: { name: "Mona Lisa", email: "mona@example.com", user: { login: ME } }, committer: person(ME) } }, commit(BOT, { message: "b\n\nCo-authored-by: Mona Lisa <other@example.com>" })])).ours === true);
t.check("a human co-author makes it not ours", notOurs(node({}, [commit(BOT, { message: "fix: x\n\nCo-authored-by: Hu Bot <hubot@example.com>" })]), /names the co-author Hu Bot/));
t.check("without a bot only the maintainer counts", ours(node({ author: { login: ME } }, [commit(ME)]), { me: ME, bot: null }).ours === true && notOurs(node({ author: { login: ME } }, [commit(BOT)]), /authored by widgets-bot/, { me: ME, bot: null }));

t.check("the stored entry says whether a sensitive PR is ours", sensitiveOurs({ sensitiveFiles: ["package.json"], sensitiveOurs: true }) && sensitiveOurs({ sensitiveFiles: ["package.json"], facts: { sensitiveOurs: true } }) && !sensitiveOurs({ sensitiveFiles: ["package.json"] }) && !sensitiveOurs({ sensitiveOurs: true }) && !sensitiveOurs(undefined));

// ---------- the snapshot ----------
const snapDir = join(T, "snap");
const snap = makeHome(snapDir);
const overridesFile = join(snapDir, "overrides.json");
const gary = (args, overrides = {}, home = snap) => {
	writeFileSync(overridesFile, JSON.stringify(overrides));
	return spawnSync(process.execPath, [GARY, ...args], { env: { ...home.env, GARY_INSTANCE: "widgets", FAKE_GH_OVERRIDES: overridesFile }, encoding: "utf8" });
};
const json = (r) => {
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { error: r.stdout + r.stderr };
	}
};
// PR 12 changes .github/workflows/ci.yml. These overrides turn it into Gary's own fix PR
const botCommits = { totalCount: 2, nodes: [commit(BOT, { message: "fix: escalate\n\nCo-Authored-By: Claude <noreply@anthropic.com>" }), commit(BOT)] };
const fixPr = { author: { login: BOT, __typename: "User" }, isCrossRepository: false, allCommits: botCommits };
const recordFix = (home) => writeFileSync(join(home.home, "state", "fixes.json"), JSON.stringify({ "issue-22": [{ number: 12, url: "https://github.com/acme/widgets/pull/12", branch: "triage/issue-22", run: "r", startedBy: "routine", at: "2026-11-17T00:00:00Z" }] }));

let entry = json(gary(["item", "pr", "12"]));
t.check("a contributor's sensitive PR says why it is not ours", entry.facts?.sensitiveOurs === undefined && /head branch is not in this repository/.test(entry.facts?.sensitiveNotOurs ?? "") && entry.facts.touchesSensitive === true, entry.facts);
entry = json(gary(["item", "pr", "12"], { "pr-12": fixPr }));
t.check("the bot's PR without a fix record is not ours", entry.facts?.sensitiveOurs === undefined && /no record/.test(entry.facts?.sensitiveNotOurs ?? ""), entry.facts);
recordFix(snap);
entry = json(gary(["item", "pr", "12"], { "pr-12": fixPr }));
t.check("gary item marks the recorded fix PR as ours alone", entry.facts?.sensitiveOurs === true && entry.facts.sensitiveNotOurs === undefined && entry.garyFix?.itemId === "issue-22" && entry.facts.sensitiveFiles[0] === ".github/workflows/ci.yml", entry.facts);
t.check("a PR without sensitive files carries neither fact", (() => {
	const f = json(gary(["item", "pr", "25"])).facts;
	return f && !("sensitiveOurs" in f) && !("sensitiveNotOurs" in f);
})());
const pendingOf = (home) => JSON.parse(readFileSync(join(home.home, "state", "snapshot.pending.json"), "utf8")).items;
let out = json(gary(["snapshot"], { "pr-12": fixPr }));
t.check("the snapshot marks the fix PR as ours alone", out.changed?.find((e) => e.id === "pr-12")?.facts.sensitiveOurs === true, out.changed?.find((e) => e.id === "pr-12")?.facts);
t.check("the staged snapshot keeps the sensitive files and the mark", JSON.stringify(pendingOf(snap)["pr-12"].sensitiveFiles) === '[".github/workflows/ci.yml"]' && pendingOf(snap)["pr-12"].sensitiveOurs === true && JSON.stringify(pendingOf(snap)["pr-17"].sensitiveFiles) === '["package.json"]' && !("sensitiveOurs" in pendingOf(snap)["pr-17"]) && !("sensitiveFiles" in pendingOf(snap)["pr-25"]), pendingOf(snap)["pr-12"]);
out = json(gary(["snapshot"], { "pr-12": { ...fixPr, allCommits: { totalCount: 3, nodes: [...botCommits.nodes, commit("hubot")] } } }));
t.check("after a commit by someone else the next snapshot drops the mark", /commit 3 of 3 was authored by hubot/.test(out.changed?.find((e) => e.id === "pr-12")?.facts.sensitiveNotOurs ?? "") && !("sensitiveOurs" in pendingOf(snap)["pr-12"]) && pendingOf(snap)["pr-12"].sensitiveFiles.length === 1, pendingOf(snap)["pr-12"]);

// ---------- gary push-check ----------
const check = (args, overrides) => {
	const r = gary(["push-check", ...args], overrides);
	return { status: r.status, ...json(r) };
};
let c = check(["--pr", "12", "--sha", HEAD], { "pr-12": fixPr });
t.check("push-check allows the push to a fix PR that is ours alone", c.status === 0 && c.ok === true && c.sensitiveOurs === true && c.headSha === HEAD && c.sensitiveFiles.length === 1 && c.refused === undefined, c);
c = check(["--pr", "12", "--sha", HEAD], { "pr-12": { ...fixPr, allCommits: { totalCount: 3, nodes: [...botCommits.nodes, commit("hubot")] } } });
t.check("push-check refuses once someone else committed", c.status === 3 && c.ok === false && c.sensitiveOurs === false && /changes sensitive files \(\.github\/workflows\/ci\.yml\) and is not ours alone: commit 3 of 3 was authored by hubot/.test(c.refused), c);
c = check(["--pr", "12"]);
t.check("push-check refuses a contributor's sensitive PR", c.status === 3 && /not ours alone: its head branch is not in this repository/.test(c.refused), c);
c = check(["--pr", "12"], { "pr-12": { isCrossRepository: false } });
t.check("push-check refuses a contributor's sensitive PR on a branch of the repo", c.status === 3 && /hubot opened it/.test(c.refused), c);
c = check(["--pr", "12", "--sha", "8".repeat(40)], { "pr-12": fixPr });
t.check("push-check refuses a moved head", c.status === 3 && /The head of PR #12 is 944d5ac.*Someone pushed/.test(c.refused), c);
c = check(["--pr", "12", "--sha", HEAD], { "pr-12": { ...fixPr, state: "CLOSED" } });
t.check("push-check refuses a closed PR", c.status === 3 && /#12 is closed/.test(c.refused), c);
c = check(["--pr", "25", "--sha", "5".repeat(40)]);
t.check("push-check allows a PR without sensitive files", c.status === 0 && c.ok === true && c.sensitiveFiles.length === 0 && c.sensitiveOurs === false, c);
// The snapshot's first page of files does not show the workflow
const manyFiles = { files: { totalCount: 5, nodes: [{ path: "config/devices/acme/w1.json" }] }, allFiles: [{ path: "config/devices/acme/w1.json" }, { path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }, { path: ".github/workflows/release.yml" }] };
c = check(["--pr", "25"], { "pr-25": manyFiles });
t.check("push-check reads every changed file, also beyond the first page", c.status === 3 && JSON.stringify(c.sensitiveFiles) === '[".github/workflows/release.yml"]' && /not ours alone/.test(c.refused), c);
t.check("gary item keeps to the first page", json(gary(["item", "pr", "25"], { "pr-25": manyFiles })).files?.length === 1);
let r = gary(["push-check", "--pr", "12", "--sha", "abc"]);
t.check("push-check needs a full SHA", r.status === 1 && /full 40-character SHA/.test(r.stderr), r.stderr);
r = gary(["push-check"]);
t.check("push-check without a PR prints its usage", r.status === 1 && /Usage: gary push-check/.test(r.stderr), r.stderr);

// ---------- route rules and the validator ----------
for (const type of ["take_over", "revise", "address_review", "drive", "format"]) {
	t.check(`${type} is not refused on a sensitive PR that is ours alone`, sensitiveRefusal({ type }, true, true) === null && /sensitive files/.test(sensitiveRefusal({ type }, true, false) ?? ""));
}
const reviewedAt = "2026-11-17T14:00:00Z";
const agentRoute = (type, extra = {}) => ({ id: "r1", type, as: "agent", title: `${type}: x`, recommended: true, ...extra });
const apiRoute = { id: "r1", type: "revise", as: "bot", title: "Change: fix the link", recommended: true, params: { via: "api", message: "docs: fix the link", edits: [{ path: "CONTRIBUTING.md", original: "old", replacement: "new" }] } };
const merge = { id: "r2", type: "merge", as: "me", title: "Merge" };
const pr = (number, routes, extra = {}) => ({
	kind: "pr", repo: "acme/widgets", number, title: "Fix the escalate script", url: `https://github.com/acme/widgets/pull/${number}`, author: BOT, authorType: "bot",
	section: "review", priority: 1, effortMinutes: 5, reviewDepth: "full", state: "Changes .github/workflows/ci.yml.", reviewedAt, reviewedSha: HEAD, hint: routes.find((x) => x.recommended)?.title, routes,
	threads: [{ id: "PRRT_1", verdict: "valid" }], autofix: { changes: true, files: 1, lines: 2, tools: ["fmt"] }, ...extra,
});
const validate = (item, opts) => validateItem(`pr-${item.number}`, item, { mode: "bot", profile, ...opts }).errors.map((e) => e.message);
for (const route of [agentRoute("revise", { text: "Fix the link" }), agentRoute("drive"), agentRoute("address_review"), agentRoute("format")]) {
	t.check(`the validator accepts ${route.type} on a sensitive PR that is ours alone`, validate(pr(12, [route]), { sensitive: true, sensitiveOurs: true }).length === 0 && validate(pr(12, [route]), { sensitive: true }).some((m) => /sensitive files/.test(m)), validate(pr(12, [route]), { sensitive: true, sensitiveOurs: true }));
}
t.check("the validator refuses the API form on a PR that is ours alone", validate(pr(12, [apiRoute]), { sensitive: true, sensitiveOurs: true }).some((m) => /only the maintainer and the bot committed to this PR, so it gets the normal revise and no API edit/.test(m)) && validate(pr(12, [apiRoute]), { sensitive: true }).length === 0, validate(pr(12, [apiRoute]), { sensitive: true }));

// `gary put` reads both facts from the snapshot
const putDir = join(T, "put");
const put = makeHome(putDir);
const snapshotFile = (home) => join(home.home, "state", "snapshot.json");
const oursSnapshot = { items: { "pr-12": { kind: "pr", number: 12, sensitiveFiles: [".github/workflows/ci.yml"], sensitiveOurs: true }, "pr-14": { kind: "pr", number: 14, sensitiveFiles: [".github/bot-scripts/escalate.cjs"], sensitiveOurs: true }, "pr-27": { kind: "pr", number: 27, sensitiveFiles: ["package.json"] } } };
writeFileSync(snapshotFile(put), JSON.stringify(oursSnapshot));
const putItem = (item) => {
	const file = join(putDir, "item.json");
	writeFileSync(file, JSON.stringify(item));
	return spawnSync(process.execPath, [GARY, "put", "items", `pr-${item.number}`, file], { env: { ...put.env, GARY_INSTANCE: "widgets" }, encoding: "utf8" });
};
t.check("gary put accepts a checkout change on a PR that is ours alone", putItem(pr(12, [agentRoute("revise", { text: "Fix the link" }), merge])).status === 0);
r = putItem(pr(12, [apiRoute, merge]));
t.check("gary put refuses the API form there", r.status === 1 && /no API edit/.test(r.stdout), r.stdout);
r = putItem(pr(27, [agentRoute("revise", { text: "Fix the link" }), merge]));
t.check("gary put still refuses a checkout change on a sensitive PR that is not ours", r.status === 1 && /only allowed as an API edit/.test(r.stdout), r.stdout);

// ---------- the click ----------
async function startServer(home, port, extraEnv) {
	const child = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--port", String(port)], { env: { ...home.env, ...extraEnv }, stdio: ["ignore", "inherit", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await sleep(100);
	const token = readFileSync(join(home.root, "state", "server-token"), "utf8").trim();
	const api = async (path, body) => {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? "POST" : "GET", headers: { "X-Board-Token": token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		return { status: res.status, data: await res.json() };
	};
	const item = async (itemId) => (await api("/api/state")).data.items.find((i) => i.id === itemId);
	const click = async (itemId, routeId = "r1", extra = {}) => api("/api/action", { instance: "widgets", itemId, routeId, draftHash: (await item(itemId)).routes.find((x) => x.id === routeId).draftHash, ...extra });
	return { child, item, click };
}
const liveDir = join(T, "live");
const livePort = await freePort();
const live = makeHome(liveDir, { port: livePort });
const routes = [agentRoute("revise", { text: "Fix the link" }), { ...agentRoute("drive"), id: "r2", recommended: false }, { ...agentRoute("address_review"), id: "r3", recommended: false }, { ...agentRoute("format"), id: "r4", recommended: false }];
for (const n of [12, 14, 27]) writeFileSync(join(live.home, "state", "board", "items", `pr-${n}.json`), JSON.stringify(pr(n, routes)));
writeFileSync(snapshotFile(live), JSON.stringify(oursSnapshot));
const stub = join(liveDir, "stub.json");
writeFileSync(stub, JSON.stringify({ "*": { state: "OPEN" } }));
const writes = join(liveDir, "writes.log");
const server = await startServer(live, livePort, { GARY_GUARD_STUB: stub, FAKE_GH_WRITES: writes });
const actionsOf = (home) => readdirSync(join(home, "state", "board", "actions")).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(home, "state", "board", "actions", n), "utf8")));
try {
	let served = await server.item("pr-12");
	t.check("the board serves the files and that the PR is ours alone", served.sensitive?.ours === true && served.sensitive.files[0] === ".github/workflows/ci.yml" && served.sensitive.total === 1, served.sensitive);
	served = await server.item("pr-27");
	t.check("a sensitive PR that is not ours is served without the mark", served.sensitive?.files?.[0] === "package.json" && !("ours" in served.sensitive), served.sensitive);
	t.check("a checkout change on a sensitive PR that is not ours is refused at the click", (await server.click("pr-27")).data.ok === false);
	let res = await server.click("pr-14");
	t.check("a checkout change on a PR that is ours alone is queued", res.status === 200 && res.data.ok === true && res.data.queued === true, res);
	t.check("the queued request is a revise for the agent", actionsOf(live.home).some((a) => a.itemId === "pr-14" && a.action === "revise" && a.status === "queued" && a.via === "queue"), actionsOf(live.home));
	// The next snapshot saw a commit by someone else
	writeFileSync(snapshotFile(live), JSON.stringify({ items: { ...oursSnapshot.items, "pr-12": { kind: "pr", number: 12, sensitiveFiles: [".github/workflows/ci.yml"] } } }));
	for (const [id, type] of [["r2", "drive"], ["r3", "address_review"], ["r4", "format"]]) {
		res = await server.click("pr-12", id, type === "address_review" ? { input: { decisions: [{ threadId: "PRRT_1", decision: "fix" }] } } : {});
		t.check(`${type} is refused again once the snapshot no longer marks the PR as ours`, res.status === 200 && res.data.ok === false && res.data.sensitive === true && new RegExp(`does not run ${type}`).test(res.data.result), res);
	}
	served = await server.item("pr-12");
	t.check("the board then serves the PR without the mark", served.sensitive?.files?.length === 1 && !("ours" in served.sensitive), served.sensitive);
	t.check("no click wrote to GitHub", (() => {
		try {
			return readFileSync(writes, "utf8").trim() === "";
		} catch {
			return true;
		}
	})());
} finally {
	server.child.kill();
}

removeDir(T);
t.done();
