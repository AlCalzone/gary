// The fix PRs of an escalated discussion: the issue from the bot's comment, the move of the records, the one edit of
// the PR's body and what stops it. Runs on temp homes with the fake gh, so nothing reaches GitHub.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, PROFILE, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { bodyWithClosing, closesInText, issueInComments } from "../scripts/lib/escalation.mjs";
import { BOT, ME } from "./fixtures/github.mjs";

const t = runner("link-escalated");
const REPO = "acme/widgets";
const PATTERN = "^Escalated to an issue: #(\\d+)";

// ---------- the comment ----------
const said = (login, body, extra = {}) => ({ author: login === null ? null : { login }, body, createdAt: "2026-11-19T10:34:32Z", lastEditedAt: null, editor: null, ...extra });
const find = (...comments) => issueInComments(comments, { pattern: PATTERN, bot: BOT });
t.check("the bot's comment names the issue", find(said("hubot", "thanks"), said(BOT, "Escalated to an issue: #50")) === 50);
t.check("the bot's login ignores case", find(said("Widgets-Bot", "Escalated to an issue: #50")) === 50);
t.check("a look-alike by someone else is ignored", find(said("hubot", "Escalated to an issue: #666")) === null);
t.check("a look-alike by the maintainer is ignored", find(said(ME, "Escalated to an issue: #666")) === null);
t.check("a later look-alike does not win", find(said(BOT, "Escalated to an issue: #50"), said("hubot", "Escalated to an issue: #666")) === 50);
t.check("a login that only starts like the bot's is ignored", find(said(`${BOT}2`, "Escalated to an issue: #666")) === null && find(said(null, "Escalated to an issue: #666")) === null);
t.check("the bot's comment edited by someone else is ignored", find(said(BOT, "Escalated to an issue: #666", { lastEditedAt: "2026-11-19T11:00:00Z", editor: { login: "hubot" } })) === null);
t.check("the bot's comment edited by a deleted account is ignored", find(said(BOT, "Escalated to an issue: #666", { lastEditedAt: "2026-11-19T11:00:00Z" })) === null);
t.check("the bot's own edit counts", find(said(BOT, "Escalated to an issue: #50", { lastEditedAt: "2026-11-19T11:00:00Z", editor: { login: BOT } })) === 50);
t.check("a quote inside the bot's comment is ignored", issueInComments([said(BOT, "The reporter wrote: Escalated to an issue: #666")], { pattern: "Escalated to an issue: #(\\d+)", bot: BOT }) === null);
t.check("a group that holds no number is ignored", issueInComments([said(BOT, "Escalated to x")], { pattern: "^Escalated to (.+)", bot: BOT }) === null);
t.check("the newest result wins", find(said(BOT, "Escalated to an issue: #50"), said(BOT, "Escalated to an issue: #51"), said(BOT, "Follow-up: #52")) === 51);

// ---------- the body ----------
const DISC = "https://github.com/acme/widgets/discussions/36";
const add = (body) => bodyWithClosing(body, { repo: REPO, issue: 50, discussion: 36 });
t.check("the line follows the discussion's link", add(`What broke.\n\nRelated discussion: ${DISC}`) === `What broke.\n\nRelated discussion: ${DISC}\n\nfixes #50`);
t.check("a trailing newline stays", add(`Related discussion: ${DISC}\n`) === `Related discussion: ${DISC}\n\nfixes #50\n`);
t.check("text after the reference stays after it", add(`Reported in ${DISC}.\n\n## Tests\n`) === `Reported in ${DISC}.\n\nfixes #50\n\n## Tests\n`);
t.check("the line never splits a paragraph", add(`Reported in ${DISC},\nwith a log in \n\`log.txt\`\n\nMore`) === `Reported in ${DISC},\nwith a log in \n\`log.txt\`\n\nfixes #50\n\nMore`);
t.check("CRLF stays", add(`Reported in ${DISC}\r\n\r\nMore\r\n`) === `Reported in ${DISC}\r\n\r\nfixes #50\r\n\r\nMore\r\n`);
t.check("the link wins over an earlier and a later #number", add(`As in #36.\n\n${DISC}\n\nSee #36.`) === `As in #36.\n\n${DISC}\n\nfixes #50\n\nSee #36.`);
t.check("a #number works without a link", add("See discussion #36.\n\nMore, see #360 and other/repo#36.") === "See discussion #36.\n\nfixes #50\n\nMore, see #360 and other/repo#36.");
t.check("a reference inside code does not count", add(`Real: ${DISC}\n\n\`\`\`\n${DISC}\n\`\`\`\n`) === `Real: ${DISC}\n\nfixes #50\n\n\`\`\`\n${DISC}\n\`\`\`\n`);
t.check("the line stays out of a fence right after the reference", add(`Log from ${DISC}\n\`\`\`\nlog\n\`\`\``) === `Log from ${DISC}\n\nfixes #50\n\`\`\`\nlog\n\`\`\``);
t.check("without a reference the line goes to the end", add("What broke.") === "What broke.\n\nfixes #50" && add("What broke.\n") === "What broke.\n\nfixes #50" && add("") === "fixes #50");
const closes = (body) => closesInText(body, { repo: REPO, issue: 50 });
t.check("GitHub's closing forms count", ["fixes #50", "Fixes: #50", "Closes acme/widgets#50", "resolved https://github.com/acme/widgets/issues/50", "x\nFIX #50."].every(closes));
t.check("other issues and plain mentions do not count", !["fixes #500", "see #50", "fixes other/repo#50", "prefix #50", "`fixes #50`", "```\nfixes #50\n```", "<!-- fixes #50 -->"].some(closes));

// ---------- the command ----------
const open = (number) => [`pr-${number}`, { kind: "pr", number, author: BOT, isDraft: true }];
const record = (number) => ({ number, url: `https://github.com/acme/widgets/pull/${number}`, branch: `triage/disc-36-${number}`, run: "run-1", startedBy: "routine", at: "2026-11-18T09:00:00Z" });
const escalated = (issue, extra = []) => ({ closed: true, resultComments: { nodes: [said(ME, "@widgets-bot escalate"), said(BOT, `Escalated to an issue: #${issue}`), ...extra] } });
const issueRef = (number, repo = REPO) => ({ number, repository: { nameWithOwner: repo } });
const prNode = (number, extra = {}) => ({ id: `PR_${number}`, url: `https://github.com/acme/widgets/pull/${number}`, state: "OPEN", author: { login: BOT }, body: `What broke.\n\nRelated discussion: ${DISC}\n`, closingIssuesReferences: { nodes: [] }, ...extra });

/** A home with the fix records, the snapshot and what the fake GitHub answers. */
function setUp({ records = { "disc-36": [record(60)] }, current = [open(60)], baseline = null, github = {}, config = {}, profile } = {}) {
	const dir = tempDir();
	let profileDir = PROFILE;
	if (profile) {
		profileDir = join(dir, "profile");
		cpSync(PROFILE, profileDir, { recursive: true });
		writeFileSync(join(profileDir, "profile.json"), JSON.stringify(profile(JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8")))));
	}
	const { home, env } = makeHome(dir, { profile: profileDir, ...config });
	const state = join(home, "state");
	const file = (name, data) => writeFileSync(join(state, name), JSON.stringify(data));
	file("fixes.json", records);
	file("snapshot.pending.json", { items: Object.fromEntries(current) });
	if (baseline) file("snapshot.json", { items: baseline });
	const overrides = join(dir, "overrides.json");
	let answers = { "escalation-36": escalated(50), "escalated-issue-50": issueRef(50), "link-pr-60": prNode(60), ...github };
	const answer = (extra) => writeFileSync(overrides, JSON.stringify((answers = { ...answers, ...extra })));
	answer({});
	const writesFile = join(dir, "writes.log");
	const logFile = join(dir, "gh.log");
	const lines = (f) => {
		try {
			return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		} catch {
			return [];
		}
	};
	const gary = (...args) => spawnSync(process.execPath, [GARY, ...args], { env: { ...env, FAKE_GH_OVERRIDES: overrides, FAKE_GH_WRITES: writesFile, FAKE_GH_LOG: logFile }, encoding: "utf8" });
	const actionsDir = join(state, "board", "actions");
	return {
		dir, home, state, file, answer, gary,
		link: (...args) => {
			const r = gary("link-escalated", ...args);
			try {
				return { status: r.status, ...JSON.parse(r.stdout) };
			} catch {
				return { status: r.status, unparsed: r.stdout + r.stderr };
			}
		},
		reads: () => lines(logFile),
		writes: () => lines(writesFile),
		records: () => JSON.parse(readFileSync(join(state, "fixes.json"), "utf8")),
		actions: () => readdirSync(actionsDir).map((n) => JSON.parse(readFileSync(join(actionsDir, n), "utf8"))),
	};
}

// The whole move, once
let h = setUp();
mkdirSync(join(h.state, "drive"), { recursive: true });
h.file("drive/pr-60.json", { repo: REPO, number: 60, by: "fix", fixFor: "disc-36", stage: "watch", rounds: [] });
let r = h.link("--dry-run");
t.check("a dry run shows the edit", r.status === 0 && r.invocations?.length === 1 && r.invocations[0].as === BOT && r.invocations[0].stdin.variables.body.includes("\n\nfixes #50"), r);
t.check("a dry run writes nothing", h.writes().length === 0 && !!h.records()["disc-36"] && h.actions().length === 0 && JSON.parse(readFileSync(join(h.state, "drive", "pr-60.json"), "utf8")).fixFor === "disc-36");
r = h.link();
t.check("the escalated discussion is found", r.status === 0 && JSON.stringify(r.moved) === '[{"from":"disc-36","to":"issue-50","prs":[60]}]', r);
t.check("one body edit went out, as the bot", JSON.stringify(h.writes()) === JSON.stringify([{ mutation: "updatePullRequest", variables: { id: "PR_60", body: `What broke.\n\nRelated discussion: ${DISC}\n\nfixes #50\n` }, as: BOT }]), h.writes());
const added = h.writes()[0].variables.body.replace(prNode(60).body, "");
t.check("the edit adds no mention and no bot command", !/@|escalate/.test(added), added);
let rec = h.records();
t.check("the record is under the issue, with its origin and the link", !rec["disc-36"] && rec["issue-50"].length === 1 && rec["issue-50"][0].from === "disc-36" && typeof rec["issue-50"][0].linked === "string" && rec["issue-50"][0].startedBy === "routine", rec);
t.check("the drive names the issue", JSON.parse(readFileSync(join(h.state, "drive", "pr-60.json"), "utf8")).fixFor === "issue-50");
let docs = h.actions();
t.check("the PR and the issue each log the link once", docs.length === 2 && docs.map((a) => a.itemId).sort().join() === "issue-50,pr-60" && docs.every((a) => a.action === "link_issue" && a.status === "done" && a.as === BOT && a.params.issue === 50 && a.params.by === "fix" && a.text === "fixes #50"), docs);
const fixes = JSON.parse(h.gary("fixes", "--json").stdout);
t.check("gary fixes shows the PR for the issue and for the discussion", fixes["issue-50"]?.pr.number === 60 && fixes["issue-50"].parked === true && fixes["disc-36"]?.pr.number === 60, fixes);
const watched = JSON.parse(h.gary("pr-watch", "list", "--json").stdout);
t.check("the watch names the issue", JSON.stringify(watched).includes('"fixFor":"issue-50"'), watched);
t.check("the push claim is released", JSON.parse(h.gary("claims", "--json").stdout).length === 0);
const readsBefore = h.reads().length;
r = h.link();
t.check("a second run reads and writes nothing", r.status === 0 && !r.moved.length && !r.linked.length && h.writes().length === 1 && h.reads().length === readsBefore && h.actions().length === 2, r);
let out = h.gary("fix-record", "disc-36", "--pr", "60", "--branch", "b", "--run", "run-2", "--by", "routine");
rec = h.records();
t.check("recording the moved PR again keeps it under the issue", out.status === 0 && !rec["disc-36"] && rec["issue-50"][0].from === "disc-36" && !!rec["issue-50"][0].linked, rec);
// A lost record write leaves the edited body as the only trace
h.answer({ "link-pr-60": prNode(60, { body: h.writes()[0].variables.body }) });
h.file("fixes.json", { "issue-50": [{ ...record(60), from: "disc-36" }] });
r = h.link();
t.check("without the linked mark the text stops a second edit", r.status === 0 && r.linked[0]?.edited === false && h.writes().length === 1, r);
removeDir(h.dir);

// GitHub's references count, also without the words
h = setUp({ github: { "link-pr-60": prNode(60, { closingIssuesReferences: { nodes: [{ number: 50, repository: { nameWithOwner: REPO } }] } }) } });
r = h.link();
t.check("a PR that already closes the issue gets no edit", r.status === 0 && r.linked[0]?.edited === false && h.writes().length === 0 && !!h.records()["issue-50"][0].linked, r);
removeDir(h.dir);
h = setUp({ github: { "link-pr-60": prNode(60, { closingIssuesReferences: { nodes: [{ number: 50, repository: { nameWithOwner: "acme/other" } }] } }) } });
r = h.link();
t.check("the same number in another repo does not count", r.linked[0]?.edited === true && h.writes().length === 1, r);
removeDir(h.dir);

// Closed and merged PRs
for (const [state, ended] of [["CLOSED", "closed"], ["MERGED", "merged"]]) {
	h = setUp({ current: [], baseline: { "disc-36": { updatedAt: "2026-11-18T00:00:00Z" } }, github: { "link-pr-60": prNode(60, { state }) } });
	r = h.link();
	t.check(`a ${ended} PR keeps its body`, r.status === 0 && h.writes().length === 0 && h.records()["issue-50"][0].ended === ended && h.actions().length === 0, r);
	t.check(`the issue's fix is ${ended}`, JSON.parse(h.gary("fixes", "--json").stdout)["issue-50"]?.state === ended);
	const before = h.reads().length;
	h.link();
	t.check(`a ${ended} PR is not read again`, h.reads().length === before);
	h.file("snapshot.pending.json", { items: Object.fromEntries([open(60)]) });
	h.answer({ "link-pr-60": prNode(60) });
	r = h.link();
	t.check(`a ${ended} PR that is open again gets the line`, r.linked[0]?.edited === true && h.writes().length === 1 && h.records()["issue-50"][0].ended === undefined, r);
	removeDir(h.dir);
}

// Someone else's PR, a wrong number in the records
h = setUp({ github: { "link-pr-60": prNode(60, { author: { login: "hubot" } }) } });
r = h.link();
t.check("a PR the bot did not open keeps its body", r.status === 0 && h.writes().length === 0 && /not by widgets-bot/.test(r.skipped[0]?.reason), r);
removeDir(h.dir);

// Look-alikes and discussions that are not escalated
h = setUp({ github: { "escalation-36": { closed: true, resultComments: { nodes: [said("hubot", "Escalated to an issue: #50")] } } } });
r = h.link();
t.check("a look-alike by someone else moves and writes nothing", r.status === 0 && !r.moved.length && h.writes().length === 0 && !!h.records()["disc-36"], r);
removeDir(h.dir);
h = setUp({ github: { "escalation-36": { ...escalated(50), closed: false } } });
r = h.link();
t.check("an open discussion moves nothing", r.status === 0 && !r.moved.length && h.writes().length === 0, r);
removeDir(h.dir);
h = setUp({ github: { "escalated-issue-50": null } });
r = h.link();
t.check("a number that is no issue moves nothing", r.status === 1 && r.errors.length === 1 && !!h.records()["disc-36"] && h.writes().length === 0, r);
removeDir(h.dir);
h = setUp({ github: { "escalated-issue-50": issueRef(50, "acme/other") } });
r = h.link();
t.check("an issue of another repo moves nothing", r.status === 1 && !!h.records()["disc-36"] && h.writes().length === 0, r);
removeDir(h.dir);

// Which discussions the hourly run reads
h = setUp({ current: [open(60), ["disc-36", {}]] });
r = h.link();
t.check("an open discussion in the snapshot is not read", r.status === 0 && h.reads().length === 0, r);
removeDir(h.dir);
h = setUp({ current: [] });
r = h.link();
t.check("a discussion closed long ago without an open PR is not read", r.status === 0 && h.reads().length === 0, r);
removeDir(h.dir);
h = setUp({ records: { "issue-22": [record(60)], "pr-9": [record(61)] }, current: [open(60), open(61)] });
r = h.link();
t.check("records of issues and PRs are left alone", r.status === 0 && h.reads().length === 0 && h.writes().length === 0, r);
removeDir(h.dir);
// The backfill: escalated before this run, with no trace in any baseline
h = setUp({ records: { "disc-36": [record(60), record(61)] }, current: [open(60)], github: { "link-pr-61": prNode(61, { state: "MERGED" }) } });
r = h.link();
t.check("an older escalation with an open PR is linked", r.status === 0 && h.writes().length === 1 && h.records()["issue-50"].length === 2, r);
removeDir(h.dir);

// Pause, focus and a push job
h = setUp();
h.gary("pause");
r = h.link();
t.check("while paused the record moves and nothing is sent", r.status === 0 && h.writes().length === 0 && !!h.records()["issue-50"] && r.wouldHave[0]?.action === "link_issue" && r.wouldHave[0].params.issue === 50, r);
h.gary("resume");
r = h.link();
t.check("after resume the line goes out", r.status === 0 && h.writes().length === 1, r);
removeDir(h.dir);
h = setUp();
mkdirSync(join(h.state, "focus"), { recursive: true });
h.file("focus/pr-60.json", { itemId: "pr-60", status: "active", startedAt: new Date().toISOString() });
r = h.link();
t.check("a PR in focus keeps its body", r.status === 0 && h.writes().length === 0 && r.waiting.length === 1, r);
removeDir(h.dir);
h = setUp();
out = h.gary("claim", "pr-60", "push", "--run", "drive-1");
r = h.link();
t.check("a running push job holds the edit back", out.status === 0 && h.writes().length === 0 && r.waiting.length === 1 && !!h.records()["issue-50"], r);
h.gary("release", "pr-60", "push", "--run", "drive-1");
r = h.link();
t.check("after the job the line goes out", h.writes().length === 1, r);
removeDir(h.dir);

// A failed write
h = setUp({ github: { writeError: "Resource not accessible by personal access token" } });
r = h.link();
t.check("a failed edit is reported and not marked", r.status === 1 && r.errors.length === 1 && !h.records()["issue-50"][0].linked && h.actions().length === 0, r);
h.answer({ writeError: null });
r = h.link();
t.check("the next run tries again", r.status === 0 && h.writes().length === 1, r);
removeDir(h.dir);

// Off
h = setUp({ profile: ({ escalateResult, ...p }) => p });
r = h.link();
t.check("without the profile field the feature is off", r.status === 0 && r.enabled === false && h.reads().length === 0 && !!h.records()["disc-36"], r);
out = h.gary("doctor");
t.check("doctor says it is off", /ok\s+escalate link\s+off: the profile has no escalateResult/.test(out.stdout), out.stdout);
removeDir(h.dir);
h = setUp({ config: { bot: null, allowOwnTokenPushes: true } });
r = h.link();
t.check("without a bot the feature is off", r.status === 0 && r.enabled === false && h.reads().length === 0, r);
out = h.gary("doctor");
t.check("doctor warns without a bot", /warn\s+escalate link\s+off: no bot is configured/.test(out.stdout), out.stdout);
removeDir(h.dir);
h = setUp();
out = h.gary("doctor");
t.check("doctor says it is on", /ok\s+escalate link\s+a comment by widgets-bot that matches/.test(out.stdout), out.stdout);
removeDir(h.dir);

t.done();
