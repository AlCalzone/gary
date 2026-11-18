// The fix state of issues and discussions: running fix jobs, Gary's fix PRs and GitHub's links, and the block on a
// second fix. Runs offline against the fake gh.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("fixes");
const T = tempDir();
const { home, env, root } = makeHome(T);
const items = join(home, "state", "board", "items");
const gary = (...args) => spawnSync(process.execPath, [GARY, ...args], { env, encoding: "utf8" });
const json = (r) => {
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { unparsed: r.stdout + r.stderr };
	}
};
let n = 0;
const file = (data) => {
	const f = join(T, `doc-${++n}.json`);
	writeFileSync(f, JSON.stringify(data));
	return f;
};
const BASE = { repo: "acme/widgets", title: "t", author: "hubot", authorType: "contributor", section: "easy", priority: 1, effortMinutes: 5, reviewDepth: "full", state: "Decide." };
const withFix = (kind, number) => ({
	...BASE, kind, number, url: `https://github.com/acme/widgets/${kind === "issue" ? "issues" : "discussions"}/${number}`, hint: "Fix: try it",
	routes: [{ id: "r1", type: "follow_up", as: "agent", title: "Fix: try it", text: "Write a test first", recommended: true }],
});

// Unit checks on the state
process.env.GARY_HOME = root;
const f = await import("../scripts/lib/fixes.mjs");
const none = { claims: [], actions: [], records: {}, snapshot: {}, repo: "acme/widgets" };
const closing = (number, state, isDraft = false) => ({ number, url: `https://github.com/acme/widgets/pull/${number}`, state, isDraft, title: `PR ${number}`, author: "hubot" });
t.check("nothing fixes an item without sources", f.fixStateOf("issue-1", none) === null);
let s = f.fixStateOf("issue-1", { ...none, claims: [{ itemId: "issue-1", kind: "fix", at: "2026-11-18T10:00:00Z", expired: false }] });
t.check("a fix claim is a running job of the routine", s.state === "working" && s.startedBy === "routine" && s.pr === null && s.since === "2026-11-18T10:00:00Z" && /already running, started by the routine/.test(f.fixBlock(s)), s);
s = f.fixStateOf("issue-1", { ...none, actions: [{ id: "a1", data: { itemId: "issue-1", action: "start_fix", status: "queued", createdAt: "2026-11-18T11:00:00Z" } }] });
t.check("a queued Start fix is a running job of the maintainer", s.state === "working" && s.startedBy === "maintainer" && !!f.fixBlock(s), s);
s = f.fixStateOf("issue-1", { ...none, snapshot: { "issue-1": { closingPrs: [closing(30, "open", true)] } } });
t.check("a draft PR blocks", s.state === "draft" && s.pr.number === 30 && s.pr.isDraft === true && s.startedBy === "other" && /already open as draft PR #30 "PR 30"/.test(f.fixBlock(s)), s);
s = f.fixStateOf("issue-1", { ...none, snapshot: { "issue-1": { closingPrs: [closing(30, "open")] } } });
t.check("an open PR blocks", s.state === "open" && !!f.fixBlock(s), s);
s = f.fixStateOf("issue-1", { ...none, snapshot: { "issue-1": { closingPrs: [closing(30, "merged")] } } });
t.check("a merged PR does not block", s.state === "merged" && f.fixBlock(s) === null, s);
s = f.fixStateOf("issue-1", { ...none, snapshot: { "issue-1": { closingPrs: [closing(30, "closed")] } } });
t.check("a closed PR does not block", s.state === "closed" && f.fixBlock(s) === null, s);
const record = { number: 30, url: "https://github.com/acme/widgets/pull/30", branch: "gary/fix-1", run: "r1", startedBy: "routine", at: "2026-11-18T09:00:00Z" };
s = f.fixStateOf("issue-1", { ...none, records: { "issue-1": [record] }, snapshot: { "issue-1": { closingPrs: [closing(30, "open", true)] }, "pr-30": { title: "Fresh title", isDraft: false, ci: "passing", author: "widgets-bot" } } });
t.check("the record and GitHub agree on one PR, with the live fields of its snapshot entry", s.state === "open" && s.pr.title === "Fresh title" && s.pr.ci === "passing" && s.startedBy === "routine" && s.since === record.at, s);
s = f.fixStateOf("issue-1", { ...none, records: { "issue-1": [record] }, snapshot: { "issue-1": { closingPrs: [closing(30, "closed"), closing(31, "merged")] } } });
t.check("GitHub's state wins over the record, and a merged PR over a closed one", s.state === "merged" && s.pr.number === 31 && s.startedBy === "other", s);
s = f.fixStateOf("issue-1", { ...none, records: { "issue-1": [record] }, snapshot: { "issue-1": { closingPrs: [closing(31, "closed")] } } });
t.check("a recorded PR GitHub does not show still blocks", s.state === "open" && s.pr.number === 30 && !!f.fixBlock(s), s);

// gary fix-record and the snapshot
let r = gary("fix-record", "issue-23", "--pr", "19", "--branch", "gary/fix-issue-23", "--run", "run-1", "--by", "routine");
t.check("fix-record writes the record", r.status === 0 && json(r).url === "https://github.com/acme/widgets/pull/19" && JSON.parse(readFileSync(join(home, "state", "fixes.json"), "utf8"))["issue-23"][0].branch === "gary/fix-issue-23", r.stdout + r.stderr);
r = gary("fix-record", "issue-23", "--pr", "19", "--branch", "b", "--run", "run-1", "--by", "someone");
t.check("fix-record checks --by", r.status !== 0 && /--by must be one of routine, maintainer/.test(r.stderr + r.stdout), r.stderr);
r = gary("snapshot");
const out = json(r);
const pr19 = out.changed?.find((e) => e.id === "pr-19");
t.check("a recorded draft fix PR stays in the snapshot with garyFix", pr19?.isDraft === true && JSON.stringify(pr19.garyFix) === '{"itemId":"issue-23"}', pr19 ?? out);
t.check("other drafts stay out", !out.changed?.some((e) => e.id === "pr-24"));
const disc35 = out.changed?.find((e) => e.id === "disc-35");
t.check("a discussion gets the PRs that reference it by URL", disc35?.referencingPrs?.length === 1 && disc35.referencingPrs[0].number === 21 && disc35.referencingPrs[0].ci === "passing", disc35?.referencingPrs);
t.check("a #number reference counts, other repos do not", JSON.stringify(out.changed?.find((e) => e.id === "disc-31")?.referencingPrs?.map((p) => p.number)) === "[40]");

let fx = json(gary("fixes", "--json"));
t.check("gary fixes: a recorded draft PR", fx["issue-23"]?.state === "draft" && fx["issue-23"].pr.number === 19 && fx["issue-23"].startedBy === "routine" && fx["issue-23"].pr.ci === "pending", fx["issue-23"]);
t.check("gary fixes: GitHub's closing PR", fx["issue-22"]?.state === "open" && fx["issue-22"].pr.number === 12 && fx["issue-22"].startedBy === "other", fx["issue-22"]);
t.check("gary fixes: a discussion found through a reference", fx["disc-35"]?.state === "open" && fx["disc-35"].pr.number === 21 && fx["disc-31"]?.state === "closed", fx);
r = gary("fixes");
t.check("the plain list names state and PR", /issue-23\s+draft\s+PR #19 Fix the red LED \(started by the routine/.test(r.stdout), r.stdout);

// The block on a second fix
r = gary("put", "items", "issue-23", file(withFix("issue", 23)));
t.check("the validator refuses a fix route while the fix PR is a draft", r.status === 1 && /already open as draft PR #19/.test(r.stdout), r.stdout);
r = gary("put", "items", "disc-35", file(withFix("discussion", 35)));
t.check("the validator refuses a fix route while a referencing PR is open", r.status === 1 && /already open as PR #21/.test(r.stdout), r.stdout);
r = gary("put", "items", "disc-31", file(withFix("discussion", 31)));
t.check("a closed fix PR does not block", r.status === 0, r.stdout + r.stderr);
r = gary("claim", "issue-23", "fix", "--run", "hourly");
t.check("claiming a fix is refused while the fix PR is a draft", r.status === 3 && /already open as draft PR #19/.test(json(r).error), r.stdout);
r = gary("claim", "disc-31", "fix", "--run", "hourly");
t.check("claiming a fix with only a closed PR works", r.status === 0, r.stdout);
fx = json(gary("fixes", "--json"));
t.check("a claimed fix is working, started by the routine", fx["disc-31"]?.state === "working" && fx["disc-31"].startedBy === "routine", fx["disc-31"]);
r = gary("put", "items", "disc-31", file(withFix("discussion", 31)));
t.check("the validator refuses a fix route while a fix runs", r.status === 1 && /already running, started by the routine/.test(r.stdout), r.stdout);
gary("release", "disc-31", "fix", "--run", "hourly");
mkdirSync(join(home, "state", "board", "actions"), { recursive: true });
writeFileSync(join(home, "state", "board", "actions", "issue-60-1.json"), JSON.stringify({ itemId: "issue-60", action: "start_fix", status: "queued", via: "queue", createdAt: "2026-11-18T12:00:00Z" }));
fx = json(gary("fixes", "--json"));
t.check("a queued Start fix is working, started by the maintainer", fx["issue-60"]?.state === "working" && fx["issue-60"].startedBy === "maintainer", fx["issue-60"]);
r = gary("claim", "issue-60", "fix", "--run", "hourly");
t.check("the routine cannot claim a fix the maintainer queued", r.status === 3 && /queued as issue-60-1/.test(json(r).error), r.stdout);
r = gary("claim", "issue-60", "fix", "--run", "request-1", "--request", "issue-60-1");
t.check("the request worker for that request can", r.status === 0, r.stdout);

// fixFor is code-owned
r = gary("put", "items", "pr-19", file({ ...BASE, kind: "pr", number: 19, url: "https://github.com/acme/widgets/pull/19", fixFor: { itemId: "issue-1", ref: "x/y#1" } }));
t.check("a fix PR item gets fixFor from the record", r.status === 0 && JSON.stringify(JSON.parse(readFileSync(join(items, "pr-19.json"), "utf8")).fixFor) === '{"itemId":"issue-23","ref":"acme/widgets#19"}', r.stdout + r.stderr);
r = gary("put", "items", "pr-12", file({ ...BASE, kind: "pr", number: 12, url: "https://github.com/acme/widgets/pull/12", fixFor: { itemId: "issue-1", ref: "acme/widgets#12" } }));
t.check("other PRs lose a fixFor the doc claims", r.status === 0 && JSON.parse(readFileSync(join(items, "pr-12.json"), "utf8")).fixFor === undefined, r.stdout);
r = gary("put", "--merge", "items", "issue-22", file({ ...BASE, kind: "issue", number: 22, url: "https://github.com/acme/widgets/issues/22", fixFor: { itemId: "issue-1", ref: "acme/widgets#1" }, hint: "x", routes: [{ id: "r1", type: "open", title: "x", recommended: true }] }));
t.check("fixFor is only for PRs", r.status === 1 && /fixFor is only for PRs/.test(r.stdout), r.stdout);

rmSync(join(home, "state", "claims"), { recursive: true, force: true });
removeDir(T);
t.done();
