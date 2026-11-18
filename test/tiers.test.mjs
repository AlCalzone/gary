// The item's `wants` and `gary wants`, the rules fields of meta.json, and the shadow comparison of the fast tier.
// Runs offline against the fake gh. The root's port 9 makes `gary put` write directly.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

// autofix and the format route
const fmt = (over = {}) => ({ ...BASE, number: 14, reviewedSha: "c".repeat(40), autofix: { changes: true, files: 2, lines: 9, tools: ["prettier"] }, hint: "Format: run the autofix", routes: [{ id: "r1", type: "format", title: "Format: run the autofix", as: "agent", recommended: true }], ...over });
r = gary("put", "items", "pr-14", file(fmt()));
t.check("a format route on a contributor PR with autofix changes is written", r.status === 0, r.stdout + r.stderr);
r = gary("put", "items", "pr-14", file(fmt({ autofix: { changes: false, files: 0, lines: 0, tools: ["prettier"] } })));
t.check("a format route needs autofix changes", r.status === 1 && /autofix check to have found changes/.test(r.stdout), r.stdout);
r = gary("put", "items", "pr-14", file(fmt({ autofix: undefined })));
t.check("a format route needs autofix", r.status === 1 && /autofix check to have found changes/.test(r.stdout), r.stdout);
r = gary("put", "items", "pr-14", file(fmt({ routes: [{ id: "r1", type: "format", title: "Format: run the autofix", as: "agent", recommended: true, text: "x", params: { a: 1 } }] })));
t.check("a format route has no text and no params", r.status === 1 && /a format route has no text and no params/.test(r.stdout), r.stdout);
r = gary("put", "items", "pr-14", file(fmt({ routes: [{ id: "r1", type: "format", title: "Format: run the autofix", as: "bot", recommended: true }] })));
t.check("a format route runs only as the agent", r.status === 1 && /is not allowed for format/.test(r.stdout), r.stdout);
r = gary("put", "items", "pr-14", file(fmt({ autofix: { changes: true, files: "2", lines: 9, tools: [] } })));
t.check("autofix is checked", r.status === 1 && /autofix must be/.test(r.stdout), r.stdout);
r = gary("put", "items", "pr-14", file(fmt({ autofix: { changes: true, files: 0, lines: 0, tools: ["prettier"] } })));
t.check("autofix changes must match its files", r.status === 1 && /changes must be true exactly when files is above 0/.test(r.stdout), r.stdout);
r = gary("put", "items", "issue-22", file({ ...BASE, kind: "issue", number: 22, autofix: { changes: false, files: 0, lines: 0, tools: [] } }));
t.check("autofix is only for PRs", r.status === 1 && /autofix is only for PRs/.test(r.stdout), r.stdout);
const nobot = makeHome(join(T, "nobot"), { bot: null });
r = spawnSync(process.execPath, [GARY, "put", "items", "pr-14", file(fmt())], { env: nobot.env, encoding: "utf8" });
t.check("a format route needs a bot or own-token pushes", r.status === 1 && /format needs a bot account or allowOwnTokenPushes/.test(r.stdout), r.stdout);
r = spawnSync(process.execPath, [GARY, "put", "items", "pr-14", file(fmt())], { env: makeHome(join(T, "own"), { bot: null, allowOwnTokenPushes: true }).env, encoding: "utf8" });
t.check("a format route works with own-token pushes", r.status === 0, r.stdout + r.stderr);
writeFileSync(join(home, "state", "board", "actions", "a-format.json"), JSON.stringify({ itemId: "pr-14", routeId: "r1", route: "format", action: "format", params: { reviewedSha: "c".repeat(40) }, text: "", status: "queued", via: "queue", createdAt: "2026-11-18T10:00:00Z" }));
r = gary("watch-queue", "--once");
t.check("watch-queue prints a format request like any agent request", r.stdout.trim() === JSON.stringify({ instance: "widgets", id: "a-format", itemId: "pr-14", action: "format" }), r.stdout + r.stderr);

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

// lastEventUrl on items
r = gary("put", "items", "pr-12", file({ ...BASE, url: "https://github.com/acme/widgets/pull/12", lastEventUrl: "https://github.com/acme/widgets/pull/12#issuecomment-9" }));
t.check("an item takes lastEventUrl in its own thread", r.status === 0, r.stdout + r.stderr);
for (const bad of ["https://github.com/acme/widgets/pull/120#issuecomment-9", "https://github.com/acme/widgets/pull/12", "https://example.com/x", 5]) {
	r = gary("put", "items", "pr-12", file({ ...BASE, url: "https://github.com/acme/widgets/pull/12", lastEventUrl: bad }));
	t.check(`lastEventUrl ${JSON.stringify(bad)} is refused`, r.status === 1 && /lastEventUrl must be a URL of the item's own thread/.test(r.stdout), r.stdout);
}

// handled: a maintainer field, kept on replace, cleared with a merge of null
const handled = { at: "2026-11-18T10:00:00Z", routeId: "r1", routeType: "reply", verified: null };
writeFileSync(join(items, "pr-12.json"), JSON.stringify({ ...BASE, handled }));
r = gary("put", "items", "pr-12", file({ ...BASE, priority: 2 }));
t.check("a replace keeps handled", r.status === 0 && JSON.stringify(JSON.parse(readFileSync(join(items, "pr-12.json"), "utf8")).handled) === JSON.stringify(handled), r.stdout + r.stderr);
r = gary("put", "--merge", "items", "pr-12", file({ handled: { ...handled, verified: "maybe" } }));
t.check("handled is validated", r.status === 1 && /handled must be \{ at, routeId, routeType, verified/.test(r.stdout), r.stdout);
r = gary("put", "--merge", "items", "pr-12", file({ handled: { ...handled, verified: "closed" } }));
t.check("handled takes a verified value", r.status === 0, r.stdout);
const snapPath = join(home, "state", "snapshot.pending.json");
const snap = JSON.parse(readFileSync(join(home, "state", "snapshot.json"), "utf8"));
snap.items["pr-12"] = { ...snap.items["pr-12"], updatedAt: "2026-11-18T09:00:00Z", lastEventAt: "2026-11-18T11:00:00Z" };
snap.items["pr-17"] = { ...snap.items["pr-17"], updatedAt: "2026-11-18T09:00:00Z", lastEventAt: null };
writeFileSync(snapPath, JSON.stringify(snap));
writeFileSync(join(items, "pr-17.json"), JSON.stringify({ ...BASE, number: 17, handled }));
writeFileSync(join(items, "pr-98.json"), JSON.stringify({ ...BASE, number: 98, handled }));
let hl = json(gary("handled", "--json"));
const hOf = (id) => hl.find?.((x) => x.id === id);
t.check("gary handled lists the handled items", Array.isArray(hl) && hl.length === 3 && hOf("pr-12").handled.verified === "closed" && !hl.some((x) => x.id === "issue-22"), hl);
t.check("changedSince is true for an event after handled.at", hOf("pr-12").changedSince === true);
t.check("changedSince is false without a later update or event", hOf("pr-17").changedSince === false, hOf("pr-17"));
t.check("changedSince is null without a snapshot entry", hOf("pr-98").changedSince === null);
r = gary("handled");
t.check("the plain list names the check and the change", /pr-12\s+reply\s+2026-11-18T10:00:00Z\s+verified: closed, changed since/.test(r.stdout) && /pr-98 .*not checked, not in the snapshot/.test(r.stdout) && /3 handled items/.test(r.stdout), r.stdout);
r = gary("put", "--merge", "items", "pr-12", file({ handled: null }));
t.check("a merge of null clears handled", r.status === 0 && JSON.parse(readFileSync(join(items, "pr-12.json"), "utf8")).handled === undefined, r.stdout);
rmSync(snapPath);
for (const id of ["pr-17", "pr-98"]) writeFileSync(join(items, `${id}.json`), JSON.stringify({ ...BASE, number: Number(id.slice(3)) }));

// effortMinutes
const { effortMinutes: _drop, ...noEffort } = BASE;
r = gary("put", "items", "pr-12", file(noEffort));
t.check("a missing effortMinutes names the allowed values", r.status === 1 && /effortMinutes is required: the minutes the maintainer needs, one of 1, 2, 5, 10, 15, 30, 60, 120/.test(r.stdout), r.stdout);
r = gary("put", "items", "pr-12", file({ ...BASE, effortMinutes: 45 }));
t.check("a wrong effortMinutes names the allowed values and the value", r.status === 1 && /one of 1, 2, 5, 10, 15, 30, 60, 120, not 45/.test(r.stdout), r.stdout);
r = gary("put", "items", "pr-12", file({ ...BASE, effortMinutes: 120 }));
t.check("120 minutes is allowed", r.status === 0, r.stdout);

// classifiedBy on items
r = gary("put", "items", "pr-12", file({ ...BASE, classifiedBy: "fast" }));
t.check("an item takes classifiedBy", r.status === 0, r.stdout + r.stderr);
r = gary("put", "items", "pr-12", file({ ...BASE, classifiedBy: "haiku" }));
t.check("classifiedBy is fast, standard or full", r.status === 1 && /classifiedBy must be one of fast, standard, full/.test(r.stdout), r.stdout);

// Sampling, the recent agreement warning and --week, in a fresh instance
const second = makeHome(join(T, "second"));
const g2 = (...args) => spawnSync(process.execPath, [GARY, ...args], { env: second.env, encoding: "utf8" });
const ago = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const pairsOf = (count, { days, sameSection = () => true, sampled = false, prefix = "x" }) => Array.from({ length: count }, (_, k) => [
	entry({ at: ago(days), run: `run-${prefix}`, itemId: `pr-${prefix}${k}`, section: sameSection(k) ? "easy" : "active", ...(sampled && { sampled: true }) }),
	entry({ at: ago(days), run: `run-${prefix}`, itemId: `pr-${prefix}${k}`, tier: "standard", model: "big" }),
]).flat();
r = g2("shadow", "record", file(entry({ sampled: "yes" })));
t.check("sampled must be a boolean", r.status === 1 && /sampled must be true or false/.test(r.stdout), r.stdout);
r = g2("shadow", "record", file([...pairsOf(10, { days: 20, prefix: "old" }), ...pairsOf(40, { days: 2, sameSection: (k) => k % 10 !== 0, sampled: true, prefix: "new" })]));
t.check("sampled entries are recorded", r.status === 0 && readFileSync(join(second.home, "state", "shadow.jsonl"), "utf8").includes('"sampled":true'), r.stdout);
rep = json(g2("shadow", "report", "--json"));
t.check("the report counts the sampled pairs", rep.pairs === 50 && rep.sampledPairs === 40, rep);
t.check("the recent agreement covers the last 40 pairs the fast tier decided", rep.recentSectionAgreement?.pairs === 40 && rep.recentSectionAgreement.same === 36 && rep.recentSectionAgreement.share === 0.9 && rep.recentSectionAgreement.warning === true, rep.recentSectionAgreement);
r = g2("shadow", "report");
t.check("the plain report says how many pairs came from sampling and warns", /^50 pairs, 40 of them from sampling/m.test(r.stdout) && /Warning: the fast tier picked the standard tier's section in only 36 of the last 40 pairs it decided itself \(90%, below 95%\)/.test(r.stdout), r.stdout);
rep = json(g2("shadow", "report", "--week", "--json"));
t.check("--week keeps the last 7 days", rep.pairs === 40 && Date.parse(rep.since) > Date.now() - 8 * 24 * 60 * 60 * 1000 && Date.parse(rep.since) < Date.now() - 6 * 24 * 60 * 60 * 1000, { pairs: rep.pairs, since: rep.since });
t.check("no warning at 95 percent or more", (() => {
	const third = makeHome(join(T, "third"));
	const g3 = (...args) => spawnSync(process.execPath, [GARY, ...args], { env: third.env, encoding: "utf8" });
	g3("shadow", "record", file(pairsOf(40, { days: 1, sameSection: (k) => k !== 0, prefix: "ok" })));
	const recent = json(g3("shadow", "report", "--json")).recentSectionAgreement;
	return recent.share === 0.975 && recent.warning === false && !/Warning/.test(g3("shadow", "report").stdout);
})());
r = g2("shadow", "report", "--week", "--since", ago(3));
t.check("--week and --since do not go together", r.status !== 0 && /not both/.test(r.stderr + r.stdout), r.stderr);

// Your decisions by tier: board items plus items the decision log names
const items2 = join(second.home, "state", "board", "items");
const stored = (id, classifiedBy, reviewedAt) => writeFileSync(join(items2, `${id}.json`), JSON.stringify({ ...BASE, classifiedBy, reviewedAt }));
for (let k = 0; k < 18; k++) stored(`issue-${k}`, "fast", ago(1));
stored("issue-90", "fast", ago(30));
stored("issue-91", "standard", ago(1));
stored("issue-92", undefined, ago(1));
const logEntry = (days, type, itemId, classifiedBy, extra = {}) => JSON.stringify({ at: ago(days), instance: "widgets", type, itemId, item: { kind: "issue", classifiedBy, reviewDepth: "quick" }, ...extra });
writeFileSync(join(second.home, "state", "decisions.jsonl"), [
	logEntry(1, "dismissed_route", "issue-1", "fast", { wasRecommended: true, route: { type: "reply" } }),
	logEntry(1, "dismissed_route", "issue-2", "fast", { wasRecommended: false, route: { type: "close" } }),
	logEntry(1, "chose_alternative", "issue-3", "fast"),
	logEntry(1, "edited_text", "issue-3", "fast"),
	logEntry(1, "edited_text", "pr-50", "fast"),
	logEntry(1, "chose_alternative", "issue-91", "standard"),
	logEntry(1, "snoozed", "issue-60", "full", { days: 3 }),
	logEntry(20, "chose_alternative", "issue-70", "fast"),
	logEntry(1, "agent_note", "issue-92", null, { text: "x" }),
].join("\n") + "\n");
rep = json(g2("shadow", "report", "--week", "--json"));
const fast = rep.decisions?.fast;
t.check("items per tier count board items reviewed in the window and items in the log", fast?.items === 19 && fast.itemIds.includes("pr-50") && !fast.itemIds.includes("issue-90") && !fast.itemIds.includes("issue-70"), fast);
t.check("decisions per tier count distinct items", fast?.dismissedRecommended.count === 1 && JSON.stringify(fast.dismissedRecommended.itemIds) === '["issue-1"]' && fast.choseAlternative.count === 1 && fast.editedText.count === 2 && JSON.stringify(fast.any.itemIds) === '["issue-1","issue-3","pr-50"]', fast);
t.check("rates are shares of the tier's items", fast?.any.rate === Math.round((3 / 19) * 1000) / 1000 && fast.tooFew === true, fast);
t.check("other tiers are counted apart", rep.decisions.standard.items === 1 && rep.decisions.standard.choseAlternative.count === 1 && rep.decisions.full.items === 1 && rep.decisions.full.any.count === 0, rep.decisions);
stored("issue-19", "fast", ago(1));
rep = json(g2("shadow", "report", "--week", "--json"));
t.check("20 items are enough", rep.decisions.fast.items === 20 && rep.decisions.fast.tooFew === false, rep.decisions.fast);
r = g2("shadow", "report", "--week");
t.check("the plain report prints the decisions by tier", /Your decisions by tier/.test(r.stdout) && /fast\s+20 items: dismissed the recommended route 1 \(5%\), chose another route 1 \(5%\), edited the text 2 \(10%\), any of these 3 \(15%\)/.test(r.stdout) && /standard\s+1 items/.test(r.stdout), r.stdout);
t.check("the plain report says when a tier has too few items", /standard .*\n\s+fewer than 20 items, too few to mean anything/.test(r.stdout) && !/fast .*\n\s+fewer than 20/.test(r.stdout), r.stdout);

removeDir(T);
t.done();
