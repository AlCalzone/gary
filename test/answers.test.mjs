// Answers to findings: the reanalyze action with input.answers, findingAnswers on the item, the decision log and the finding id.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, PROFILE, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { validateItem } from "../scripts/lib/validate-item.mjs";
import { findingKey } from "../scripts/lib/findings.mjs";
import { sinceAnchor } from "../scripts/lib/since.mjs";

const t = runner("answers");
const T = tempDir();
const port = await freePort();
const { home, root, env } = makeHome(T, { port });
const BOARD = join(home, "state", "board");
const profile = JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8"));

const findings = [
	{ id: "f1", severity: "question", text: "Does the device accept 0x00 here?" },
	{ severity: "minor", text: "The log line lacks the node id." },
	{ id: "f3", severity: "major", text: "A value of 200 passes the range check.", routeId: "r1" },
];
const item = {
	kind: "pr", repo: "acme/widgets", number: 12, title: "Item 12", url: "https://github.com/acme/widgets/pull/12", author: "octocat", authorType: "maintainer",
	section: "review", priority: 1, effortMinutes: 5, reviewDepth: "full", state: "Decide.", reviewedAt: "2026-11-17T14:00:00Z", labels: [],
	reviewedSha: "944d5aca1b70af1d87ca805b08639f3e17b83dcd", hint: "Change: check the range",
	routes: [{ id: "r1", type: "revise", as: "agent", title: "Change: check the range", text: "Reject values above 99.", recommended: true }],
	findings,
};
writeFileSync(join(BOARD, "items", "pr-12.json"), JSON.stringify(item));

// The finding id
const validate = (fs) => validateItem("pr-12", { ...item, findings: fs }, { mode: "bot", profile }).errors.map((e) => e.code);
t.check("the validator accepts findings with and without id", !validate(findings).includes("finding-id"), validate(findings));
t.check("the validator refuses a bad finding id", validate([{ id: "f 1", severity: "minor", text: "x" }]).includes("finding-id"));
t.check("the validator refuses a finding id used twice", validate([{ id: "f1", severity: "minor", text: "x" }, { id: "f1", severity: "minor", text: "y" }]).includes("finding-id"));
const key1 = findingKey(findings[1], 1);
t.check("a finding without id is keyed by index and text", /^#1-[0-9a-f]{8}$/.test(key1) && findingKey({ ...findings[1], text: "Other" }, 1) !== key1 && findingKey(findings[0], 0) === "f1", key1);

const stub = join(T, "stub.json");
writeFileSync(stub, JSON.stringify({ "*": { state: "OPEN" } }));
const server = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--port", String(port)], { env: { ...env, GARY_GUARD_STUB: stub }, stdio: ["ignore", "inherit", "pipe"] });
let stderr = "";
server.stderr.on("data", (d) => (stderr += d));
for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await sleep(100);
const token = readFileSync(join(root, "state", "server-token"), "utf8").trim();
const api = async (path, body) => {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? "POST" : "GET", headers: { "X-Board-Token": token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, data: await res.json() };
};
const reanalyze = (answers, extra = {}) => api("/api/action", { instance: "widgets", action: "reanalyze", itemId: "pr-12", input: { answers }, ...extra });
const stored = () => JSON.parse(readFileSync(join(BOARD, "items", "pr-12.json"), "utf8"));
const actionDocs = () => readdirSync(join(BOARD, "actions")).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(BOARD, "actions", n), "utf8")));
const log = () => {
	try {
		return readFileSync(join(home, "state", "decisions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};

try {
	const served = (await api("/api/state")).data.items.find((i) => i.id === "pr-12");
	t.check("served findings carry their key", served.findings.map((f) => f.key).join(",") === ["f1", key1, "f3"].join(","), served.findings);

	// Refusals
	const refused = [
		["an unknown finding", [{ finding: "f9", text: "Yes" }], /no longer has/],
		["an empty answer", [{ finding: "f1", text: "   " }], /empty/],
		["an answer over 4000 characters", [{ finding: "f1", text: "x".repeat(4001) }], /longer than 4000/],
		["a bot command", [{ finding: "f1", text: "Yes. @widgets-bot automerge" }], /bot command "@widgets-bot automerge"/],
		["two answers to one finding", [{ finding: "f1", text: "Yes" }, { finding: "f1", text: "No" }], /two answers/],
		["no answers", [], /at least one/],
		["an unknown field", [{ finding: "f1", text: "Yes", why: "x" }], /unknown field/],
	];
	for (const [label, answers, re] of refused) {
		const r = await reanalyze(answers);
		t.check(`${label} is refused`, r.data.ok === false && re.test(r.data.result), r);
	}
	let r = await api("/api/action", { instance: "widgets", action: "reanalyze", itemId: "pr-99", input: { answers: [{ finding: "f1", text: "Yes" }] } });
	t.check("an unknown item is outdated", r.data.outdated === true, r);
	t.check("refusals queue nothing and keep nothing", actionDocs().length === 0 && stored().findingAnswers === undefined, actionDocs());

	// A valid send
	r = await reanalyze([{ finding: "f1", text: "Yes, 0x00 means off." }, { finding: key1, text: " Not needed, the prefix has it. " }], { text: "Also check the tests." });
	t.check("valid answers are accepted", r.data.ok === true && /Sent 2 answers/.test(r.data.result), r);
	const docs = actionDocs();
	const doc = docs[0];
	t.check("one reanalyze is queued with the answers and the note", docs.length === 1 && doc.action === "reanalyze" && doc.status === "queued" && doc.via === "queue" && doc.text === "Also check the tests."
		&& doc.params.answers.length === 2 && doc.params.answers[0].finding === "f1" && doc.params.answers[0].findingText === findings[0].text && doc.params.answers[1].text === "Not needed, the prefix has it.", docs);
	let kept = stored().findingAnswers;
	t.check("the answers are kept on the item with the finding text and time", kept?.length === 2 && kept[0].finding === "f1" && kept[0].findingText === findings[0].text && kept[0].text === "Yes, 0x00 means off." && Number.isFinite(Date.parse(kept[0].at)) && kept[1].finding === key1, kept);
	await sleep(100);
	const answered = log().filter((e) => e.type === "answered_finding");
	t.check("each answer is logged as answered_finding", answered.length === 2 && answered[0].itemId === "pr-12" && answered[0].finding.key === "f1" && answered[0].finding.severity === "question" && answered[0].finding.text === findings[0].text && answered[0].text === "Yes, 0x00 means off.", answered);
	t.check("the note is logged as agent_note", log().some((e) => e.type === "agent_note" && e.text === "Also check the tests."), log());
	const anchor = sinceAnchor(stored(), docs);
	t.check("the send counts as the maintainer's last choice", anchor?.kind === "choice" && anchor.label === "Analyze again", anchor);

	// A page write cannot bring answers past the checks
	r = await api("/api/db", { op: "set", path: "actions/widgets/pr-12-1", data: { itemId: "pr-12", action: "reanalyze", params: { answers: [{ finding: "f9", text: "x" }] }, text: "", status: "queued", via: "queue", createdAt: new Date().toISOString() } });
	t.check("a page write with answers is refused", r.status === 400 && actionDocs().length === 1, r);

	// A re-review replaces the item and keeps the answers
	const rewritten = { ...item, reviewedAt: "2026-11-18T09:00:00Z", findings: [findings[0]] };
	const file = join(T, "pr-12.json");
	writeFileSync(file, JSON.stringify(rewritten));
	const put = spawnSync(process.execPath, [GARY, "put", "items", "pr-12", file], { env, encoding: "utf8" });
	kept = stored().findingAnswers;
	t.check("a replace keeps findingAnswers", put.status === 0 && kept?.length === 2 && stored().findings.length === 1, put.stdout + put.stderr);
	r = await reanalyze([{ finding: key1, text: "Again" }]);
	t.check("an answer to a finding the re-review dropped is refused", r.data.ok === false && /no longer has/.test(r.data.result), r);
	r = await reanalyze([{ finding: "f1", text: "Still yes." }]);
	t.check("a second answer to the same finding is appended", r.data.ok === true && /Sent 1 answer to/.test(r.data.result) && stored().findingAnswers.length === 3 && stored().findingAnswers[2].text === "Still yes.", stored().findingAnswers);
} finally {
	server.kill();
}
await sleep(200);
removeDir(T);
t.done();
