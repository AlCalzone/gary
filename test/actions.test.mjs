// gary action --dry-run against the fake gh: validation, account rules and the writes it would send.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GARY, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const CASES = [
	[false, '{"action":"approve","kind":"pr","number":12}', 'Unknown action'],
	[false, '{"action":"request_changes","kind":"pr","number":12,"text":"x"}', 'Unknown action'],
	[false, '{"action":"review_comment","kind":"pr","number":12,"text":"x"}', 'Unknown action'],
	[false, '{"action":"apply_fixes","kind":"pr","number":12}', 'Unknown action'],
	[false, '{"action":"address_review","kind":"pr","number":12}', 'agent request'],
	[false, '{"action":"take_over","kind":"pr","number":12}', 'agent request'],
	[false, '{"action":"revise","kind":"pr","number":12}', 'agent request'],
	[false, '{"action":"start_fix","kind":"issue","number":21}', 'agent request'],
	[false, '{"action":"move","kind":"issue","number":21}', 'Unknown action'],
	[false, '{"action":"snooze","kind":"issue","number":21}', 'board-only'],
	[true, '{"action":"review","kind":"pr","number":12,"params":{"event":"approve"}}', '"event": "APPROVE"'],
	[true, '{"action":"review","kind":"pr","number":12,"params":{"event":"request_changes"},"text":"Please fix"}', '"REQUEST_CHANGES"'],
	[true, '{"action":"review","kind":"pr","number":12,"params":{"event":"comment","sha":"944d5aca1b70af1d87ca805b08639f3e17b83dcd","comments":[{"path":"src/restore.ts","line":40,"text":"Restart the watchdog here"}]}}', '"side": "RIGHT"'],
	[true, '{"action":"review","kind":"pr","number":12,"params":{"event":"comment","comments":[{"path":"a.ts","line":1,"text":"x"}]}}', '"threads"'],
	[false, '{"action":"review","kind":"pr","number":12,"params":{"event":"comment"}}', 'needs a text or inline comments'],
	[false, '{"action":"review","kind":"pr","number":12,"params":{"event":"request_changes"}}', 'needs a text or inline comments'],
	[false, '{"action":"review","kind":"pr","number":12,"params":{"event":"dismiss"}}', 'params.event'],
	[false, '{"action":"review","kind":"pr","number":12}', 'params.event'],
	[false, '{"action":"review","kind":"issue","number":21,"params":{"event":"approve"}}', 'not available'],
	[false, '{"action":"review","kind":"pr","number":12,"params":{"event":"comment","comments":[{"path":"a.ts","line":0,"text":"x"}]}}', 'line must be'],
	[false, '{"action":"review","kind":"pr","number":12,"params":{"event":"comment","comments":[{"path":"/etc/passwd","line":1,"text":"x"}]}}', 'repository-relative'],
	[false, '{"action":"review","kind":"pr","number":12,"params":{"event":"comment","comments":[{"id":"c1","path":"a.ts","line":1,"text":"x"}]}}', 'unknown field'],
	[false, '{"action":"review","kind":"pr","number":12,"params":{"event":"comment","comments":[{"path":"a.ts","line":1,"text":" "}]}}', 'non-empty'],
	[false, '{"action":"review","kind":"pr","number":12,"params":{"event":"approve","sha":"abc"}}', 'params.sha'],
	[true, '{"action":"review","kind":"pr","number":12,"params":{"event":"comment","comments":[{"path":"a.ts","startLine":3,"line":5,"text":"x"}]}}', '"startSide": "RIGHT"'],
	[false, '{"action":"review","kind":"pr","number":12,"params":{"event":"comment","comments":[{"path":"a.ts","startLine":5,"line":5,"text":"x"}]}}', 'startLine must be'],
	[true, '{"action":"close","kind":"issue","number":21,"params":{"reason":"duplicate","duplicateOf":22}}', '"DUPLICATE"'],
	[true, '{"action":"close","kind":"issue","number":21,"params":{"reason":"duplicate","duplicateOf":22}}', '"duplicate": "I_'],
	[true, '{"action":"close","kind":"discussion","number":31,"params":{"reason":"duplicate"}}', '"reason": "DUPLICATE"'],
	[true, '{"action":"close","kind":"issue","number":21,"params":{"reason":"not_planned"}}', '"duplicate": null'],
	[false, '{"action":"close","kind":"issue","number":21,"params":{"reason":"duplicate"}}', 'needs params.duplicateOf'],
	[false, '{"action":"close","kind":"issue","number":21,"params":{"reason":"completed","duplicateOf":5}}', 'needs reason duplicate'],
	[false, '{"action":"close","kind":"issue","number":21,"params":{"reason":"duplicate","duplicateOf":21}}', 'another item'],
	[false, '{"action":"close","kind":"issue","number":21,"params":{"reason":"duplicate","duplicateOf":12}}', 'is a pull request'],
	[false, '{"action":"close","kind":"issue","number":21,"params":{"reason":"spam"}}', 'params.reason'],
	[true, '{"action":"create_issue","kind":"pr","number":12,"params":{"title":"Follow-up: restart the watchdog"},"text":"Body with `code` and $(rm -rf ~)"}', 'createIssue'],
	[true, '{"action":"create_issue","kind":"issue","number":21,"params":{"title":"Follow-up"}}', '"body": null'],
	[false, '{"action":"create_issue","kind":"pr","number":12}', 'params.title'],
	[false, '{"action":"create_issue","kind":"pr","number":12,"params":{"title":"  "}}', 'params.title'],
	[false, '{"action":"create_issue","kind":"pr","number":12,"params":{"title":"x","repo":"other"}}', 'Unknown parameter'],
	[true, '{"action":"transfer","kind":"issue","number":21,"params":{"repo":"widgets-desktop"}}', 'transferIssue'],
	[false, '{"action":"transfer","kind":"issue","number":21,"params":{"repo":"widgets"}}', 'different repository'],
	[false, '{"action":"transfer","kind":"issue","number":21,"params":{"repo":"evil/repo"}}', 'params.repo'],
	[false, '{"action":"transfer","kind":"issue","number":21,"params":{"repo":"no-such-repo-zz9"}}', "profile's relatedRepos"],
	[false, '{"action":"transfer","kind":"pr","number":12,"params":{"repo":"widgets-desktop"}}', 'not available'],
	[false, '{"action":"transfer","kind":"discussion","number":31,"params":{"repo":"widgets-desktop"}}', 'not available'],
	[false, '{"action":"transfer","kind":"issue","number":20,"params":{"repo":"widgets-desktop"}}', 'not open'],
	[true, '{"action":"update_branch","kind":"pr","number":12}', 'updatePullRequestBranch'],
	[true, '{"action":"update_branch","kind":"pr","number":12,"params":{"sha":"944d5aca1b70af1d87ca805b08639f3e17b83dcd"}}', '"sha": "944d5aca'],
	[false, '{"action":"update_branch","kind":"issue","number":21}', 'not available'],
	[false, '{"action":"update_branch","kind":"pr","number":12,"text":"x"}', 'does not post text'],
	[true, '{"action":"rerun_ci","kind":"pr","number":14}', 'rerun-failed-jobs'],
	[false, '{"action":"rerun_ci","kind":"pr","number":12}', 'No failed workflow runs'],
	[false, '{"action":"rerun_ci","kind":"issue","number":21}', 'not available'],
	[true, '{"action":"reopen","kind":"issue","number":20}', 'reopenIssue'],
	[true, '{"action":"reopen","kind":"issue","number":20,"text":"Reopening"}', 'addComment'],
	[true, '{"action":"reopen","kind":"pr","number":15}', 'reopenPullRequest'],
	[true, '{"action":"reopen","kind":"discussion","number":34,"text":"x"}', 'reopenDiscussion'],
	[false, '{"action":"reopen","kind":"pr","number":16}', 'merged'],
	[false, '{"action":"reopen","kind":"issue","number":21}', 'not closed'],
	[false, '{"action":"reopen","kind":"issue","number":20,"params":{"reason":"x"}}', 'Unknown parameter'],
	[true, '{"action":"request_review","kind":"pr","number":12,"params":{"reviewer":"copilot"}}', 'requestCopilotCodeReview'],
	[false, '{"action":"request_review","kind":"pr","number":12,"params":{"reviewer":"octocat"}}', 'must be copilot'],
	[false, '{"action":"request_review","kind":"pr","number":12}', 'must be copilot'],
	[false, '{"action":"request_review","kind":"issue","number":21,"params":{"reviewer":"copilot"}}', 'not available'],
	[false, '{"action":"request_review","kind":"pr","number":15,"params":{"reviewer":"copilot"}}', 'not open'],
	[false, '{"action":"drive","kind":"pr","number":12}', 'agent request'],
	[true, '{"action":"request_review","kind":"pr","number":12,"params":{"reviewer":"copilot"}}', '"as": "octocat"'],
	[false, '{"action":"comment","kind":"pr","number":12,"text":"Done. @widgets-bot escalate"}', 'bot command'],
	[false, '{"action":"comment","kind":"pr","number":12,"text":"try @Widgets-Bot Escalate here"}', 'bot command'],
	[false, '{"action":"review","kind":"pr","number":12,"params":{"event":"comment","comments":[{"path":"a.ts","line":1,"text":"@widgets-bot automerge"}]}}', 'bot command'],
	[false, '{"action":"create_issue","kind":"pr","number":12,"params":{"title":"@widgets-bot automerge"}}', 'bot command'],
	[true, '{"action":"comment","kind":"pr","number":12,"text":"Ask the bot to escalate it"}', 'addComment'],
	[true, '{"action":"comment","kind":"pr","number":12,"text":"hi"}', 'addComment'],
	[true, '{"action":"merge","kind":"pr","number":12}', 'mergePullRequest'],
	[true, '{"action":"label","kind":"issue","number":21,"params":{"add":["bug"]}}', 'addLabelsToLabelable'],
	// Lookups that the fake gh answers from the fixtures
	[true, '{"action":"ready","kind":"pr","number":13}', "markPullRequestReadyForReview"],
	[false, '{"action":"ready","kind":"pr","number":12}', "is not a draft"],
	[false, '{"action":"merge","kind":"pr","number":13}', "is a draft"],
	[false, '{"action":"merge","kind":"issue","number":21}', "not available"],
	[false, '{"action":"comment","kind":"issue","number":12,"text":"x"}', "is a pull request"],
	[false, '{"action":"comment","kind":"pr","number":99999,"text":"x"}', "not found"],
	[false, '{"action":"label","kind":"issue","number":21,"params":{"add":["no-such-label"]}}', "does not exist"],
	[false, '{"action":"assign","kind":"issue","number":21,"params":{"assignees":["nobody-here"]}}', "Could not resolve assignees"],
	[true, '{"action":"assign","kind":"issue","number":21,"params":{"assignees":["octocat"]}}', "addAssigneesToAssignable"],
	[true, '{"action":"answer_discussion","kind":"discussion","number":31,"params":{"commentId":"DC_c1"}}', "markDiscussionCommentAsAnswer"],
	[false, '{"action":"answer_discussion","kind":"discussion","number":31,"params":{"commentId":"DC_c3"}}', "does not belong"],
	[false, '{"action":"answer_discussion","kind":"discussion","number":32,"params":{"commentId":"DC_c3"}}', "without answers"],
	[false, '{"action":"answer_discussion","kind":"discussion","number":33,"params":{"commentId":"DC_r1"}}', "Only top-level comments"],
	[true, '{"action":"react","kind":"issue","number":21,"params":{"commentId":"IC_1"}}', "addReaction"],
	[false, '{"action":"react","kind":"issue","number":22,"params":{"commentId":"IC_1"}}', "does not belong"],
	[true, '{"action":"comment","kind":"pr","number":12,"text":"hello \\"$(rm -rf ~)\\" `x`"}', "$(rm -rf ~)"],
	[true, '{"action":"comment","kind":"pr","number":12,"text":"x"}', '"as": "widgets-bot"'],
	// The repo comes from the item and must be one of the instance's
	[true, '{"action":"comment","kind":"pr","number":12,"repo":"acme/widgets","text":"x"}', "addComment"],
	[true, '{"action":"comment","kind":"pr","number":12,"repo":"ACME/Widgets","text":"x"}', "addComment"],
	[false, '{"action":"comment","kind":"pr","number":12,"repo":"acme/other","text":"x"}', "acme/other is not a repository of instance widgets"],
];

const t = runner("actions");
const dir = tempDir();
const { env } = makeHome(dir);
for (const [ok, json, match] of CASES) {
	const r = spawnSync(process.execPath, [GARY, "action", "--dry-run"], { input: json, env, encoding: "utf8" });
	const out = r.stdout + r.stderr;
	t.check(`${ok ? "ok" : "refused"}: ${json}`, (r.status === 0) === ok && out.includes(match), out.slice(0, 400));
}

// The maintainer's review: requested by the writing identity, or skipped with nothing sent
const OVERRIDES = join(dir, "overrides.json");
writeFileSync(OVERRIDES, "{}");
const action = (json, extra = env) => {
	const r = spawnSync(process.execPath, [GARY, "action", "--dry-run"], { input: json, env: { ...extra, FAKE_GH_OVERRIDES: OVERRIDES }, encoding: "utf8" });
	try {
		return { status: r.status, ...JSON.parse(r.stdout) };
	} catch {
		return { status: r.status, unparsed: r.stdout + r.stderr };
	}
};
const maintainer = (number, params = {}) => JSON.stringify({ action: "request_review", kind: "pr", number, params: { reviewer: "maintainer", ...params } });
let o = action(maintainer(12));
const sent = o.result?.invocations;
t.check("the maintainer's review is requested as the bot with his id and union", o.status === 0 && sent?.length === 1 && sent[0].as === "widgets-bot" && /requestReviews\(input: \{ pullRequestId: \$id, userIds: \$users, union: true \}\)/.test(sent[0].stdin.query) && JSON.stringify(sent[0].stdin.variables) === '{"id":"PR_12","users":["U_octocat"]}', o);
const skips = [
	["he wrote the PR", maintainer(26), /You wrote PR #26/],
	["the PR is a draft", maintainer(13), /PR #13 is a draft/],
	["the PR is closed", maintainer(15), /PR #15 is closed/],
	["the PR is merged", maintainer(16), /PR #16 is merged/],
];
for (const [why, json, reason] of skips) {
	o = action(json);
	t.check(`skipped when ${why}`, o.status === 0 && o.ok === true && reason.test(o.skipped) && o.result?.invocations?.length === 0, o);
}
writeFileSync(OVERRIDES, JSON.stringify({ "requests-12": { reviewRequests: { nodes: [{ requestedReviewer: { login: "hubot" } }, { requestedReviewer: { login: "OctoCat" } }] } } }));
o = action(maintainer(12));
t.check("skipped when his review is already requested", o.status === 0 && /already requested/.test(o.skipped) && o.result?.invocations?.length === 0, o);
writeFileSync(OVERRIDES, JSON.stringify({ "requests-12": { reviewRequests: { nodes: [{ requestedReviewer: { login: "hubot" } }, { requestedReviewer: {} }] } } }));
o = action(maintainer(12));
t.check("a pending request of someone else or of a team does not count", o.status === 0 && o.skipped === undefined && o.result?.invocations?.length === 1, o);
writeFileSync(OVERRIDES, "{}");
o = action(maintainer(12, { as: "bot" }));
t.check("params.as is refused for the maintainer's review", o.status === 1 && /only for a Copilot review/.test(o.result), o);
o = action(JSON.stringify({ action: "request_review", kind: "pr", number: 12, params: { reviewer: "maintainer" }, text: "@octocat please look" }));
t.check("the maintainer's review request posts no text", o.status === 1 && /does not post text/.test(o.result), o);
o = action(maintainer(21));
t.check("an issue number is refused", o.status === 1 && /not found/.test(o.result), o);
const own = makeHome(tempDir(), { bot: null, allowOwnTokenPushes: true });
o = action(maintainer(12), own.env);
t.check("skipped when writes run under his own login", o.status === 0 && /your own login/.test(o.skipped) && o.result?.invocations?.length === 0, o);
const none = makeHome(tempDir(), { bot: null });
o = action(maintainer(12), none.env);
t.check("refused without an account that may write", o.status === 1 && /cannot write to GitHub/.test(o.result), o);
spawnSync(process.execPath, [GARY, "pause"], { env, encoding: "utf8" });
o = action(maintainer(12));
t.check("paused: the maintainer's review is not requested", o.status === 1 && /paused/.test(o.result), o);
spawnSync(process.execPath, [GARY, "resume"], { env, encoding: "utf8" });
removeDir(dirname(own.root));
removeDir(dirname(none.root));
removeDir(dir);
t.done();
