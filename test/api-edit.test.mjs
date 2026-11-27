// The API edit: a take_over or revise route whose text edits the server commits through the GitHub API, the only
// push to a PR that changes sensitive files. Runs on temp roots with the fake gh, so nothing reaches GitHub.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GARY, PROFILE, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { BOT, CONTRIBUTING, EDIT_HEAD, ME, NEW_HEAD } from "./fixtures/github.mjs";
import { API_EDIT_LIMITS, apiEditProblems, applyEdits, commentText, commitMessageProblem, editPathProblem } from "../scripts/lib/api-edit.mjs";
import { actorOf, effectiveActor, sensitiveRefusal, servedRoute } from "../scripts/lib/routes.mjs";
import { validateItem } from "../scripts/lib/validate-item.mjs";

const t = runner("api-edit");
const T = tempDir();
const profile = JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8"));
const reviewedAt = "2026-11-17T14:00:00Z";
const later = "2026-11-18T09:00:00Z";

const edit = { path: "CONTRIBUTING.md", original: "Join us on Discord: https://discord.gg/wrong", replacement: "Join us on Discord: https://discord.gg/right" };
const MESSAGE = "docs: fix the Discord invite link";
const params = (extra = {}) => ({ via: "api", message: MESSAGE, edits: [edit], ...extra });
const apiRoute = (extra = {}, p = {}) => ({ id: "r1", type: "take_over", as: "bot", title: "Take over: fix the Discord link", params: params(p), recommended: true, ...extra });
const review = { id: "r2", type: "review", as: "bot", title: "Review: ask for the link fix", params: { event: "request_changes" }, text: "The Discord link is wrong." };
const pr = (number, routes, extra = {}) => ({
	kind: "pr", repo: "acme/widgets", number, title: "Update the docs", url: `https://github.com/acme/widgets/pull/${number}`, author: "hubot", authorType: "contributor",
	section: "review", priority: 1, effortMinutes: 5, reviewDepth: "full", state: "Changes the agent instructions.", reviewedAt, reviewedSha: EDIT_HEAD, hint: routes.find((r) => r.recommended)?.title, routes, ...extra,
});

// ---------- the static rules ----------
const problems = (p) => apiEditProblems(p, profile);
const has = (p, re) => problems(p).some((m) => re.test(m));
t.check("a one-line text edit passes", problems(params()).length === 0, problems(params()));
t.check("via must be api", has({ edits: [edit], message: MESSAGE }, /params\.via/));
t.check("an unknown param is refused", has(params({ sha: "x" }), /unknown param "sha"/));
t.check("an API edit never opens a replacement PR", has(params({ mode: "replace" }), /params\.mode/) && problems(params({ mode: "push" })).length === 0);
t.check("the edits are required", has(params({ edits: [] }), /at least one edit/) && has(params({ edits: undefined }), /at least one edit/));
t.check("an edit has exactly path, original and replacement", has(params({ edits: [{ ...edit, line: 3 }] }), /three strings/) && has(params({ edits: [{ path: "a.md", original: "x" }] }), /three strings/));
const withPath = (path) => params({ edits: [{ ...edit, path }] });
t.check("a sensitive path is refused", has(withPath("package.json"), /sensitivePaths \(\*\*\/package\.json\)/) && has(withPath("sub/package.json"), /sensitivePaths/));
t.check(".github is refused whatever the profile lists", apiEditProblems(withPath(".github/copilot-instructions.md"), { ...profile, sensitivePaths: [] }).some((m) => /under \.github\//.test(m)) && editPathProblem(".GitHub/x.md", []) !== null);
t.check("a path with .. is refused", has(withPath("docs/../.github/x.md"), /"\.\."/) && has(withPath("../x.md"), /"\.\."/));
t.check("an absolute path is refused", has(withPath("/etc/passwd"), /relative to the repository root/));
t.check("backslashes, empty segments and .git are refused", editPathProblem("docs\\x.md", []) !== null && editPathProblem("docs//x.md", []) !== null && editPathProblem(".git/config", []) !== null && editPathProblem("", []) !== null);
t.check("a sensitive path is matched without regard to case", editPathProblem("Package.json", profile.sensitivePaths) !== null);
t.check("a plain path passes", editPathProblem("docs/guide.md", profile.sensitivePaths) === null);
const many = (n, file = (i) => "CONTRIBUTING.md") => Array.from({ length: n }, (_, i) => ({ path: file(i), original: `line ${i}`, replacement: `LINE ${i}` }));
t.check("at most five edits", has(params({ edits: many(API_EDIT_LIMITS.edits + 1) }), /at most 5 are allowed/) && problems(params({ edits: many(API_EDIT_LIMITS.edits) })).length === 0);
t.check("at most three files", has(params({ edits: many(4, (i) => `docs/${i}.md`) }), /change 4 files, at most 3/) && problems(params({ edits: many(3, (i) => `docs/${i}.md`) })).length === 0);
const lines = (n) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
t.check("at most forty changed lines in total", has(params({ edits: [{ ...edit, original: lines(21) }, { ...edit, path: "docs/a.md", original: "x", replacement: lines(20) }] }), /change 41 lines, at most 40/) && problems(params({ edits: [{ ...edit, original: lines(20), replacement: lines(3) }, { ...edit, path: "docs/a.md", original: "x", replacement: lines(20) }] })).length === 0);
t.check("a replacement with a bot command is refused", has(params({ edits: [{ ...edit, replacement: "Write @Widgets-Bot automerge to merge" }] }), /replacement contains the bot command "@widgets-bot automerge"/));
t.check("an empty replacement is refused", has(params({ edits: [{ ...edit, replacement: " " }] }), /deletes nothing/));
t.check("an edit that changes nothing is refused", has(params({ edits: [{ ...edit, replacement: edit.original }] }), /equals original/));
t.check("an edit ends without a line break", has(params({ edits: [{ ...edit, original: edit.original + "\n" }] }), /without a line break at the end/));
t.check("an oversized edit is refused", has(params({ edits: [{ ...edit, replacement: "x".repeat(API_EDIT_LIMITS.chars + 1) }] }), /longer than 4000 characters/));
t.check("the same lines cannot be edited twice", has(params({ edits: [edit, { ...edit, replacement: "other" }] }), /edited twice/));
for (const [label, message, re] of [
	["a missing commit message", undefined, /params\.message is required/],
	["a commit message that is no conventional commit", "Fix the link", /conventional commit/],
	["a commit message of two lines", "docs: fix\n\nmore", /one line/],
	["a long commit message", "docs: " + "x".repeat(70), /longer than 72/],
	["a commit message that skips CI", "docs: fix the link [skip ci]", /skips CI/],
	["a commit message with a mention", "docs: thanks @octocat", /mention/],
	["a commit message that closes an issue", "docs: fix the link, closes #12", /closing keyword/],
]) t.check(`${label} is refused`, has(params({ message }), re), problems(params({ message })));
t.check("a conventional commit with a scope passes", commitMessageProblem("fix(docs): correct the invite link", [], "conventional") === null);
const plain = (p) => apiEditProblems(p, { ...profile, commitFormat: null });
t.check("without commitFormat a plain line passes", plain(params({ message: "Fix the Discord invite link" })).length === 0 && commitMessageProblem("Fix the link") === null);
t.check("without commitFormat the message is still one line of at most 72 characters", plain(params({ message: "Fix\nmore" })).some((m) => /one line/.test(m)) && plain(params({ message: "x".repeat(73) })).some((m) => /longer than 72/.test(m)) && plain(params({ message: " " })).some((m) => /is required: the commit message, one line$/.test(m)));
t.check("without commitFormat a bot command is still refused", plain(params({ message: "Fix it @widgets-bot automerge" })).some((m) => /mention|bot command/.test(m)) && commitMessageProblem("Fix it, then automerge", ["automerge"]) !== null);

// ---------- applying edits ----------
const refusal = (fn) => {
	try {
		fn();
	} catch (e) {
		return e.message;
	}
	return null;
};
t.check("an edit replaces its lines and nothing else", applyEdits("CONTRIBUTING.md", CONTRIBUTING, [edit]) === CONTRIBUTING.replace("wrong", "right"));
t.check("text that is not in the file is refused", /was not found/.test(refusal(() => applyEdits("a.md", CONTRIBUTING, [{ ...edit, original: "No such line" }]))));
t.check("text that occurs twice is refused", /occurs 2 times/.test(refusal(() => applyEdits("a.md", CONTRIBUTING, [{ ...edit, original: "Run the tests before you open a PR." }]))));
t.check("a part of a line is refused", /whole lines/.test(refusal(() => applyEdits("a.md", CONTRIBUTING, [{ ...edit, original: "https://discord.gg/wrong" }]))) && /whole lines/.test(refusal(() => applyEdits("a.md", CONTRIBUTING, [{ ...edit, original: "Join us on Discord:" }]))));
t.check("overlapping edits are refused", /overlap/.test(refusal(() => applyEdits("a.md", "one\ntwo\nthree\n", [{ original: "one\ntwo", replacement: "1\n2" }, { original: "two\nthree", replacement: "2\n3" }]))));
t.check("two edits of one file both apply", applyEdits("a.md", "one\ntwo\nthree\n", [{ original: "three", replacement: "3" }, { original: "one", replacement: "1" }]) === "1\ntwo\n3\n");
t.check("a file with CRLF and one without a final line break keep them", applyEdits("a.md", "# Guide\r\n\r\nSee the old page.\r\n", [{ original: "See the old page.", replacement: "See the new page." }]) === "# Guide\r\n\r\nSee the new page.\r\n" && applyEdits("a.md", "Step one\nStep two", [{ original: "Step two", replacement: "Step 2" }]) === "Step one\nStep 2");
t.check("the comment names the commit and the files, then the note", commentText("Pushed {commit}, changing {files}.", { commitUrl: "URL", paths: ["a.md", "b.md"], note: " Is the old server gone? " }) === "Pushed URL, changing `a.md`, `b.md`.\n\nIs the old server gone?");

// ---------- route rules ----------
t.check("an API edit runs as the bot", actorOf(apiRoute()) === "bot" && actorOf(apiRoute({ as: undefined })) === "bot" && actorOf(apiRoute({ as: "agent" })) === undefined);
t.check("a checkout take-over stays the agent's", actorOf({ type: "take_over" }) === "agent" && actorOf({ type: "take_over", as: "bot" }) === undefined && actorOf({ type: "revise", as: "bot" }) === undefined);
t.check("the account mode decides who commits", effectiveActor(apiRoute(), "bot") === "bot" && effectiveActor(apiRoute(), "own") === "own" && effectiveActor(apiRoute(), "none") === "unavailable");
t.check("an API take-over on a PR we control is served as a change", servedRoute(apiRoute(), pr(26, [apiRoute()], { takenOver: true })).type === "revise" && servedRoute(apiRoute(), pr(26, [apiRoute()], { takenOver: true })).params.via === "api");
for (const type of ["take_over", "revise", "address_review", "drive", "format"]) {
	t.check(`${type} is refused on a PR with sensitive files`, /sensitive files/.test(sensitiveRefusal({ type }, true) ?? "") && sensitiveRefusal({ type }, false) === null && sensitiveRefusal({ type }, undefined) === null);
}
t.check("the API form and routes that do not push pass on a sensitive PR", sensitiveRefusal(apiRoute(), true) === null && sensitiveRefusal(apiRoute({ type: "revise" }), true) === null && sensitiveRefusal(review, true) === null && sensitiveRefusal({ type: "merge" }, true) === null);

// ---------- the validator ----------
const validate = (item, sensitive = true, mode = "bot") => validateItem("pr-26", item, { mode, profile, sensitive: sensitive === "unknown" ? undefined : sensitive }).errors.map((e) => e.message);
const invalid = (item, re, sensitive) => validate(item, sensitive).some((m) => re.test(m));
t.check("the validator accepts an API take-over with a review as the alternative", validate(pr(26, [apiRoute(), review])).length === 0, validate(pr(26, [apiRoute(), review])));
t.check("the validator accepts an API change on a PR we control, without text", validate(pr(26, [apiRoute({ type: "revise", title: "Change: fix the Discord link" })], { authorType: "maintainer" })).length === 0);
t.check("the validator accepts a note for the contributor", validate(pr(26, [apiRoute({ text: "Is the old server gone for good?" })])).length === 0);
t.check("the validator refuses a checkout take-over on a sensitive PR", invalid(pr(26, [{ id: "r1", type: "take_over", as: "agent", title: "Take over: fix it", recommended: true }]), /only allowed as an API edit/));
t.check("the validator refuses a checkout change on a sensitive PR", invalid(pr(26, [{ id: "r1", type: "revise", as: "agent", title: "Change: fix it", text: "Fix it", recommended: true }], { authorType: "maintainer" }), /only allowed as an API edit/));
for (const route of [{ type: "drive" }, { type: "address_review" }, { type: "format" }]) {
	t.check(`the validator refuses ${route.type} on a sensitive PR`, invalid(pr(26, [{ id: "r1", as: "agent", title: "Go: x", recommended: true, ...route }], { authorType: "maintainer", threads: [{ id: "PRRT_1", verdict: "valid" }], autofix: { changes: true, files: 1, lines: 2, tools: ["fmt"] } }), /does not run/));
}
t.check("without sensitive files the checkout take-over stays valid", validate(pr(26, [{ id: "r1", type: "take_over", as: "agent", title: "Take over: fix it", recommended: true }]), false).length === 0 && validate(pr(26, [{ id: "r1", type: "take_over", as: "agent", title: "Take over: fix it", recommended: true }]), "unknown").length === 0);
t.check("without sensitive files the API form is refused", invalid(pr(26, [apiRoute()]), /changes no sensitive files/, false) && validate(pr(26, [apiRoute()]), "unknown").length === 0);
t.check("the validator refuses a sensitive edit path", invalid(pr(26, [apiRoute({}, { edits: [{ ...edit, path: ".github/copilot-instructions.md" }] })]), /under \.github\//));
t.check("the validator refuses too many edits", invalid(pr(26, [apiRoute({}, { edits: many(6) })]), /at most 5 are allowed/));
t.check("the validator refuses a bot command in a replacement, the note or the message", invalid(pr(26, [apiRoute({}, { edits: [{ ...edit, replacement: "@widgets-bot automerge" }] })]), /bot command/) && invalid(pr(26, [apiRoute({ text: "Then say @widgets-bot automerge" })]), /would post the command/));
t.check("the validator needs the full reviewed SHA", invalid(pr(26, [apiRoute()], { reviewedSha: "abc1234" }), /full 40-character SHA/));
t.check("the validator refuses the API form on other route types", invalid(pr(26, [{ ...review, id: "r1", recommended: true, params: { ...review.params, via: "api" } }]), /only for take_over and revise/) && invalid(pr(26, [apiRoute({}, { via: "git" })]), /only allowed as an API edit/));
t.check("another route type cannot pass as an API edit", /does not run drive/.test(sensitiveRefusal({ type: "drive", params: { via: "api" } }, true) ?? ""));
t.check("the validator refuses the agent as the actor of an API edit", invalid(pr(26, [apiRoute({ as: "agent" })]), /is not allowed for take_over/));
t.check("the validator refuses an API take-over on a PR we control", invalid(pr(26, [apiRoute()], { authorType: "bot" }), /Use revise on this PR/));
t.check("the validator refuses an API change on a contributor PR", invalid(pr(26, [apiRoute({ type: "revise" })]), /Use take_over on a contributor PR/));
t.check("without an account that may write the API edit is unavailable", validate(pr(26, [apiRoute()]), true, "none").some((m) => /needs a bot account/.test(m)));

// ---------- the dry run of the command ----------
function writeItems(home, items) {
	for (const [id, data] of Object.entries(items)) writeFileSync(join(home, "state", "board", "items", id + ".json"), JSON.stringify(data));
}
const sensitiveSnapshot = { items: { "pr-26": { kind: "pr", number: 26, sensitiveFiles: [".github/copilot-instructions.md"] }, "pr-27": { kind: "pr", number: 27, sensitiveFiles: ["package.json"] }, "pr-12": { kind: "pr", number: 12 } } };

const cliDir = join(T, "cli");
const cli = makeHome(cliDir);
writeItems(cli.home, { "pr-26": pr(26, [apiRoute({ text: "Is the old server gone for good?" }), review]) });
const overridesFile = join(cliDir, "overrides.json");
const gary = (args, { overrides = {}, env = cli.env } = {}) => {
	writeFileSync(overridesFile, JSON.stringify(overrides));
	const r = spawnSync(process.execPath, [GARY, ...args], { env: { ...env, GARY_INSTANCE: "widgets", FAKE_GH_OVERRIDES: overridesFile }, encoding: "utf8" });
	let data = null;
	try {
		data = JSON.parse(r.stdout);
	} catch {
		// Not JSON
	}
	return { status: r.status, data, stdout: r.stdout, stderr: r.stderr };
};
const check = (overrides, args = ["api-edit", "--pr", "26"]) => gary(args, { overrides });
const says = (r, re) => r.status === 1 && r.data?.ok === false && re.test(r.data.result) && /Nothing was committed\.$/.test(r.data.result);

let r = check({});
const commit = r.data?.invocations?.[0]?.stdin?.variables?.input;
t.check("the dry run prints the one commit it would create", r.status === 0 && r.data.ok && r.data.dryRun && /createCommitOnBranch/.test(r.data.invocations[0].stdin.query) && r.data.invocations.length === 2, r);
t.check("the commit goes to the PR's head branch in the fork", commit?.branch?.repositoryNameWithOwner === "hubot/widgets" && commit.branch.branchName === "docs-update", commit);
t.check("the commit expects the reviewed head, so it fails when the branch moved", commit?.expectedHeadOid === EDIT_HEAD);
t.check("the commit carries the route's message", commit?.message?.headline === MESSAGE);
t.check("the commit holds the whole file with only the edit applied", commit?.fileChanges?.additions?.length === 1 && commit.fileChanges.additions[0].path === "CONTRIBUTING.md" && Buffer.from(commit.fileChanges.additions[0].contents, "base64").toString("utf8") === CONTRIBUTING.replace("wrong", "right") && commit.fileChanges.deletions === undefined, commit);
t.check("the commit and the comment run as the bot", r.data?.invocations.every((i) => i.as === BOT));
const body = r.data?.invocations?.[1]?.stdin?.variables?.body ?? "";
t.check("the comment says what changed and asks the route's question", /addComment/.test(r.data?.invocations?.[1]?.stdin?.query ?? "") && /I pushed a small text fix to this PR: .*\/pull\/26\/commits\/<sha>\n\nIt changes `CONTRIBUTING\.md`\.\n\nIs the old server gone for good\?$/.test(body), body);
t.check("the dry run shows the diff", /^--- CONTRIBUTING\.md\n-Join us on Discord: https:\/\/discord\.gg\/wrong\n\+Join us on Discord: https:\/\/discord\.gg\/right$/.test(r.data?.diff ?? ""), r.data?.diff);

t.check("a head that moved since the review is refused", says(check({ "pr-26": { headRefOid: "8".repeat(40) } }), /The PR head moved to 8888888 since the review/));
t.check("a closed PR is refused", says(check({ "pr-26": { state: "CLOSED" } }), /PR #26 is closed/) && says(check({ "pr-26": { state: "MERGED" } }), /already merged/));
t.check("a fork that does not allow edits by maintainers is refused", says(check({ "pr-26": { maintainerCanModify: false } }), /did not allow edits by maintainers/));
t.check("a deleted fork is refused", says(check({ "pr-26": { headRepository: null } }), /head repository is gone/));
t.check("a fork PR whose head is the base repository is refused", says(check({ "pr-26": { headRepository: { nameWithOwner: "acme/widgets" } } }), /claims to come from a fork/));
t.check("the default branch of the base repository is never the target", says(check({ "pr-26": { isCrossRepository: false, headRepository: { nameWithOwner: "acme/widgets" }, headRefName: "main" } }), /head branch is main/));
t.check("a same-repo PR must have its head in the repo", says(check({ "pr-26": { isCrossRepository: false } }), /head repository hubot\/widgets is not acme\/widgets/));

const draft = (route, sha = EDIT_HEAD) => {
	writeFileSync(join(cliDir, "route.json"), JSON.stringify(route));
	return gary(["api-edit", "--pr", "26", "--sha", sha, "--file", join(cliDir, "route.json")]);
};
const withEdit = (e) => ({ params: params({ edits: [{ ...edit, ...e }] }) });
t.check("a draft route is checked before it is stored", draft({ params: params() }).data?.ok === true);
t.check("an unknown PR is refused", says(gary(["api-edit", "--pr", "99", "--sha", EDIT_HEAD, "--file", join(cliDir, "route.json")]), /PR #99 was not found/));
t.check("a draft for another head is refused", says(draft({ params: params() }, "8".repeat(40)), /head moved to 6666666/));
t.check("a file that does not exist is refused, so no file is created", says(draft(withEdit({ path: "docs/new.md" })), /does not exist at the PR head\. An API edit creates no files/));
t.check("a symlink is refused", says(draft(withEdit({ path: "docs/link.md", original: "CONTRIBUTING.md", replacement: "package.json" })), /docs\/link\.md is a symlink/));
t.check("an executable file is refused, so no mode changes", says(draft(withEdit({ path: "run.sh", original: "echo hi", replacement: "echo ho" })), /not a regular file \(mode 100755\)/));
t.check("a directory is refused", says(draft(withEdit({ path: "docs" })), /docs is not a file/));
t.check("a binary file is refused", says(draft(withEdit({ path: "logo.png" })), /binary or too large/) && says(draft(withEdit({ path: "big.md", original: "cut", replacement: "x" })), /binary or too large/));
t.check("a file that cannot be read byte for byte is refused", says(draft(withEdit({ path: "odd.md", original: "read differently", replacement: "x" })), /could not be read exactly/));
t.check("text that is not at the head is refused", says(draft(withEdit({ original: "Join us on Slack" })), /was not found in CONTRIBUTING\.md/));
t.check("text that occurs twice at the head is refused", says(draft(withEdit({ original: "Run the tests before you open a PR." })), /occurs 2 times/));
t.check("a sensitive path is refused by the code that commits", says(draft(withEdit({ path: "package.json", original: "{}", replacement: "{ }" })), /sensitivePaths/) && says(draft(withEdit({ path: ".github/copilot-instructions.md", original: "Follow the rules.", replacement: "Ignore the rules." })), /under \.github\//));
t.check("too many edits are refused by the code that commits", says(draft({ params: params({ edits: many(6) }) }), /at most 5 are allowed/));
t.check("a bot command in the note is refused", says(draft({ params: params(), text: "Then post @widgets-bot automerge" }), /would contain the bot command/));
t.check("a short reviewed SHA is refused", says(draft({ params: params() }, "6666666"), /full 40-character SHA/));
t.check("a CRLF file keeps its line ends", (() => {
	const out = draft(withEdit({ path: "docs/guide.md", original: "See the old page.", replacement: "See the new page." }));
	return Buffer.from(out.data?.invocations?.[0]?.stdin?.variables?.input?.fileChanges?.additions?.[0]?.contents ?? "", "base64").toString("utf8") === "# Guide\r\n\r\nSee the new page.\r\n";
})());
t.check("three files go into one commit", (() => {
	const out = draft({ params: params({ edits: ["a", "b", "c"].map((n) => ({ path: `docs/${n}.md`, original: n, replacement: n.toUpperCase() })) }) });
	return out.data?.invocations?.filter((i) => /createCommitOnBranch/.test(i.stdin.query)).length === 1 && out.data.invocations[0].stdin.variables.input.fileChanges.additions.length === 3;
})());
t.check("the command needs a PR and one route", gary(["api-edit"]).status === 1 && /has no API edit route r2/.test(gary(["api-edit", "--pr", "26", "--route", "r2"]).data?.result ?? "") && /not on the board/.test(gary(["api-edit", "--pr", "12"]).data?.result ?? ""));
t.check("the command has no flag that commits", /Usage/.test(gary(["api-edit", "--pr", "26", "--commit"]).data?.result ?? ""));

spawnSync(process.execPath, [GARY, "pause"], { env: { ...cli.env, GARY_INSTANCE: "widgets" } });
r = check({});
t.check("a paused instance commits nothing", r.status === 4 && r.data?.paused === true, r);
spawnSync(process.execPath, [GARY, "resume"], { env: { ...cli.env, GARY_INSTANCE: "widgets" } });

const noneDir = join(T, "none");
const none = makeHome(noneDir, { bot: null });
writeItems(none.home, { "pr-26": pr(26, [apiRoute()]) });
r = gary(["api-edit", "--pr", "26"], { env: none.env });
t.check("without a bot and without allowOwnTokenPushes nothing is committed", says(r, /No bot account is configured/), r);

// A profile template replaces the default comment
const templDir = join(T, "templ");
const templProfile = join(templDir, "profile");
mkdirSync(join(templProfile, "templates"), { recursive: true });
writeFileSync(join(templProfile, "profile.json"), JSON.stringify(profile));
writeFileSync(join(templProfile, "templates", "api-edit.md"), "<!-- The comment after an API edit -->\nFixed in {commit} ({files}). Thanks!\n");
const templ = makeHome(templDir, { profile: templProfile });
writeItems(templ.home, { "pr-26": pr(26, [apiRoute()]) });
r = gary(["api-edit", "--pr", "26"], { env: templ.env });
t.check("the profile's template words the comment", /^Fixed in \S+\/pull\/26\/commits\/<sha> \(`CONTRIBUTING\.md`\)\. Thanks!$/.test(r.data?.invocations?.[1]?.stdin?.variables?.body ?? ""), r.data);

// `gary put` validates with the snapshot's sensitive files
writeFileSync(join(cli.home, "state", "snapshot.json"), JSON.stringify(sensitiveSnapshot));
const put = (item) => {
	writeFileSync(join(cliDir, "item.json"), JSON.stringify(item));
	return gary(["put", "items", "pr-26", join(cliDir, "item.json")]);
};
t.check("gary put accepts the API take-over on a sensitive PR", put(pr(26, [apiRoute(), review])).status === 0);
r = put(pr(26, [{ id: "r1", type: "take_over", as: "agent", title: "Take over: fix it", recommended: true }]));
t.check("gary put refuses a checkout take-over on a sensitive PR", r.status === 1 && /only allowed as an API edit/.test(r.stdout), r.stdout);
r = put(pr(26, [apiRoute({}, { edits: [{ ...edit, path: "package.json" }] })]));
t.check("gary put refuses an edit of a sensitive file", r.status === 1 && /sensitivePaths/.test(r.stdout), r.stdout);

// ---------- the click ----------
async function startServer(home, port, args, extraEnv) {
	const child = spawn(process.execPath, [join(ROOT, "server/server.mjs"), ...args, "--port", String(port)], { env: { ...home.env, ...extraEnv }, stdio: ["ignore", "inherit", "pipe"] });
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
	return { child, api, item, click };
}
const actionsOf = (home) => readdirSync(join(home, "state", "board", "actions")).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(home, "state", "board", "actions", n), "utf8")));
const stored = (home, id) => JSON.parse(readFileSync(join(home, "state", "board", "items", id + ".json"), "utf8"));
const writesOf = (file) => {
	try {
		return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};
const refusedClick = (res, re) => res.status === 200 && res.data.ok === false && re.test(res.data.result);

const liveDir = join(T, "live");
const livePort = await freePort();
const live = makeHome(liveDir, { port: livePort });
const agentRoute = (type, extra = {}) => ({ id: "r1", type, as: "agent", title: `${type}: x`, recommended: true, ...extra });
writeItems(live.home, {
	"pr-26": pr(26, [apiRoute({ text: "Is the old server gone for good?" }), review]),
	// Checkout routes an older triage left on PRs with sensitive files
	"pr-27": pr(27, [agentRoute("revise", { text: "Fix the link" }), { ...agentRoute("drive"), id: "r2", recommended: false }, { ...agentRoute("address_review"), id: "r3", recommended: false }, { ...agentRoute("format"), id: "r4", recommended: false }], { authorType: "maintainer", threads: [{ id: "PRRT_1", verdict: "valid" }], autofix: { changes: true, files: 1, lines: 2, tools: ["fmt"] } }),
	"pr-25": pr(25, [agentRoute("take_over", { title: "Take over: fix it" })]),
	"pr-12": pr(12, [agentRoute("take_over", { title: "Take over: fix it" })]),
});
writeFileSync(join(live.home, "state", "snapshot.json"), JSON.stringify({ items: { ...sensitiveSnapshot.items, "pr-25": { kind: "pr", number: 25, sensitiveFiles: ["package.json"] } } }));
const stub = join(liveDir, "stub.json");
const setStub = (data) => writeFileSync(stub, JSON.stringify({ "*": { state: "OPEN" }, ...data }));
setStub({});
const writes = join(liveDir, "writes.log");
const liveOverrides = join(liveDir, "overrides.json");
writeFileSync(liveOverrides, "{}");
const server = await startServer(live, livePort, [], { GARY_GUARD_STUB: stub, FAKE_GH_WRITES: writes, FAKE_GH_OVERRIDES: liveOverrides });

try {
	let served = await server.item("pr-26");
	t.check("the board serves the API take-over with the bot as its actor", served.routes[0].type === "take_over" && served.routes[0].actor === "bot" && served.routes[0].params.via === "api" && served.sensitive?.files?.[0] === ".github/copilot-instructions.md", served.routes[0]);

	// Checkout routes on sensitive PRs are refused at the click
	t.check("a checkout take-over on a sensitive PR is refused at the click", refusedClick(await server.click("pr-25"), /only allowed as an API edit/));
	t.check("a checkout change on a sensitive PR is refused at the click", refusedClick(await server.click("pr-27", "r1"), /only allowed as an API edit/));
	for (const [id, type] of [["r2", "drive"], ["r3", "address_review"], ["r4", "format"]]) {
		t.check(`${type} on a sensitive PR is refused at the click`, refusedClick(await server.click("pr-27", id, type === "address_review" ? { input: { decisions: [{ threadId: "PRRT_1", decision: "fix" }] } } : {}), new RegExp(`does not run ${type}`)));
	}
	let res = await server.click("pr-12");
	t.check("without sensitive files the checkout take-over is queued as before", res.data.ok === true && res.data.queued === true, res);
	t.check("no refused click wrote to GitHub", writesOf(writes).length === 0);

	// Refusals of the API edit at the click
	t.check("the API edit takes no input", refusedClick(await server.click("pr-26", "r1", { input: { decisions: [] } }), /unknown field/));
	setStub({ "acme/widgets#26": { state: "OPEN", headSha: "8".repeat(40) } });
	res = await server.click("pr-26");
	t.check("a moved head is refused and cannot be forced", refusedClick(res, /head moved to 8888888/) && res.data.forceable === false, res);
	res = await server.click("pr-26", "r1", { force: true });
	t.check("force does not pass a moved head", refusedClick(res, /head moved/), res);
	setStub({ "acme/widgets#26": { state: "OPEN", comments: [{ author: { login: "hubot", __typename: "User" }, at: later }] } });
	res = await server.click("pr-26");
	t.check("a newer comment by a person is refused with the option to go on", refusedClick(res, /hubot commented/) && res.data.forceable === true, res);
	setStub({ "acme/widgets#26": { state: "CLOSED" } });
	t.check("a closed PR is refused", refusedClick(await server.click("pr-26"), /#26 is closed/));
	setStub({});
	writeFileSync(liveOverrides, JSON.stringify({ branchHead: "8".repeat(40) }));
	res = await server.click("pr-26");
	t.check("a branch that moved between the read and the commit fails the commit", refusedClick(res, /GitHub refused the commit: .*Expected branch to point to.* Nothing was committed\.$/), res);
	t.check("the failed commit left a failed action doc and no follow-up", actionsOf(live.home).filter((a) => a.itemId === "pr-26").length === 1 && actionsOf(live.home).find((a) => a.itemId === "pr-26").status === "failed" && stored(live.home, "pr-26").pushed === undefined && stored(live.home, "pr-26").takenOver === undefined && writesOf(writes).length === 0, actionsOf(live.home));
	writeFileSync(liveOverrides, "{}");

	spawnSync(process.execPath, [GARY, "pause"], { env: { ...live.env, GARY_INSTANCE: "widgets" } });
	res = await server.click("pr-26");
	t.check("a paused instance refuses the click", res.data.ok === false && res.data.paused === true && writesOf(writes).length === 0, res);
	spawnSync(process.execPath, [GARY, "resume"], { env: { ...live.env, GARY_INSTANCE: "widgets" } });

	// The happy path
	res = await server.click("pr-26", "r1", { text: "Is the old Discord server gone for good?" });
	const commitUrl = `https://github.com/acme/widgets/pull/26/commits/${NEW_HEAD}`;
	t.check("the click commits and answers with the commit", res.status === 200 && res.data.ok === true && res.data.result === commitUrl && res.data.queued === undefined, res);
	const sent = writesOf(writes);
	t.check("GitHub got one commit and one comment, both as the bot", sent.length === 2 && sent[0].mutation === "createCommitOnBranch" && sent[1].mutation === "addComment" && sent.every((w) => w.as === BOT), sent);
	const input = sent[0]?.variables?.input;
	t.check("the commit went to the fork's branch and expected the reviewed head", input?.branch?.repositoryNameWithOwner === "hubot/widgets" && input.branch.branchName === "docs-update" && input.expectedHeadOid === EDIT_HEAD && input.message.headline === MESSAGE, input);
	t.check("the commit changed one file and deleted none", input?.fileChanges?.additions?.length === 1 && Buffer.from(input.fileChanges.additions[0].contents, "base64").toString("utf8") === CONTRIBUTING.replace("wrong", "right") && !("deletions" in input.fileChanges));
	t.check("the comment links the commit and carries the edited note", sent[1]?.variables?.id === "PR_26" && sent[1].variables.body === `I pushed a small text fix to this PR: ${commitUrl}\n\nIt changes \`CONTRIBUTING.md\`.\n\nIs the old Discord server gone for good?`, sent[1]);
	const docs = actionsOf(live.home).filter((a) => a.itemId === "pr-26");
	const done = docs.find((a) => a.status === "done");
	t.check("the action doc is a finished take-over with the commit", done?.action === "take_over" && done.via === "server" && done.result === commitUrl && done.resultParts?.commits?.[0] === commitUrl && done.params.via === "api" && done.edited === true && /issuecomment-950$/.test(done.commentUrl), done);
	const reviewDoc = docs.find((a) => a.action === "full_review");
	t.check("a full review of the new head is queued", reviewDoc?.status === "queued" && reviewDoc.via === "queue" && reviewDoc.params.by === "api_edit" && reviewDoc.params.pushed.sha === NEW_HEAD && reviewDoc.params.number === 26 && reviewDoc.routeId === undefined, reviewDoc);
	const after = stored(live.home, "pr-26");
	t.check("the item is taken over and names the push", after.takenOver === true && after.pushed?.action === "take_over" && after.pushed.sha === NEW_HEAD && Number.isFinite(Date.parse(after.pushed.at)) && after.reviewedSha === EDIT_HEAD, after.pushed);
	t.check("the item links our commit and is handled", after.links?.some((l) => l.label === "Our commit" && l.url === commitUrl) && after.handled?.routeId === "r1" && after.handled.verified === "commented", after);
	served = await server.item("pr-26");
	t.check("the route is served as done with the commit", served.routes[0].done?.status === "done" && served.routes[0].done.result === commitUrl, served.routes[0]);
	t.check("the board shows the queued review as work in progress", served.working?.kind === "review", served.working);
	const queue = spawnSync(process.execPath, [GARY, "watch-queue", "--once"], { env: { ...live.env, GARY_INSTANCE: "widgets" }, encoding: "utf8" });
	t.check("the queue watcher prints the review request", queue.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).some((l) => l.itemId === "pr-26" && l.action === "full_review"), queue.stdout);
	t.check("an API edit on a sensitive PR that is not ours alone requests no review bot round", !existsSync(join(live.home, "state", "drive", "pr-26.json")) && !docs.some((a) => a.action === "drive") && reviewDoc?.params.reviewBotRound === undefined, docs);
	res = await server.click("pr-26");
	t.check("a second click is refused", res.status === 409 && writesOf(writes).length === 2, res);
} finally {
	server.child.kill();
}

// A change to a PR we control, under the maintainer's login
const ownDir = join(T, "own");
const ownPort = await freePort();
const own = makeHome(ownDir, { port: ownPort, bot: null, allowOwnTokenPushes: true });
writeItems(own.home, { "pr-27": pr(27, [apiRoute({ type: "revise", title: "Change: fix the Discord link" })], { authorType: "maintainer", author: ME }) });
writeFileSync(join(own.home, "state", "snapshot.json"), JSON.stringify(sensitiveSnapshot));
const ownWrites = join(ownDir, "writes.log");
const ownStub = join(ownDir, "stub.json");
writeFileSync(ownStub, JSON.stringify({ "*": { state: "OPEN" } }));
const ownServer = await startServer(own, ownPort, [], { GARY_GUARD_STUB: ownStub, FAKE_GH_WRITES: ownWrites });
try {
	const served = await ownServer.item("pr-27");
	t.check("in own mode the API change runs under the maintainer's login", served.routes[0].type === "revise" && served.routes[0].actor === "own", served.routes[0]);
	const res = await ownServer.click("pr-27");
	const sent = writesOf(ownWrites);
	t.check("the change commits to the branch of the repo", res.data.ok === true && sent[0]?.variables?.input?.branch?.repositoryNameWithOwner === "acme/widgets" && sent[0].variables.input.branch.branchName === "gary/docs" && sent.every((w) => w.as === ME), sent);
	t.check("the comment of a change without a note has no empty paragraph", /`CONTRIBUTING\.md`\.$/.test(sent[1]?.variables?.body ?? ""), sent[1]);
	const after = stored(own.home, "pr-27");
	t.check("a change sets no takenOver", after.takenOver === undefined && after.pushed?.action === "revise" && after.pushed.sha === NEW_HEAD, after);
} finally {
	ownServer.child.kill();
}

// An API edit on a PR without sensitive files makes it watched, and the next review bot round follows
const roundDir = join(T, "round");
const roundPort = await freePort();
const round = makeHome(roundDir, { port: roundPort });
writeItems(round.home, { "pr-26": pr(26, [apiRoute()]) });
const roundWrites = join(roundDir, "writes.log");
const roundStub = join(roundDir, "stub.json");
writeFileSync(roundStub, JSON.stringify({ "*": { state: "OPEN" } }));
const roundServer = await startServer(round, roundPort, [], { GARY_GUARD_STUB: roundStub, FAKE_GH_WRITES: roundWrites });
try {
	const res = await roundServer.click("pr-26");
	const sent = writesOf(roundWrites);
	t.check("after the commit the Copilot review is requested under the maintainer's login", res.data.ok === true && sent.length === 3 && sent[2].mutation === "requestCopilotCodeReview" && sent[2].as === ME && sent[2].variables.id === "PR_26", sent);
	const drive = JSON.parse(readFileSync(join(round.home, "state", "drive", "pr-26.json"), "utf8"));
	const docs = actionsOf(round.home);
	const driveDoc = docs.find((a) => a.action === "drive");
	t.check("the PR waits in the stage review with a claimed drive doc", drive.stage === "review" && drive.botRounds?.copilot?.rounds === 1 && drive.botRounds.copilot.sha === NEW_HEAD && drive.lastPushedSha === NEW_HEAD && drive.actionId && driveDoc?.status === "queued" && driveDoc.result === "claimed by run server" && driveDoc.params.after === "api_edit" && driveDoc.params.by === "watch", [drive, driveDoc]);
	t.check("the queued full review names the round", docs.find((a) => a.action === "full_review")?.params.reviewBotRound === 1, docs);
} finally {
	roundServer.child.kill();
}

// A dry-run server shows the writes and commits nothing
const dryDir = join(T, "dry");
const dryPort = await freePort();
const dry = makeHome(dryDir, { port: dryPort });
writeItems(dry.home, { "pr-26": pr(26, [apiRoute()]) });
const dryWrites = join(dryDir, "writes.log");
const dryStub = join(dryDir, "stub.json");
writeFileSync(dryStub, JSON.stringify({ "*": { state: "OPEN" } }));
const dryServer = await startServer(dry, dryPort, ["--dry-run"], { GARY_GUARD_STUB: dryStub, FAKE_GH_WRITES: dryWrites });
try {
	const res = await dryServer.click("pr-26");
	t.check("a dry-run server answers with the invocations", res.data.ok === true && res.data.result?.dryRun === true && res.data.result.invocations.length === 2, res);
	t.check("a dry-run server commits nothing and queues no review", writesOf(dryWrites).length === 0 && stored(dry.home, "pr-26").pushed === undefined && !actionsOf(dry.home).some((a) => a.action === "full_review"));
} finally {
	dryServer.child.kill();
}

removeDir(T);
t.done();
