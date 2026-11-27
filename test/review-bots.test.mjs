// Several GitHub review bots: the profile and config forms, an old Copilot setup that sends what it sent before, the
// trigger comment and who posts it, the refusal of trigger texts in agent-written text, one ask per head and bot,
// the arrival of a round on its head, and the open threads that keep a round from being clean. Runs offline against the fake gh.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, PROFILE, makeHome, removeDir, runner, tempDir } from "./lib.mjs";
import { runCompat } from "./fixtures/copilot-compat.mjs";

const t = runner("review-bots");

// ---------- an old Copilot setup sends what the code before several bots sent ----------
// Recorded with the code before several review bots, against the same fake gh
const BEFORE = [
	{ name: "start, dry run", status: 0, writes: [], invocations: [{ as: "octocat", query: "mutation($id: ID!) { requestCopilotCodeReview(input: { pullRequestId: $id }) { success failureReason } }", variables: { id: "PR_19" } }] },
	{ name: "start", status: 0, writes: [{ mutation: "requestCopilotCodeReview", variables: { id: "PR_19" }, as: "octocat" }] },
	{ name: "watch-queue", status: 0, writes: [] },
	{ name: "fixes", status: 0, writes: [], review: 2 },
	{ name: "pr-watch list", status: 0, writes: [], rounds: { used: 2, cap: 3 } },
	{ name: "third round", status: 0, writes: [{ mutation: "requestCopilotCodeReview", variables: { id: "PR_19" }, as: "octocat" }], round: 3, untouched: true },
	{ name: "fourth round refused", status: 3, writes: [] },
	{ name: "finish", status: 0, writes: [{ mutation: "markPullRequestReadyForReview", variables: { id: "PR_19" }, as: "widgets-bot" }] },
	{ name: "request_review action", status: 0, writes: [{ mutation: "requestCopilotCodeReview", variables: { id: "PR_19" }, as: "octocat" }] },
	{ name: "start as the bot", status: 0, writes: [{ mutation: "requestCopilotCodeReview", variables: { id: "PR_19" }, as: "widgets-bot" }] },
	{ name: "revise push", status: 0, writes: [{ mutation: "requestCopilotCodeReview", variables: { id: "PR_19" }, as: "octocat" }] },
];
const compat = runCompat(GARY);
for (const [i, want] of BEFORE.entries()) {
	t.check(`old Copilot setup: ${want.name} sends what it sent before`, JSON.stringify(compat.steps[i]) === JSON.stringify(want), [compat.steps[i], want]);
}
t.check("old Copilot setup: config.json and profile.json stay as they are", compat.unchanged === true);

// ---------- an instance with three review bots ----------
const T = tempDir();
const profileDir = join(T, "profile");
cpSync(PROFILE, profileDir, { recursive: true });
const baseProfile = JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8"));
const TRIGGER = "@octobot2 review";
const BOTS = ["copilot", { login: "octobot", trigger: "request" }, { login: "OctoBot2", trigger: { comment: TRIGGER } }];
writeFileSync(join(profileDir, "profile.json"), JSON.stringify({ ...baseProfile, reviewBots: BOTS }));
const { home, env: baseEnv, root } = makeHome(T, { profile: profileDir });
const WRITES = join(T, "gh-writes.jsonl");
const OVERRIDES = join(T, "overrides.json");
writeFileSync(OVERRIDES, "{}");
const env = { ...baseEnv, FAKE_GH_WRITES: WRITES, FAKE_GH_OVERRIDES: OVERRIDES };
const state = join(home, "state");
const actionsDir = join(state, "board", "actions");
const driveFile = join(state, "drive", "pr-19.json");
const SHA = "9".repeat(40);
const NEXT = "a".repeat(40);
const gary = (...args) => spawnSync(process.execPath, [GARY, ...args], { env, encoding: "utf8" });
const act = (request, ...flags) => spawnSync(process.execPath, [GARY, "action", ...flags], { env, input: JSON.stringify(request), encoding: "utf8" });
const json = (r) => {
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { unparsed: r.stdout + r.stderr };
	}
};
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const writes = () => (existsSync(WRITES) ? readFileSync(WRITES, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const editConfig = (fn) => writeFileSync(join(home, "config.json"), JSON.stringify(fn(read(join(home, "config.json")))));
const reset = () => {
	rmSync(join(state, "drive"), { recursive: true, force: true });
	rmSync(actionsDir, { recursive: true, force: true });
	mkdirSync(actionsDir, { recursive: true });
	rmSync(WRITES, { force: true });
	writeFileSync(OVERRIDES, "{}");
};

process.env.GARY_HOME = root;
delete process.env.GARY_INSTANCE;
const c = await import("../scripts/lib/config.mjs");
const rb = await import("../scripts/lib/review-bots.mjs");
const { botStates, roundClean } = await import("../scripts/lib/watch.mjs");
const { driveEvent } = await import("../scripts/watch-queue.mjs");
const { validateItem } = await import("../scripts/lib/validate-item.mjs");
const { apiEditProblems } = await import("../scripts/lib/api-edit.mjs");
const { botCommandIn, pendingRouteProblems } = await import("../scripts/lib/review-drafts.mjs");
const { feedbackFacts } = await import("../scripts/lib/facts.mjs");

// ---------- profile.reviewBots ----------
const profileErrors = (reviewBots) => c.checkProfile({ name: "x", repo: "acme/widgets", reviewBots });
const errorsOf = (reviewBots) => profileErrors(reviewBots).errors;
t.check("every form of reviewBots is valid", errorsOf(BOTS).length === 0 && profileErrors(BOTS).unknown.length === 0 && errorsOf([]).length === 0, profileErrors(BOTS));
t.check("a string other than copilot is refused", errorsOf(["octobot"]).some((e) => /"reviewBots\[0\]" must be "copilot" or an object/.test(e)));
t.check("reviewBots must be a list", errorsOf("copilot").some((e) => /"reviewBots" must be a list/.test(e)));
t.check("an entry that is no object is refused", errorsOf([7]).some((e) => /"reviewBots\[0\]" must be/.test(e)) && errorsOf([null]).length === 1);
t.check("an unknown field of a bot is unknown", profileErrors([{ login: "octobot", trigger: "request", wait: 5 }]).unknown.includes('unknown field "reviewBots[0].wait"'));
t.check("an unknown field of a trigger is unknown", profileErrors([{ login: "octobot", trigger: { comment: "@octobot review", at: "start" } }]).unknown.includes('unknown field "reviewBots[0].trigger.at"'));
t.check("an empty login is refused", errorsOf([{ login: "", trigger: "request" }]).some((e) => /"reviewBots\[0\].login" must be the bot's GitHub login/.test(e)) && errorsOf([{ trigger: "request" }]).length === 1);
for (const login of ["octo_bot", "-octobot", "octobot-", "octo--bot", "octobot[bot]", "a".repeat(40), "octo bot"]) {
	t.check(`the login ${login} is refused`, errorsOf([{ login, trigger: "request" }]).some((e) => /must be a GitHub login without "\[bot\]"/.test(e)), errorsOf([{ login, trigger: "request" }]));
}
t.check("a login of 39 characters with single hyphens is valid", errorsOf([{ login: "octo-bot-" + "a".repeat(30), trigger: "request" }]).length === 0);
t.check("Copilot as a login bot is refused", errorsOf([{ login: "Copilot", trigger: "request" }]).some((e) => /write Copilot as "copilot"/.test(e)));
t.check("a missing or unknown trigger is refused", errorsOf([{ login: "octobot" }]).some((e) => /"reviewBots\[0\].trigger" must be "request" or/.test(e)) && errorsOf([{ login: "octobot", trigger: "mention" }]).length === 1 && errorsOf([{ login: "octobot", trigger: ["x"] }]).length === 1);
t.check("an empty trigger comment is refused", errorsOf([{ login: "octobot", trigger: { comment: "  " } }]).some((e) => /trigger.comment" must be the comment/.test(e)) && errorsOf([{ login: "octobot", trigger: {} }]).length === 1);
t.check("a multi-line trigger comment is refused", errorsOf([{ login: "octobot", trigger: { comment: "@octobot\nreview" } }]).some((e) => /must be one line/.test(e)) && errorsOf([{ login: "octobot", trigger: { comment: "@octobot\rreview" } }]).length === 1);
t.check("a trigger comment over 200 characters is refused", errorsOf([{ login: "octobot", trigger: { comment: "x".repeat(201) } }]).some((e) => /longer than 200 characters/.test(e)) && errorsOf([{ login: "octobot", trigger: { comment: "x".repeat(200) } }]).length === 0);
t.check("copilot twice is refused", errorsOf(["copilot", "copilot"]).some((e) => /"reviewBots\[1\]" names the review bot "copilot" a second time/.test(e)));
t.check("the same login in another case is refused", errorsOf([{ login: "octobot", trigger: "request" }, { login: "OctoBot", trigger: { comment: "@octobot review" } }]).some((e) => /names the review bot "octobot" a second time/.test(e)));
t.check("the bot keys are copilot and the logins in lower case", JSON.stringify(rb.profileReviewBots({ reviewBots: BOTS }).map((b) => b.key)) === '["copilot","octobot","octobot2"]');
t.check("loadInstance takes the profile with three bots", c.loadInstance("widgets").profile.reviewBots.length === 3);

// ---------- config.json review and fixReview ----------
const base = { profile: "p", me: "octocat" };
const configErrors = (data) => c.checkConfig({ ...base, ...data });
t.check("review.github takes profile, an empty list and bot keys", ["profile", [], ["copilot"], ["copilot", "OctoBot"]].every((github) => configErrors({ review: { github } }).errors.length === 0) && configErrors({ review: {} }).errors.length === 0);
t.check("review.github refuses another word, a key that is no login and a key twice", configErrors({ review: { github: "all" } }).errors.some((e) => /"review.github" must be "profile" or a list/.test(e)) && configErrors({ review: { github: ["octo_bot"] } }).errors.length === 1 && configErrors({ review: { github: [1] } }).errors.length === 1 && configErrors({ review: { github: ["octobot", "OctoBot"] } }).errors.some((e) => /names a review bot twice/.test(e)));
t.check("review must be an object", configErrors({ review: "profile" }).errors.some((e) => /"review" must be/.test(e)) && configErrors({ review: ["copilot"] }).errors.length === 1);
t.check("review.local and review.maxLocalPasses are fields now", configErrors({ review: { local: [], maxLocalPasses: 2 } }).unknown.length === 0 && configErrors({ review: { local: [], maxLocalPasses: 2 } }).errors.length === 0);
t.check("a contributions instance takes review but no review.github", c.checkConfig({ kind: "contributions", me: "octocat", review: { github: [] } }).errors.some((e) => /"review.github" is only for maintainer instances/.test(e)) && c.checkConfig({ kind: "contributions", me: "octocat", review: { local: "off" } }).errors.length === 0);
t.check("fixReview.maxRounds takes 0", configErrors({ fixReview: { maxRounds: 0 } }).errors.length === 0 && configErrors({ fixReview: { maxRounds: -1 } }).errors.length === 1);
const profile3 = { reviewBots: BOTS };
const keys = (config) => rb.activeReviewBots(config, profile3).bots.map((b) => b.key).join(",");
t.check("review.github profile takes all of the profile's bots", keys({}) === "copilot,octobot,octobot2" && keys({ review: { github: "profile" } }) === "copilot,octobot,octobot2");
t.check("an empty review.github skips the GitHub bots", keys({ review: { github: [] } }) === "");
t.check("a list picks a subset in the profile's order and names the keys it does not know", keys({ review: { github: ["OctoBot2", "copilot", "octocat"] } }) === "copilot,octobot2" && JSON.stringify(rb.activeReviewBots({ review: { github: ["octocat"] } }, profile3).missing) === '["octocat"]');
const withBot = { ...base, bot: { login: "widgets-bot", tokenFile: "t" } };
t.check("fix rounds ask the bots review.github picks", JSON.stringify(c.fixReviewOf({ ...withBot, review: { github: ["octobot"] } }, profile3).bots.map((b) => b.key)) === '["octobot"]');
t.check("without a bot picked a fix PR skips the rounds", (() => {
	const fr = c.fixReviewOf({ ...withBot, review: { github: [] } }, profile3);
	return fr.on === false && fr.noReviewBot === true && /no review bot is picked: review.github in config.json names none/.test(fr.reason);
})());

// ---------- the bots of a fix PR's rounds: request, REST request and trigger comment ----------
gary("fix-record", "issue-23", "--pr", "19", "--branch", "triage/issue-23", "--run", "run-1", "--by", "routine");
gary("snapshot");
let r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-1", "--dry-run");
let o = json(r);
t.check("a dry run names the three asks and sends nothing", r.status === 0 && o.invocations?.length === 3 && /requestCopilotCodeReview/.test(o.invocations[0].stdin?.query) && o.invocations[1].command.join(" ") === "gh api repos/acme/widgets/pulls/19/requested_reviewers --method POST -f reviewers[]=octobot" && o.invocations[2].stdin?.variables?.body === TRIGGER && writes().length === 0, o);
r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-1");
o = json(r);
const asked = writes();
t.check("start asks every bot under the maintainer's login", r.status === 0 && o.started === true && asked.length === 3 && asked.every((w) => w.as === "octocat"), [o, asked]);
t.check("Copilot gets its review request", asked[0]?.mutation === "requestCopilotCodeReview" && asked[0].variables.id === "PR_19");
t.check("a request bot gets a REST review request for its login", JSON.stringify(asked[1]) === JSON.stringify({ rest: "requested_reviewers", repo: "acme/widgets", number: 19, reviewers: ["octobot"], as: "octocat" }), asked[1]);
t.check("postReviewTrigger posts exactly the profile's comment on the PR", asked[2]?.mutation === "addComment" && asked[2].variables.body === TRIGGER && asked[2].variables.id === "PR_19", asked[2]);
let drive = read(driveFile);
t.check("the drive file holds the round's bots without the trigger text", JSON.stringify(drive.reviewBots) === '[{"key":"copilot","trigger":"copilot"},{"key":"octobot","login":"octobot","trigger":"request"},{"key":"octobot2","login":"OctoBot2","trigger":"comment"}]' && !JSON.stringify(drive).includes(TRIGGER), drive);
t.check("the drive file records the round and the head per bot", ["copilot", "octobot", "octobot2"].every((k) => drive.botRounds?.[k]?.rounds === 1 && drive.botRounds[k].sha === SHA) && drive.copilotRounds === undefined && drive.reviewBot === undefined, drive.botRounds);
t.check("the issue's chip names the bots of the round", JSON.stringify(json(gary("fixes", "--json"))["issue-23"].review) === '{"reviewers":["Copilot","octobot","OctoBot2"],"round":1,"maxRounds":3}');

// One ask per head and bot
r = gary("pr-watch", "review", "--pr", "19", "--sha", SHA, "--action", drive.actionId);
t.check("a second ask on the same head is refused and sends nothing", r.status === 3 && /already asked to review 9999999 on PR #19/.test(json(r).result) && writes().length === 3, r.stdout);
r = gary("pr-watch", "review", "--pr", "19", "--sha", SHA.slice(0, 7), "--action", drive.actionId);
t.check("a short SHA of the same head is refused too", r.status === 3 && writes().length === 3, r.stdout);
r = gary("pr-watch", "review", "--pr", "19", "--sha", NEXT, "--action", drive.actionId);
o = json(r);
t.check("a new head asks every bot again", r.status === 0 && o.round === 2 && writes().length === 6 && writes().slice(3).map((w) => w.mutation ?? w.rest).join() === "requestCopilotCodeReview,requested_reviewers,addComment", [o, writes()]);
t.check("the next round records the new head per bot", Object.values(read(driveFile).botRounds).every((b) => b.rounds === 2 && b.sha === NEXT));

// The bot account asks when requestAs is bot
reset();
editConfig((cfg) => ({ ...cfg, fixReview: { requestAs: "bot" } }));
r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-2");
t.check("with requestAs bot the bot asks every bot, the trigger comment included", r.status === 0 && writes().length === 3 && writes().every((w) => w.as === "widgets-bot") && writes()[2].variables.body === TRIGGER, writes());
editConfig((cfg) => ({ ...cfg, fixReview: undefined }));

// review.github picks the bots
reset();
editConfig((cfg) => ({ ...cfg, review: { github: ["octobot2"] } }));
r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-3");
t.check("review.github with one key asks only that bot", r.status === 0 && writes().length === 1 && writes()[0].variables.body === TRIGGER && read(driveFile).reviewBots.length === 1, writes());
r = gary("doctor");
t.check("doctor names the bots and how each is asked", /review bots\s+after a push to a watched PR Gary asks octobot2 by the comment "@octobot2 review", as review.github picks/.test(r.stdout), r.stdout.slice(0, 3000));
reset();
editConfig((cfg) => ({ ...cfg, review: { github: [] } }));
r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-4");
t.check("an empty review.github skips the rounds of a fix PR", r.status === 0 && json(r).started === false && /^No review bot is picked: review.github in config.json names none of the profile's, so the fix PR gets no review rounds\./.test(json(r).skipped) && !writes().some((w) => w.mutation === "requestCopilotCodeReview" || w.rest || w.mutation === "addComment"), [r.stdout, writes()]);
editConfig((cfg) => ({ ...cfg, review: { github: ["octobot", "octocat"] } }));
r = gary("doctor");
t.check("doctor warns about a key the profile does not list", /warn\s+review bots\s+.*review.github names octocat, which the profile's reviewBots does not list/.test(r.stdout), r.stdout.slice(0, 3000));
editConfig((cfg) => ({ ...cfg, review: undefined }));

// fixReview.maxRounds 0: no rounds for fix PRs, while other PRs still ask the bots
reset();
editConfig((cfg) => ({ ...cfg, fixReview: { maxRounds: 0 } }));
r = gary("fix-review", "start", "--pr", "19", "--sha", SHA, "--run", "run-5");
t.check("maxRounds 0 starts no rounds and keeps the PR a draft", r.status === 0 && json(r).started === false && /maxRounds is 0/.test(json(r).reason) && writes().length === 0 && !existsSync(driveFile), r.stdout);
writeFileSync(join(actionsDir, "pr-19-revise.json"), JSON.stringify({ itemId: "pr-19", action: "revise", params: {}, text: "Rename it.", status: "queued", via: "queue", createdAt: new Date().toISOString(), finishedAt: null, result: "claimed by run req-1" }));
r = gary("pr-watch", "review", "--pr", "19", "--sha", NEXT, "--after", "pr-19-revise", "--run", "req-1");
t.check("maxRounds 0 gives a pushed fix PR no review bot round", r.status === 0 && json(r).requested === false && /maxRounds is 0/.test(json(r).skipped) && writes().length === 0, r.stdout);
writeFileSync(join(state, "fixes.json"), "{}");
writeFileSync(join(state, "snapshot.json"), JSON.stringify({ items: { "pr-19": { author: "widgets-bot", headSha: SHA, feedback: {} } } }));
r = gary("pr-watch", "review", "--pr", "19", "--sha", NEXT, "--after", "pr-19-revise", "--run", "req-1");
t.check("a bot PR that is no fix PR still asks the bots", r.status === 0 && json(r).requested === true && writes().length === 3, [r.stdout, writes()]);
editConfig((cfg) => ({ ...cfg, fixReview: undefined }));

// ---------- the request_review action ----------
reset();
r = act({ kind: "pr", number: 19, action: "request_review", params: { reviewer: "OctoBot" }, text: "" });
t.check("request_review requests a request bot's review through REST", r.status === 0 && JSON.stringify(writes()) === JSON.stringify([{ rest: "requested_reviewers", repo: "acme/widgets", number: 19, reviewers: ["octobot"], as: "octocat" }]), [r.stdout, writes()]);
r = act({ kind: "pr", number: 19, action: "request_review", params: { reviewer: "octobot", as: "bot" }, text: "" });
t.check("request_review asks a request bot as the bot", r.status === 0 && writes().at(-1)?.as === "widgets-bot");
r = act({ kind: "pr", number: 19, action: "request_review", params: { reviewer: "octobot2" }, text: "" });
t.check("no gary action posts a trigger comment", r.status === 1 && /trigger \\"request\\"|trigger "request"/.test(json(r).result) && writes().length === 2, r.stdout);
r = act({ kind: "pr", number: 19, action: "request_review", params: { reviewer: "hubot" }, text: "" });
t.check("request_review refuses a login that is no review bot", r.status === 1 && writes().length === 2, r.stdout);

// ---------- a trigger comment counts as a bot command ----------
const commands = rb.botCommandTexts(c.loadInstance("widgets").profile);
t.check("the bot commands hold the trigger comments", commands.includes("@octobot2 review") && commands.includes("@widgets-bot escalate"), commands);
r = act({ kind: "pr", number: 12, action: "comment", text: "Done. @OctoBot2 Review please." }, "--dry-run");
t.check("gary action refuses a trigger comment in text", r.status === 1 && /bot command "@octobot2 review"/.test(json(r).result), r.stdout);
r = act({ kind: "pr", number: 12, action: "review", params: { event: "comment", comments: [{ path: "a.ts", line: 1, text: "@octobot2 review" }] } }, "--dry-run");
t.check("gary action refuses a trigger comment in an inline comment", r.status === 1 && /bot command/.test(json(r).result), r.stdout);
const profile = c.loadInstance("widgets").profile;
const item = (routes) => ({ kind: "pr", repo: "acme/widgets", number: 26, title: "Update the docs", url: "https://github.com/acme/widgets/pull/26", author: "hubot", authorType: "contributor", section: "review", priority: 1, effortMinutes: 5, reviewDepth: "full", state: "Reviewed.", reviewedAt: "2026-11-17T14:00:00Z", reviewedSha: "e".repeat(40), hint: routes[0].title, routes });
const review = (text) => ({ id: "r1", type: "review", as: "bot", title: "Review: ask for a test", params: { event: "request_changes" }, text, recommended: true });
const codes = (doc) => validateItem("pr-26", doc, { mode: "bot", profile, sensitive: false }).errors.map((e) => e.code);
t.check("the item check accepts the same text without the trigger", !codes(item([review("Please add a test.")])).includes("bot-command"));
t.check("the item check refuses a trigger comment in text the bot posts", codes(item([review("Please add a test. @octobot2 review")])).includes("bot-command"));
const apiParams = { via: "api", message: "docs: fix the link", edits: [{ path: "README.md", original: "a", replacement: "Say @octobot2 review" }] };
t.check("the API edit refuses a trigger comment in a replacement", apiEditProblems(apiParams, profile).some((p) => /replacement contains the bot command "@octobot2 review"/.test(p)), apiEditProblems(apiParams, profile));
t.check("botCommandIn finds a trigger comment it is given", botCommandIn("Then write @OctoBot2 review.", ["@octobot2 review"]) === "@octobot2 review" && botCommandIn("Then write octobot2.", ["@octobot2 review"]) === null);
const pending = { id: "r1", type: "review", as: "me", title: "Review", params: { pending: true, event: "comment", comments: [] }, text: "Looks fine. @octobot2 review" };
const draft = { kind: "pr", reviewDepth: "full", reviewedSha: "e".repeat(40), walkthrough: {} };
t.check("a review draft of a contributions instance refuses the trigger comments of every maintainer instance", pendingRouteProblems(draft, pending, "the draft").some(([code]) => code === "pending-bot-command"), pendingRouteProblems(draft, pending, "the draft"));
t.check("the same draft without the trigger passes that check", !pendingRouteProblems(draft, { ...pending, text: "Looks fine." }, "the draft").some(([code]) => code === "pending-bot-command"));

// ---------- a round arrives on its head, from every bot ----------
const copilot = { key: "copilot", trigger: "copilot" };
const octobot = { key: "octobot", login: "octobot", trigger: "request" };
const asked0 = "2026-11-20T10:00:00.000Z";
const after = "2026-11-20T10:05:00.000Z";
const H = "c".repeat(40);
const waiting = { reviewRequestedAt: asked0, lastPushedSha: H, reviewBots: [copilot, octobot], botRounds: { copilot: { rounds: 1, sha: H }, octobot: { rounds: 1, sha: H } } };
const entry = (lastReviews) => ({ headSha: H, lastReviews });
const soon = Date.parse(asked0) + 60000;
t.check("a review of an older head does not count", driveEvent(waiting, entry([{ author: "copilot-pull-request-reviewer", at: after, commit: "d".repeat(40) }, { author: "octobot[bot]", at: after, commit: "d".repeat(40) }]), soon) === null);
t.check("the round waits for every bot", driveEvent(waiting, entry([{ author: "copilot-pull-request-reviewer", at: after, commit: H }]), soon) === null);
t.check("a review from before the request does not count", driveEvent(waiting, entry([{ author: "copilot-pull-request-reviewer", at: after, commit: H }, { author: "octobot", at: "2026-11-20T09:00:00.000Z", commit: H }]), soon) === null);
t.check("the round arrives when every bot reviewed its head", driveEvent(waiting, entry([{ author: "Copilot", at: after, commit: H }, { author: "OctoBot[bot]", at: after, commit: H }]), soon) === "review-arrived");
t.check("another account with the bot's name in it does not count", driveEvent(waiting, entry([{ author: "Copilot", at: after, commit: H }, { author: "octobot-fan", at: after, commit: H }]), soon) === null);
t.check("a partial round times out after 30 minutes", driveEvent(waiting, entry([{ author: "Copilot", at: after, commit: H }]), Date.parse(asked0) + 31 * 60000) === "review-timeout");
const legacy = { reviewRequestedAt: asked0, lastPushedSha: H, reviewBot: "copilot", copilotRounds: 2 };
t.check("an old drive file waits for Copilot's review on lastPushedSha", driveEvent(legacy, entry([{ author: "copilot-pull-request-reviewer", at: after, commit: "d".repeat(40) }]), soon) === null && driveEvent(legacy, entry([{ author: "copilot-pull-request-reviewer", at: after, commit: H }]), soon) === "review-arrived");

// ---------- a clean round: every bot's newest review on the head and none of its threads open ----------
const states = (summary, last) => botStates([copilot, octobot], { headSha: H, reviewSummary: summary, lastReviews: last });
const onHead = [{ author: "copilot-pull-request-reviewer", at: after, commit: H }, { author: "octobot[bot]", at: after, commit: H }];
t.check("a round with every review on the head and no open thread is clean", roundClean(states([{ author: "octobot[bot]", openThreadCount: 0 }], onHead)));
t.check("an open bot thread keeps the round open", !roundClean(states([{ author: "octobot[bot]", openThreadCount: 1 }], onHead)) && states([{ author: "octobot[bot]", openThreadCount: 1 }], onHead)[1].openThreads === 1);
t.check("a bot whose newest review is on an older head keeps the round open", !roundClean(states([], [onHead[0], { ...onHead[1], commit: "d".repeat(40) }])));
t.check("a bot without a review keeps the round open", !roundClean(states([], [onHead[0]])));
t.check("another reviewer's open thread does not count", roundClean(states([{ author: "hubot", openThreadCount: 2 }], onHead)));
t.check("no bot is never a clean round", roundClean([]) === false);

// gary pr-watch bots reads the PR and says so
reset();
gary("fix-record", "issue-23", "--pr", "19", "--branch", "triage/issue-23", "--run", "run-1", "--by", "routine");
editConfig((cfg) => ({ ...cfg, review: { github: ["octobot"] } }));
const reviewNode = (login, oid) => ({ author: { login, __typename: "Bot" }, state: "COMMENTED", submittedAt: "2026-11-27T10:00:00Z", url: "https://github.com/acme/widgets/pull/19#pullrequestreview-1", commit: { oid } });
const thread = (resolved) => ({ id: "PRRT_1", isResolved: resolved, isOutdated: false, path: "a.js", line: 3, originalLine: 3, comments: { nodes: [{ author: { login: "octobot", __typename: "Bot" }, createdAt: "2026-11-27T10:00:00Z", url: "https://github.com/acme/widgets/pull/19#discussion_r1", body: "Guard the empty list." }] }, allComments: { totalCount: 1, nodes: [] } });
const pr19 = (oid, resolved) => ({ "pr-19": { allReviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [reviewNode("octobot", oid)] }, reviewThreads: { totalCount: 1, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [thread(resolved)] } } });
writeFileSync(OVERRIDES, JSON.stringify(pr19(SHA, false)));
o = json(gary("pr-watch", "bots", "--pr", "19"));
t.check("pr-watch bots: an open thread of the bot is no clean round", o.ok === true && o.clean === false && o.bots?.[0]?.key === "octobot" && o.bots[0].onHead === true && o.bots[0].openThreads === 1, o);
writeFileSync(OVERRIDES, JSON.stringify(pr19(SHA, true)));
o = json(gary("pr-watch", "bots", "--pr", "19"));
t.check("pr-watch bots: the review on the head with its threads resolved is a clean round", o.clean === true && o.head === SHA && o.bots[0].openThreads === 0, o);
writeFileSync(OVERRIDES, JSON.stringify(pr19("8".repeat(40), true)));
o = json(gary("pr-watch", "bots", "--pr", "19"));
t.check("pr-watch bots: a review of an older head is no clean round", o.clean === false && o.bots[0].onHead === false, o);
editConfig((cfg) => ({ ...cfg, review: undefined }));

// ---------- the snapshot counts the rounds per bot ----------
const timeline = [
	{ at: "2026-11-20T10:00:00Z", author: "copilot-pull-request-reviewer", side: "bot", kind: "review" },
	{ at: "2026-11-21T10:00:00Z", author: "copilot-pull-request-reviewer", side: "bot", kind: "review" },
	{ at: "2026-11-21T10:01:00Z", author: "octobot[bot]", side: "bot", kind: "review" },
];
t.check("reviewBotReviews counts the rounds of the bot with the most reviews", feedbackFacts(timeline, [], { me: "octocat", bot: "widgets-bot", writeLogin: "widgets-bot", reviewBots: [copilot, octobot] }).reviewBotReviews === 2);
t.check("reviewBotReviews still takes the profile's strings", feedbackFacts(timeline, [], { me: "octocat", bot: "widgets-bot", writeLogin: "widgets-bot", reviewBots: ["copilot"] }).reviewBotReviews === 2);

removeDir(T);
t.done();
