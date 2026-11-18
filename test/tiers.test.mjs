// The item's `wants` and `gary wants`, the rules fields of meta.json, and the shadow comparison of the fast tier.
// Runs offline against the fake gh. The root's port 9 makes `gary put` write directly.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ME } from "./fixtures/github.mjs";
import { GARY, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("tiers");
const T = tempDir();
const { home, env } = makeHome(T);
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
	writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data));
	return f;
};
const BASE = { repo: "acme/widgets", kind: "pr", number: 12, title: "t", url: "https://github.com/x", author: "a", authorType: "contributor", section: "easy", priority: 1, effortMinutes: 5, reviewDepth: "full", state: "Decide." };

// wants in the item validation
let r = gary("put", "items", "pr-12", file({ ...BASE, wants: { labels: { add: ["needs-info"] }, assignees: [ME] }, wantsReason: "The log is missing." }));
t.check("an item with wants inside autoLabels is written", r.status === 0 && json(r).ok === true, r.stdout + r.stderr);
r = gary("put", "items", "pr-12", file({ ...BASE, wants: { labels: { add: ["bug"] } }, wantsReason: "x" }));
t.check("wants may not name a label outside autoLabels", r.status === 1 && /may only name the profile.s autoLabels, not \\"bug/.test(r.stdout), r.stdout);
r = gary("put", "items", "pr-12", file({ ...BASE, wants: { labels: { remove: ["needs-info"] } } }));
t.check("wants needs wantsReason", r.status === 1 && /wantsReason is required with wants/.test(r.stdout), r.stdout);
r = gary("put", "items", "pr-12", file({ ...BASE, wantsReason: "x" }));
t.check("wantsReason needs wants", r.status === 1 && /wantsReason needs wants/.test(r.stdout), r.stdout);
r = gary("put", "items", "pr-12", file({ ...BASE, wants: { labels: { add: ["needs-info"], remove: ["Needs-Info"] } }, wantsReason: "x" }));
t.check("wants may not add and remove one label", r.status === 1 && /adds and removes/.test(r.stdout), r.stdout);
r = gary("put", "items", "pr-12", file({ ...BASE, wants: { milestone: "x" }, wantsReason: "x" }));
t.check("wants refuses other fields", r.status === 1 && /wants must be/.test(r.stdout), r.stdout);
r = gary("put", "--merge", "items", "pr-12", file({ wants: { labels: { add: ["wontfix"] } } }));
t.check("a merge that changes wants is validated", r.status === 1 && /not \\"wontfix/.test(r.stdout), r.stdout);

// gary wants against the staged snapshot
r = gary("wants", "--json");
t.check("gary wants without a snapshot lists the item as unknown", json(r).snapshot === null && JSON.stringify(json(r).unknown) === '["pr-12"]', r.stdout);
r = gary("snapshot");
t.check("the snapshot runs", r.status === 0, r.stderr);
writeFileSync(join(items, "pr-17.json"), JSON.stringify({ ...BASE, number: 17, wants: { labels: { add: ["needs-info"], remove: ["dependencies", "gone"] }, assignees: [ME.toUpperCase()] }, wantsReason: "Ready for a look." }));
writeFileSync(join(items, "issue-22.json"), JSON.stringify({ ...BASE, kind: "issue", number: 22 }));
writeFileSync(join(items, "pr-99.json"), JSON.stringify({ ...BASE, number: 99, wants: { assignees: [ME] }, wantsReason: "x" }));
let w = json(gary("wants", "--json"));
const pr12 = w.items?.find((i) => i.id === "pr-12");
const pr17 = w.items?.find((i) => i.id === "pr-17");
t.check("gary wants reads the staged snapshot", w.snapshot === "staged" && typeof w.fetchedAt === "string", w);
t.check("gary wants lists a label to add and an assignee", JSON.stringify(pr12?.labels) === '{"add":["needs-info"],"remove":[]}' && JSON.stringify(pr12.assignees) === `{"add":["${ME}"]}` && pr12.reason === "The log is missing.", pr12);
t.check("gary wants drops what GitHub already shows, ignoring case", JSON.stringify(pr17?.labels) === '{"add":["needs-info"],"remove":["dependencies"]}' && pr17.assignees.add.length === 0, pr17);
t.check("gary wants skips items without wants and lists items not in the snapshot", !w.items.some((i) => i.id === "issue-22") && JSON.stringify(w.unknown) === '["pr-99"]', w);
gary("snapshot", "--commit");
w = json(gary("wants", "--json"));
t.check("gary wants falls back to the baseline", w.snapshot === "baseline" && w.items.length === 2, w);
r = gary("wants");
t.check("gary wants prints one line per item", /pr-12\s+\+needs-info @octocat\s+The log is missing\./.test(r.stdout) && /pr-17\s+\+needs-info -dependencies/.test(r.stdout) && /2 items want changes, compared to the baseline snapshot/.test(r.stdout), r.stdout);

// meta.json
const metaFile = join(home, "state", "board", "meta.json");
r = gary("put", "meta", file({ lastRunAt: "2026-11-18T10:00:00Z", rulesHash: "sha256:abc", rulesPending: ["pr-12", "disc-31"] }));
t.check("put meta takes rulesHash and rulesPending", r.status === 0 && JSON.parse(readFileSync(metaFile, "utf8")).rulesHash === "sha256:abc", r.stdout + r.stderr);
r = gary("put", "meta", file({ rulesHash: "" }));
t.check("put meta refuses an empty rulesHash", r.status === 1 && /rulesHash must be a non-empty string/.test(r.stdout), r.stdout);
r = gary("put", "meta", file({ rulesPending: ["PR 12"] }));
t.check("put meta refuses an id that is not one", r.status === 1 && /rulesPending must be a list of item ids/.test(r.stdout) && JSON.parse(readFileSync(metaFile, "utf8")).rulesPending.length === 2, r.stdout);

// shadow record and report
const entry = (over) => ({ at: "2026-11-18T10:00:00Z", run: "run-1", itemId: "pr-12", repo: "acme/widgets", tier: "fast", model: "small", section: "easy", hasRoutes: true, recommendedType: "merge", handedUp: false, reason: "Clean and approved.", ...over });
r = gary("shadow", "record", file([
	entry(),
	entry({ tier: "standard", model: "big" }),
	entry({ itemId: "issue-22", recommendedType: "reply" }),
	entry({ itemId: "issue-22", tier: "standard", model: "big", section: "active", recommendedType: "request_logs", reason: "Needs a log first." }),
	entry({ itemId: "disc-31", section: null, hasRoutes: false, recommendedType: null, handedUp: true, reason: "Too long a thread." }),
	entry({ itemId: "disc-31", tier: "standard", model: "big", section: "active", recommendedType: "reply" }),
	entry({ itemId: "pr-17", tier: "standard", model: "big" }),
]));
t.check("shadow record appends valid entries", r.status === 0 && json(r).recorded === 7 && readFileSync(join(home, "state", "shadow.jsonl"), "utf8").trim().split("\n").length === 7, r.stdout + r.stderr);
r = gary("shadow", "record", file([entry({ run: "run-2" }), entry({ tier: "medium", handedUp: "no", extra: 1 })]));
const problems = json(r).problems ?? [];
t.check("shadow record refuses the whole file for one bad entry", r.status === 1 && problems.some((p) => /\[1\] tier must be one of fast, standard/.test(p)) && problems.some((p) => /\[1\] handedUp must be true or false/.test(p)) && problems.some((p) => /\[1\] unknown field "extra"/.test(p)) && readFileSync(join(home, "state", "shadow.jsonl"), "utf8").trim().split("\n").length === 7, problems);
r = gary("shadow", "record", file(entry({ tier: "standard", handedUp: true })));
t.check("only the fast tier hands up", r.status === 1 && /only the fast tier hands up/.test(r.stdout), r.stdout);
r = gary("shadow", "record", file(entry({ section: null })));
t.check("an answer needs a section", r.status === 1 && /section is required/.test(r.stdout), r.stdout);

let rep = json(gary("shadow", "report", "--json"));
t.check("shadow report pairs fast and standard per run and item", rep.pairs === 3 && rep.handedUp === 1 && rep.compared === 2, rep);
t.check("shadow report counts the agreement", rep.sectionAgreement?.same === 1 && rep.sectionAgreement.share === 0.5 && rep.routeAgreement.same === 1, rep);
const d = rep.disagreements ?? [];
t.check("shadow report lists the disagreements with both answers", d.length === 1 && d[0].itemId === "issue-22" && d[0].fast.recommendedType === "reply" && d[0].standard.recommendedType === "request_logs" && d[0].standard.reason === "Needs a log first.", d);
gary("shadow", "record", file([entry({ at: "2026-11-18T12:00:00Z", run: "run-2", itemId: "pr-12" }), entry({ at: "2026-11-18T12:01:00Z", run: "run-2", itemId: "pr-12", tier: "standard", model: "big" })]));
rep = json(gary("shadow", "report", "--since", "2026-11-18T11:00:00Z", "--json"));
t.check("shadow report --since keeps the later entries only", rep.pairs === 1 && rep.sectionAgreement.share === 1 && rep.disagreements.length === 0, rep);
r = gary("shadow", "report");
t.check("the plain report prints the counts and the disagreements", /^4 pairs/m.test(r.stdout) && /fast tier handed up: 1 \(25%\)/.test(r.stdout) && /same section:\s+2 of 3 \(67%\)/.test(r.stdout) && /issue-22 \(acme\/widgets\), run run-1/.test(r.stdout) && /standard active \/ request_logs \(big\): Needs a log first\./.test(r.stdout), r.stdout);
r = gary("shadow", "report", "--since", "yesterday");
t.check("shadow report refuses a bad --since", r.status !== 0 && /--since needs an ISO time/.test(r.stderr + r.stdout), r.stderr);

removeDir(T);
t.done();
