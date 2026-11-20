// The reconcile pass: edit proposals, their accept and dismiss path, the request button and when a pass is due.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, PROFILE, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("reconcile");
const T = tempDir();
// A writable copy of the fixture profile, as its own git repository with a bare remote
const profile = join(T, "profile");
cpSync(PROFILE, profile, { recursive: true });
const remote = join(T, "remote.git");
execFileSync("git", ["init", "-q", "--bare", remote]);
const git = (...args) => execFileSync("git", ["-C", profile, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" });
git("init", "-q");
const RULES = {
	"rules/classification.md": "# widgets: classification rules\n\n## Old sections\n\nPut config PRs into `easy`.\n\nPut config PRs into `easy`.\n\n## Labels\n\nLabel rule.\n",
	"rules/review.md": "# widgets: review rules\n\n## Style\n\n- Flag tabs in YAML files.\n- Ask for a test on every bug fix.\n- Ask for a changelog entry.\n",
	"rules/voice.md": "# widgets: voice rules\n\n## Replies\n\nKeep replies short.\n\nKeep replies short and friendly.\n",
};
for (const [f, text] of Object.entries(RULES)) writeFileSync(join(profile, f), text);
writeFileSync(join(T, "outside.md"), "Outside rule.\n");
symlinkSync(join(T, "outside.md"), join(profile, "rules", "linked.md"));
git("add", "-A");
git("commit", "-q", "-m", "init");
git("remote", "add", "origin", remote);
git("push", "-q", "origin", "HEAD:refs/heads/main");
const remoteHead = () => execFileSync("git", ["-C", remote, "rev-parse", "main"], { encoding: "utf8" }).trim();
const pushedHead = remoteHead();

const port = await freePort();
const { home, root, env: baseEnv } = makeHome(T, { profile, port });
const env = { ...baseEnv, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
writeFileSync(join(root, "personal.md"), "# Personal rules\n\nNo emoji.\n\nNever use emoji.\n");
const BOARD = join(home, "state", "board");
mkdirSync(join(BOARD, "proposals"), { recursive: true });
const gary = (...args) => spawnSync(process.execPath, [GARY, "--instance", "widgets", ...args], { env, encoding: "utf8" });
const read = (f) => readFileSync(join(profile, f), "utf8");
const proposalDoc = (id) => JSON.parse(readFileSync(join(BOARD, "proposals", id + ".json"), "utf8"));
let n = 0;
const putFile = (data) => {
	const f = join(T, `p${++n}.json`);
	writeFileSync(f, JSON.stringify(data));
	return f;
};
const edit = (id, extra) => ({
	id, createdAt: "2026-11-20T08:00:00Z", kind: "edit", title: "Name the category land", why: "The rule names the old section easy.", finding: "stale",
	evidence: [{ type: "name", gist: "easy is no category since round 19", file: "rules/classification.md", quote: "into `easy`" }],
	target: "profile", file: "rules/classification.md", before: "Put config PRs into `easy`.", after: "Put config PRs into `land`.", status: "open", decidedAt: null, reason: "", ...extra,
});
const put = (p) => gary("put", "proposals", p.id, putFile(p));
// Writes a proposal doc past the validator, for the server's own checks
const plant = (p) => writeFileSync(join(BOARD, "proposals", p.id + ".json"), JSON.stringify(p));

// gary put proposals
let r = put(edit("reconcile-twice"));
t.check("put refuses an edit whose before occurs twice", r.status === 1 && /more than once/.test(r.stdout), r.stdout + r.stderr);
r = put(edit("reconcile-none", { before: "No such rule." }));
t.check("put refuses an edit whose before occurs nowhere", r.status === 1 && /nowhere/.test(r.stdout), r.stdout);
r = put(edit("reconcile-escape", { file: "../config.json" }));
t.check("put refuses a file outside rules and templates", r.status === 1 && /rules\/<topic>.md/.test(r.stdout), r.stdout);
r = put(edit("reconcile-extra", { heading: "## Old sections", finding: "taste", evidence: [] }));
t.check("put lists every problem of an edit proposal", r.status === 1 && /no field \\"heading/.test(r.stdout) && /finding/.test(r.stdout) && /evidence/.test(r.stdout), r.stdout);
r = put(edit("reconcile-same", { before: "Label rule.", after: "Label rule." }));
t.check("put refuses an edit that changes nothing", r.status === 1 && /differ/.test(r.stdout), r.stdout);
r = put(edit("reconcile-delete", { title: "Drop the changelog rule", finding: "vague", file: "rules/review.md", before: "- Ask for a changelog entry.\n", after: "" }));
t.check("put writes a delete", r.status === 0, r.stdout + r.stderr);
r = put(edit("reconcile-voice", { title: "Merge the two reply rules", finding: "duplicate", file: "rules/voice.md", before: "Keep replies short.\n\nKeep replies short and friendly.", after: "Keep replies short and friendly." }));
t.check("put writes an edit whose before occurs once", r.status === 0, r.stdout + r.stderr);
// A merge across two files: one delete and one edit, decided together
r = put(edit("reconcile-merge-a", { title: "Keep the test rule in one place", finding: "duplicate", file: "rules/review.md", before: "- Ask for a test on every bug fix.", after: "- Ask for a test on every bug fix, also in config PRs.", group: "merge-tests" }));
const okA = r.status === 0;
r = put(edit("reconcile-merge-b", { title: "Keep the test rule in one place", finding: "duplicate", file: "rules/classification.md", before: "## Labels\n\nLabel rule.\n", after: "## Labels\n\nLabel rule. Tests: see review.md.\n", group: "merge-tests" }));
t.check("put writes both members of a group", okA && r.status === 0, r.stdout);
// A group with one stale member, which must change nothing
put(edit("reconcile-stale-a", { title: "Stale pair", file: "rules/voice.md", before: "## Replies", after: "## Answers", group: "stale-pair" }));
put(edit("reconcile-stale-b", { title: "Stale pair", file: "rules/review.md", before: "- Flag tabs in YAML files.", after: "- Flag tabs in YAML and JSON files.", group: "stale-pair" }));
put(edit("reconcile-dismiss-a", { title: "Pair to dismiss", file: "rules/review.md", before: "## Style", after: "## Code style", group: "dismiss-pair" }));
put(edit("reconcile-dismiss-b", { title: "Pair to dismiss", file: "rules/voice.md", before: "## Replies", after: "## Reply style", group: "dismiss-pair" }));
r = put(edit("reconcile-personal", { title: "Merge the emoji rules", finding: "duplicate", target: "personal", file: "personal.md", before: "No emoji.\n\nNever use emoji.", after: "Never use emoji." }));
t.check("put writes a personal edit", r.status === 0, r.stdout + r.stderr);
// Planted past the validator: a symlink out of the profile, a file outside the allowed ones, a file that changed
plant(edit("reconcile-link", { file: "rules/linked.md", before: "Outside rule.", after: "Changed." }));
plant(edit("reconcile-outside", { file: "../profile.json", before: "{", after: "[" }));
put(edit("reconcile-later", { title: "Label rule wording", file: "rules/classification.md", before: "Label rule.", after: "Label every PR." }));

const stub = join(T, "stub.json");
writeFileSync(stub, JSON.stringify({ "*": { state: "OPEN" } }));
const server = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--port", String(port)], { env: { ...env, GARY_GUARD_STUB: stub }, stdio: ["ignore", "inherit", "pipe"] });
let stderr = "";
server.stderr.on("data", (d) => (stderr += d));
for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await sleep(100);
const token = readFileSync(join(root, "state", "server-token"), "utf8").trim();
const api = async (body) => {
	const res = await fetch(`http://127.0.0.1:${port}/api/action`, { method: "POST", headers: { "X-Board-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ instance: "widgets", ...body }) });
	return { status: res.status, data: await res.json() };
};
const accept = (proposalId) => api({ action: "accept_proposal", proposalId });
const log = () => {
	try {
		return readFileSync(join(home, "state", "decisions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};
const commits = () => Number(git("rev-list", "--count", "HEAD").trim());

try {
	// One edit
	let before = commits();
	r = await accept("reconcile-voice");
	t.check("an edit whose before occurs once applies", r.data.ok && read("rules/voice.md") === "# widgets: voice rules\n\n## Replies\n\nKeep replies short and friendly.\n", [r.data, read("rules/voice.md")]);
	t.check("the edit commits that one file", r.data.committed === true && commits() === before + 1 && git("log", "-1", "--format=%s").trim() === "Reconcile rules: Merge the two reply rules" && git("show", "--name-only", "--format=", "HEAD").trim() === "rules/voice.md", git("log", "--oneline"));
	t.check("the edit is accepted", proposalDoc("reconcile-voice").status === "accepted" && !!proposalDoc("reconcile-voice").decidedAt);
	t.check("nothing is pushed", remoteHead() === pushedHead && git("status", "--porcelain").trim() === "");

	// A delete
	r = await accept("reconcile-delete");
	t.check("a delete removes the block", r.data.ok && read("rules/review.md") === "# widgets: review rules\n\n## Style\n\n- Flag tabs in YAML files.\n- Ask for a test on every bug fix.\n", read("rules/review.md"));

	// A grouped pair: both files in one commit
	before = commits();
	r = await accept("reconcile-merge-b");
	t.check("accepting one member applies the whole group", r.data.ok && /also in config PRs/.test(read("rules/review.md")) && /Tests: see review\.md/.test(read("rules/classification.md")), r.data);
	t.check("the group is one commit with both files", commits() === before + 1 && git("show", "--name-only", "--format=", "HEAD").trim().split("\n").sort().join() === "rules/classification.md,rules/review.md", git("show", "--name-only", "--format=", "HEAD"));
	t.check("both members are accepted", proposalDoc("reconcile-merge-a").status === "accepted" && proposalDoc("reconcile-merge-b").status === "accepted" && r.data.ids?.join() === "reconcile-merge-a,reconcile-merge-b", r.data.ids);

	// The same block twice, then nowhere: refused, nothing changes
	const twice = read("rules/classification.md").replace("Label rule. Tests", "Label rule.\n\nLabel rule. Tests");
	writeFileSync(join(profile, "rules", "classification.md"), twice);
	before = commits();
	r = await accept("reconcile-later");
	t.check("an edit whose before now occurs twice is refused", r.data.ok === false && r.data.result === "The file changed since this proposal. Run reconcile again." && read("rules/classification.md") === twice && proposalDoc("reconcile-later").status === "open", r.data);
	writeFileSync(join(profile, "rules", "classification.md"), twice.replaceAll("Label rule.", "Label this."));
	r = await accept("reconcile-later");
	t.check("an edit whose before now occurs nowhere is refused", r.data.ok === false && /Run reconcile again/.test(r.data.result) && proposalDoc("reconcile-later").status === "open" && commits() === before, r.data);

	// A group with one stale member: neither file changes
	writeFileSync(join(profile, "rules", "review.md"), read("rules/review.md").replace("- Flag tabs in YAML files.", "- Flag tabs in YAML files, please."));
	const voice = read("rules/voice.md");
	const review = read("rules/review.md");
	r = await accept("reconcile-stale-a");
	t.check("a group with one stale member is refused as a whole", r.data.ok === false && /Run reconcile again/.test(r.data.result) && read("rules/voice.md") === voice && read("rules/review.md") === review, r.data);
	t.check("both members of the refused group stay open", proposalDoc("reconcile-stale-a").status === "open" && proposalDoc("reconcile-stale-b").status === "open");

	// Paths
	r = await accept("reconcile-link");
	t.check("a symlink out of the profile is refused", r.data.ok === false && /symlink/.test(r.data.result) && readFileSync(join(T, "outside.md"), "utf8") === "Outside rule.\n", r.data);
	r = await accept("reconcile-outside");
	t.check("a file outside rules and templates is refused", r.data.ok === false && /invalid/.test(r.data.result) && proposalDoc("reconcile-outside").status === "open", r.data);
	r = await accept("reconcile-personal");
	t.check("a personal edit applies to personal.md without a commit", r.data.ok && r.data.committed === false && readFileSync(join(root, "personal.md"), "utf8") === "# Personal rules\n\nNever use emoji.\n", r.data);

	// Dismissal of a group
	r = await api({ action: "dismiss_proposal", proposalId: "reconcile-dismiss-a", text: "I like the headings" });
	t.check("dismissing one member dismisses the group with the reason", r.data.ok && ["reconcile-dismiss-a", "reconcile-dismiss-b"].every((id) => proposalDoc(id).status === "dismissed" && proposalDoc(id).reason === "I like the headings"), r.data);
	await sleep(100);
	const dismissed = log().filter((e) => e.type === "dismissed_proposal");
	t.check("each dismissed member is logged with its file and group", dismissed.length === 2 && dismissed.every((e) => e.proposal.kind === "edit" && e.proposal.group === "dismiss-pair" && e.reason === "I like the headings" && /^rules\//.test(e.proposal.file)), dismissed);
	r = await accept("reconcile-dismiss-b");
	t.check("a dismissed member cannot be accepted", r.status === 409, r);
	t.check("still nothing is pushed", remoteHead() === pushedHead);

	// The board's request button
	r = await api({ action: "request_reconcile" });
	const state = JSON.parse(readFileSync(join(home, "state", "reconcile.json"), "utf8"));
	t.check("request_reconcile records the request", r.data.ok && state.requestedAt === r.data.requestedAt, [r.data, state]);
} finally {
	server.kill("SIGTERM");
}

// The queue watcher prints the request once, until a pass ran
const queue = () => spawnSync(process.execPath, [GARY, "watch-queue", "--all", "--once"], { env, encoding: "utf8", timeout: 20000 }).stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
let lines = queue().filter((l) => l.action === "reconcile");
t.check("the queue watcher prints a reconcile request", lines.length === 1 && lines[0].instance === "widgets" && lines[0].itemId === null, lines);

// When a pass is due
const due = () => JSON.parse(gary("reconcile", "due", "--json").stdout);
const reconcileFile = join(home, "state", "reconcile.json");
const writeState = (data) => writeFileSync(reconcileFile, JSON.stringify(data));
writeState({});
let d = due();
t.check("without a pass both triggers fire", d.due && d.reasons.includes("interval") && d.reasons.includes("names"), d);
r = gary("reconcile", "start");
t.check("start marks the pass", r.status === 0 && due().due === false && due().running === true, r.stdout);
r = gary("reconcile", "start");
t.check("a second start is refused while the pass runs", r.status === 3, r.stdout);
r = gary("reconcile", "done", "--until", "2026-11-20T07:00:00Z");
d = due();
t.check("after the pass nothing is due", r.status === 0 && d.due === false && d.reasons.length === 0 && d.reviewedUntil === "2026-11-20T07:00:00Z", [r.stdout, d]);
const stored = JSON.parse(readFileSync(reconcileFile, "utf8"));
t.check("the pass stores the names and their hash", stored.names.includes("category:land") && stored.namesHash === d.namesHash, stored);

// The 7-day trigger fires once
writeState({ ...stored, lastReconcileAt: new Date(Date.now() - 8 * 86400000).toISOString() });
d = due();
t.check("8 days after the last pass the interval fires", d.due && d.reasons.join() === "interval", d);
gary("reconcile", "start");
gary("reconcile", "done");
t.check("and not again after that pass", due().due === false, due());

// The name trigger fires once
const now = JSON.parse(readFileSync(reconcileFile, "utf8"));
writeState({ ...now, names: [...now.names, "section:easy", "routeType:snooze"].sort() });
d = due();
t.check("a name the last pass knew and the code no longer has fires the name trigger", d.due && d.reasons.join() === "names" && d.removed.join() === "routeType:snooze,section:easy", d);
r = gary("reconcile", "names", "--json");
const names = JSON.parse(r.stdout);
t.check("reconcile names lists the gone names and the retired sections", names.removed.join() === "routeType:snooze,section:easy" && names.retired.section.easy === "category land" && names.current.category.join() === "act,unblock,land,decide", names);
gary("reconcile", "start");
gary("reconcile", "done");
t.check("and not again after that pass", due().due === false, due());
t.check("a finished pass ends the queued request", queue().every((l) => l.action !== "reconcile"));

// A request from the command line
r = gary("reconcile");
d = due();
t.check("gary reconcile asks for a pass", r.status === 0 && d.due && d.reasons.join() === "requested", d);
lines = queue().filter((l) => l.action === "reconcile");
t.check("which the queue watcher prints", lines.length === 1, lines);

await sleep(100);
removeDir(T);
t.done();
