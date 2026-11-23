// The refresh after the maintainer opened an item on GitHub from the board: their review or comment there becomes `visited` and
// queues one reanalyze, with the mark time clamped and the focus hold intact. Runs offline against the fake gh.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { ownVisit } from "../scripts/lib/facts.mjs";

const t = runner("visit");
const T = tempDir();
const port = await freePort();
const { home, root, env } = makeHome(T, { port });
const itemsDir = join(home, "state", "board", "items");
const actionsDir = join(home, "state", "board", "actions");
const OVERRIDES = join(T, "overrides.json");
const LOG = join(T, "gh.log");
writeFileSync(LOG, "");

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const min = 60000;
const reviewedAt = iso(now - 180 * min);
const reviewAt = iso(now - 2 * min);
const user = (login) => ({ login, __typename: "User" });
const review = (state, at) => ({ author: user("octocat"), state, submittedAt: at, url: "https://github.com/acme/widgets/pull/18#pullrequestreview-9", body: "" });
writeFileSync(OVERRIDES, JSON.stringify({
	"pr-18": { reviews: { nodes: [review("APPROVED", reviewAt)] }, allReviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [review("APPROVED", reviewAt)] } },
	"pr-12": { state: "MERGED" },
	"issue-22": { timelineComments: { totalCount: 2, nodes: [
		{ author: user("octocat"), createdAt: iso(now - 3 * min), body: "Can you try 1.2?", url: "https://github.com/acme/widgets/issues/22#issuecomment-1" },
		{ author: user("hubot"), createdAt: iso(now - min), body: "Will do", url: "https://github.com/acme/widgets/issues/22#issuecomment-2" },
	] } },
}));

const pr = (number, extra = {}) => ({ kind: "pr", repo: "acme/widgets", number, title: `PR ${number}`, authorType: "contributor", reviewedAt, hint: "Approve: x", routes: [{ id: "r1", type: "review", as: "me", title: "Approve: x", recommended: true, params: { event: "approve" } }], ...extra });
const items = {
	"pr-1": pr(18),
	"pr-2": pr(18),
	"pr-3": pr(18),
	"pr-4": pr(18),
	"pr-5": pr(18),
	"pr-6": pr(18),
	"pr-7": pr(18),
	"pr-8": pr(18, { reviewedAt: iso(now - 30000) }),
	"pr-9": pr(18),
	"pr-10": pr(12),
	"issue-11": { kind: "issue", repo: "acme/widgets", number: 22, title: "Issue 22", reviewedAt, hint: "Reply: x", routes: [{ id: "r1", type: "reply", title: "Reply: x", recommended: true, text: "x" }] },
};
for (const [id, data] of Object.entries(items)) writeFileSync(join(itemsDir, id + ".json"), JSON.stringify(data));
const queue = (id, doc) => writeFileSync(join(actionsDir, id + ".json"), JSON.stringify({ status: "queued", via: "queue", createdAt: iso(now - min), finishedAt: null, result: "", text: "", params: {}, ...doc }));
queue("pr-6-reanalyze", { itemId: "pr-6", action: "reanalyze" });
mkdirSync(join(home, "state", "focus"), { recursive: true });
writeFileSync(join(home, "state", "focus", "pr-7.json"), JSON.stringify({ status: "active", harness: "t3code", how: "started", session: { id: "thread-7", link: null, title: "Focus: PR 18" }, startedAt: iso(now - 10 * min), lastActivity: iso(now - min) }));

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const item = (id) => read(join(itemsDir, id + ".json"));
const reanalyses = (id) => readdirSync(actionsDir).filter((n) => n.endsWith(".json")).map((n) => ({ id: n.slice(0, -5), ...read(join(actionsDir, n)) })).filter((a) => a.itemId === id && a.action === "reanalyze");

// The helper on its own
const timeline = [
	{ at: iso(now - 5 * min), author: "octocat", side: "us", kind: "comment" },
	{ at: iso(now - 4 * min), author: "OctoCat", side: "us", kind: "thread_comment" },
	{ at: iso(now - 3 * min), author: "hubot", side: "them", kind: "review" },
];
let v = ownVisit(timeline, [{ author: "octocat", state: "CHANGES_REQUESTED", submittedAt: iso(now - 4 * min) }], { me: "octocat", after: now - 10 * min });
t.check("the maintainer's newest inline comment counts as a review with the state of their review", v?.kind === "review" && v.state === "changes_requested" && v.at === iso(now - 4 * min), v);
v = ownVisit(timeline, [], { me: "octocat", after: now - 4.5 * min });
t.check("a review without a listed state has state null", v?.kind === "review" && v.state === null, v);
t.check("nothing of the maintainer's after the time gives null", ownVisit(timeline, [], { me: "octocat", after: now - 4 * min }) === null);
t.check("a comment gives kind comment", ownVisit(timeline.slice(0, 1), [], { me: "octocat", after: now - 10 * min })?.kind === "comment");
t.check("no login gives null", ownVisit(timeline, [], { me: null, after: now - 10 * min }) === null);

const child = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--port", String(port)], {
	env: { ...env, FAKE_GH_OVERRIDES: OVERRIDES, FAKE_GH_LOG: LOG },
	stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
try {
	for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await sleep(100);
	const token = readFileSync(join(root, "state", "server-token"), "utf8").trim();
	const refresh = async (itemId, markedAt) => {
		const res = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
			method: "POST",
			headers: { "X-Board-Token": token, "Content-Type": "application/json" },
			body: JSON.stringify({ instance: "widgets", itemId, ...(markedAt !== undefined && { markedAt }) }),
		});
		return { status: res.status, data: await res.json() };
	};
	const mark = iso(now - 10 * min);

	let r = await refresh("pr-1");
	t.check("a refresh without a mark records no visit and queues nothing", r.data.ok && r.data.result.visited === undefined && item("pr-1").visited === undefined && reanalyses("pr-1").length === 0, [r, stderr]);
	r = await refresh("pr-2", iso(Date.now() + 5 * min));
	t.check("a mark in the future is ignored", r.data.ok && item("pr-2").visited === undefined && reanalyses("pr-2").length === 0, r);
	r = await refresh("pr-3", iso(now - 130 * min));
	t.check("a mark older than 2 hours is ignored", r.data.ok && item("pr-3").visited === undefined && reanalyses("pr-3").length === 0, r);
	r = await refresh("pr-4", "yesterday");
	t.check("a mark that is no time is ignored", r.data.ok && item("pr-4").visited === undefined && reanalyses("pr-4").length === 0, r);

	r = await refresh("pr-5", mark);
	let v5 = item("pr-5").visited;
	let q5 = reanalyses("pr-5");
	t.check("the maintainer's approval after the mark and the analysis is recorded as visited", r.data.ok && v5?.at === reviewAt && v5.kind === "review" && v5.state === "approved" && r.data.result.visited?.state === "approved" && r.data.result.queued === true, [r, v5]);
	t.check("it queues exactly one reanalyze that names what the maintainer did", q5.length === 1 && q5[0].status === "queued" && q5[0].params.by === "github_visit" && q5[0].params.visited.at === reviewAt && /approved the PR on GitHub/.test(q5[0].text), q5);
	t.check("the item keeps its routes until the new analysis", item("pr-5").routes.length === 1 && item("pr-5").reviewedAt === reviewedAt);

	r = await refresh("pr-6", mark);
	t.check("with a reanalyze already queued it records the visit and queues no second one", r.data.ok && item("pr-6").visited?.at === reviewAt && r.data.result.queued === undefined && reanalyses("pr-6").length === 1, [r, reanalyses("pr-6")]);
	r = await refresh("pr-7", mark);
	t.check("an item in focus gets the visit and no reanalyze", r.data.ok && item("pr-7").visited?.at === reviewAt && reanalyses("pr-7").length === 0 && read(join(home, "state", "focus", "pr-7.json")).status === "active", [r, reanalyses("pr-7")]);
	r = await refresh("pr-8", mark);
	t.check("a review older than the last analysis is no visit", r.data.ok && item("pr-8").visited === undefined && reanalyses("pr-8").length === 0, r);
	r = await refresh("pr-9", iso(now - min));
	t.check("a review older than the mark is no visit", r.data.ok && item("pr-9").visited === undefined && reanalyses("pr-9").length === 0, r);
	r = await refresh("pr-10", mark);
	t.check("a merged PR is stored live and gets no visit", r.data.ok && r.data.result.state === "merged" && item("pr-10").live?.state === "merged" && item("pr-10").visited === undefined && reanalyses("pr-10").length === 0, r);
	r = await refresh("issue-11", mark);
	const v11 = item("issue-11").visited;
	t.check("the maintainer's comment on an issue is a comment visit, also when someone answered after it", r.data.ok && v11?.kind === "comment" && v11.state === null && v11.at === iso(now - 3 * min), v11);
	t.check("the reanalyze for a comment says the maintainer commented", reanalyses("issue-11").length === 1 && /and commented on GitHub/.test(reanalyses("issue-11")[0].text), reanalyses("issue-11"));

	// The same review after the first reanalyze finished queues nothing again
	const done = reanalyses("pr-5")[0];
	writeFileSync(join(actionsDir, done.id + ".json"), JSON.stringify({ ...read(join(actionsDir, done.id + ".json")), status: "done", finishedAt: iso(Date.now()) }));
	await sleep(20500);
	r = await refresh("pr-5", mark);
	t.check("the same review queues no second reanalyze", r.data.ok && r.data.result.queued === undefined && reanalyses("pr-5").length === 1 && item("pr-5").visited?.at === reviewAt, [r, reanalyses("pr-5")]);
	t.check("a refresh never writes to GitHub", !readFileSync(LOG, "utf8").includes("mutation"));
} finally {
	child.kill("SIGTERM");
	removeDir(T);
}
t.done();
