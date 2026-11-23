// The instance library: loadInstance, listInstances, repo lookups, the root config, scoping and live settings.
import { parseJsonc, setJsoncValue, stripJsonc } from "../scripts/lib/jsonc.mjs";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PROFILE, ROOT, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("config");
const T = tempDir();
const profile = join(T, "profile");
cpSync(PROFILE, profile, { recursive: true });
const { root, home } = makeHome(T, { profile, port: 7999, checkout: "../../../checkout" });
const gadgets = join(T, "profile-gadgets");
cpSync(PROFILE, gadgets, { recursive: true });
writeFileSync(join(gadgets, "profile.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8")), name: "Gadgets", repo: "acme/gadgets" }));
makeHome(T, { profile: gadgets, bot: null }, "gadgets");
mkdirSync(join(root, "instances", "broken"), { recursive: true });
writeFileSync(join(root, "instances", "broken", "config.json"), "{");
process.env.GARY_HOME = root;
delete process.env.GARY_INSTANCE;
const c = await import("../scripts/lib/config.mjs");

t.check("rootConfig reads the port", c.rootConfig().port === 7999);
const list = c.listInstances();
const good = list.filter((i) => i.valid);
t.check("listInstances returns the readable instances with their facts", JSON.stringify(good.map((i) => i.name)) === '["gadgets","widgets"]' && good.every((i) => i.kind === "maintainer" && Array.isArray(i.repos) && typeof i.paused === "boolean" && "checkout" in i && i.title && !i.settingsError), list);
const broken = list.find((i) => i.name === "broken");
t.check("an instance never valid is listed with its error and no repos", broken && broken.valid === false && broken.repos.length === 0 && /is not valid JSON/.test(broken.settingsError), broken);
t.check("instanceNames still lists every directory with a config", JSON.stringify(c.instanceNames()) === '["broken","gadgets","widgets"]');
const w = c.loadInstance("widgets");
t.check("loadInstance resolves paths and facts", w.dir === home && w.state === join(home, "state") && w.board === join(home, "state", "board") && w.profileDir === profile && w.checkout === join(T, "checkout") && w.repos[0] === "acme/widgets" && w.title === "widgets", w);
t.check("allowedRepo ignores case", c.allowedRepo("widgets", "ACME/Widgets") && !c.allowedRepo("widgets", "acme/gadgets") && c.allowedRepo(w, "acme/widgets"));
t.check("checkoutFor answers per repo", c.checkoutFor("widgets", "acme/widgets") === join(T, "checkout") && c.checkoutFor("widgets", "acme/other") === null && c.checkoutFor("gadgets", "acme/gadgets") === null);
t.check("rulesFor names the profile's file", c.rulesFor("widgets", "acme/widgets", "review") === join(profile, "rules", "review.md") && c.rulesFor("widgets", "acme/other", "review") === null && c.rulesFor("widgets", "acme/widgets", "../x") === null);
t.check("itemRef", c.itemRef({ repo: "acme/widgets", number: 12 }) === "acme/widgets#12");
t.check("instanceSettingsFiles names config and profile", JSON.stringify(c.instanceSettingsFiles("widgets")) === JSON.stringify([join(home, "config.json"), join(profile, "profile.json")]));

// withInstance scopes everything it calls, also across awaits
const seen = await Promise.all([
	c.withInstance("widgets", async () => {
		await sleep(20);
		return [c.instanceName(), c.loadProfile().repo];
	}),
	c.withInstance("gadgets", async () => {
		await sleep(5);
		return [c.instanceName(), c.loadProfile().repo];
	}),
]);
t.check("withInstance keeps each scope apart across awaits", JSON.stringify(seen) === '[["widgets","acme/widgets"],["gadgets","acme/gadgets"]]', seen);

// Edits to config and profile apply on the next call
const pfile = join(profile, "profile.json");
writeFileSync(pfile, JSON.stringify({ ...JSON.parse(readFileSync(pfile, "utf8")), relatedRepos: ["widgets-cli"], name: "Widgets!" }));
t.check("an edited profile applies without a restart", JSON.stringify(c.loadInstance("widgets").profile.relatedRepos) === '["widgets-cli"]' && c.loadInstance("widgets").title === "Widgets!");
const cfile = join(root, "instances", "gadgets", "config.json");
writeFileSync(cfile, JSON.stringify({ ...JSON.parse(readFileSync(cfile, "utf8")), bot: { login: "gadgets-bot", tokenFile: "/tmp/x" } }));
t.check("an edited config applies without a restart", c.loadInstance("gadgets").config.bot?.login === "gadgets-bot");
writeFileSync(cfile, "{");
let g = c.loadInstance("gadgets");
t.check("a config broken by an edit keeps the last valid settings and names the error", g.config.bot?.login === "gadgets-bot" && g.repos[0] === "acme/gadgets" && /is not valid JSON/.test(g.settingsError), g);
t.check("listInstances shows the error of a broken instance it still serves", c.listInstances().find((i) => i.name === "gadgets")?.settingsError === g.settingsError);
t.check("loadConfigFor and loadProfileFor fall back too", c.loadConfigFor("gadgets").me === g.config.me && c.loadProfileFor("gadgets").repo === "acme/gadgets");
writeFileSync(cfile, JSON.stringify({ ...JSON.parse(readFileSync(join(root, "instances", "widgets", "config.json"), "utf8")), profile: gadgets, maxFullReviewsPerRun: 3 }));
g = c.loadInstance("gadgets");
t.check("a repaired config clears the error", !g.settingsError && g.config.maxFullReviewsPerRun === 3, g);

// A profile that breaks and comes back, without touching config.json
const gfile = join(gadgets, "profile.json");
const gprofile = JSON.parse(readFileSync(gfile, "utf8"));
writeFileSync(gfile, JSON.stringify({ ...gprofile, automatedComments: [{ name: "bad", pattern: "([" }] }));
g = c.loadInstance("gadgets");
t.check("an invalid profile keeps serving the last valid one", g.title === "Gadgets" && /automatedComments\[0\]\.pattern" is not a valid regular expression/.test(g.settingsError), g.settingsError);
writeFileSync(gfile, JSON.stringify({ ...gprofile, name: "Gadgets 2" }));
g = c.loadInstance("gadgets");
t.check("a profile valid again applies at once", g.title === "Gadgets 2" && !g.settingsError, g);

// Unknown fields are warnings at run time and errors in setup and doctor
writeFileSync(gfile, JSON.stringify({ ...gprofile, futureField: true }));
writeFileSync(cfile, JSON.stringify({ ...JSON.parse(readFileSync(cfile, "utf8")), futureSetting: 1 }));
g = c.loadInstance("gadgets");
t.check(
	"unknown fields load with warnings",
	!g.settingsError && g.title === "Gadgets" && g.settingsWarnings?.length === 2 && g.settingsWarnings.some((w) => w.endsWith('unknown field "futureField"') && w.startsWith(gfile)) && g.settingsWarnings.some((w) => w.endsWith('unknown field "futureSetting"')),
	g.settingsWarnings,
);
t.check("validateProfile and validateConfig still refuse unknown fields", c.validateProfile({ ...gprofile, futureField: true }).includes('unknown field "futureField"') && c.validateConfig({ profile: "p", me: "me", futureSetting: 1 }).includes('unknown field "futureSetting"'));
writeFileSync(gfile, JSON.stringify(gprofile));

// automatedComments and fastTier
const ac = (list) => c.validateProfile({ ...gprofile, automatedComments: list });
t.check("automatedComments accepts name, pattern and origin", ac([{ name: "tag", pattern: "<!-- TAG -->", origin: "a workflow" }, { name: "beep", pattern: "^\\*\\*Beep" }]).length === 0);
t.check("automatedComments refuses a broken regex", ac([{ name: "x", pattern: "(" }]).some((e) => /not a valid regular expression/.test(e)));
t.check("automatedComments refuses nested quantifiers", ac([{ name: "x", pattern: "(a+)+b" }]).some((e) => /nests quantifiers/.test(e)));
t.check("automatedComments refuses a very long pattern", ac([{ name: "x", pattern: "a".repeat(501) }]).some((e) => /at most 500/.test(e)));
t.check("automatedComments needs a name and a list", ac([{ pattern: "x" }]).some((e) => /\.name" must name/.test(e)) && ac({}).length === 1);
t.check("automatedComments entries refuse unknown fields", ac([{ name: "x", pattern: "x", startsWith: "y" }]).includes('unknown field "automatedComments[0].startsWith"'));
t.check("aiAuthors is a list of strings", c.validateProfile({ ...gprofile, aiAuthors: ["devin"] }).length === 0 && c.validateProfile({ ...gprofile, aiAuthors: [1] }).some((e) => /"aiAuthors" must be a list of strings/.test(e)));
t.check("fastTier defaults to off", c.loadInstance("widgets").config.fastTier === "off");
t.check("fastTier takes off, shadow or on", c.validateConfig({ profile: "p", me: "me", fastTier: "shadow" }).length === 0 && c.validateConfig({ profile: "p", me: "me", fastTier: "fast" }).some((e) => /"fastTier" must be one of/.test(e)));

// fixReview and maxPendingAutoFixes
const base = { profile: "p", me: "me" };
const reviewBots = { reviewBots: ["copilot"] };
const withBot = { ...base, bot: { login: "b", tokenFile: "t" } };
t.check("maxPendingAutoFixes defaults to 10", c.loadInstance("widgets").config.maxPendingAutoFixes === 10 && c.CONFIG_DEFAULTS.maxPendingAutoFixes === 10);
t.check("maxPendingAutoFixes takes 0 and whole numbers only", c.validateConfig({ ...base, maxPendingAutoFixes: 0 }).length === 0 && c.validateConfig({ ...base, maxPendingAutoFixes: 25 }).length === 0
	&& c.validateConfig({ ...base, maxPendingAutoFixes: -1 }).some((e) => /"maxPendingAutoFixes" must be a whole number/.test(e)) && c.validateConfig({ ...base, maxPendingAutoFixes: "10" }).length === 1 && c.validateConfig({ ...base, maxPendingAutoFixes: 1.5 }).length === 1);
t.check("fixReview defaults to three Copilot rounds requested as me, then ready, when the instance can push", JSON.stringify(c.fixReviewOf(withBot, reviewBots)) === '{"reviewer":"copilot","requestAs":"me","maxRounds":3,"markReady":true,"reason":null,"noReviewBot":false}');
t.check("fixReview defaults to on with allowOwnTokenPushes too", c.fixReviewOf({ ...base, allowOwnTokenPushes: true }, reviewBots).reviewer === "copilot");
t.check("fixReview is off without an account that may push", c.fixReviewOf({ ...base, bot: null }, reviewBots).reviewer === "off" && /no account may push/.test(c.fixReviewOf({ ...base, bot: null }, reviewBots).reason));
t.check("fixReview skips the rounds when the profile lists no review bot", (() => {
	const fr = c.fixReviewOf(withBot, { reviewBots: [] });
	return fr.reviewer === "off" && fr.noReviewBot === true && /lists no review bot/.test(fr.reason);
})());
t.check("without an account that may push the missing review bot does not matter", c.fixReviewOf({ ...base, bot: null }, { reviewBots: [] }).noReviewBot === false);
t.check("the review bot is the first of reviewBots, or null", c.reviewBotOf({ reviewBots: ["copilot"] }) === "copilot" && c.reviewBotOf({ reviewBots: [] }) === null && c.reviewBotOf({}) === null);
t.check("fixReview off in config.json stays off", c.fixReviewOf({ ...withBot, fixReview: { reviewer: "off" } }, reviewBots).reviewer === "off");
t.check("fixReview fills the fields config.json leaves out", JSON.stringify(c.fixReviewOf({ ...withBot, fixReview: { maxRounds: 1, requestAs: "bot" } }, reviewBots)) === '{"reviewer":"copilot","requestAs":"bot","maxRounds":1,"markReady":true,"reason":null,"noReviewBot":false}');
t.check("requestAs bot needs a bot", /no bot is configured/.test(c.fixReviewOf({ ...base, allowOwnTokenPushes: true, fixReview: { requestAs: "bot" } }, reviewBots).reason));
t.check("a full fixReview is valid", c.validateConfig({ ...base, fixReview: { reviewer: "copilot", requestAs: "me", maxRounds: 2, markReady: false } }).length === 0);
const frErrors = c.validateConfig({ ...base, fixReview: { reviewer: "gemini", requestAs: "them", maxRounds: 4, markReady: "yes" } });
t.check("fixReview refuses values outside its lists", frErrors.length === 4 && frErrors.some((e) => /"fixReview.reviewer" must be one of copilot, off/.test(e)) && frErrors.some((e) => /"fixReview.requestAs" must be one of me, bot/.test(e)) && frErrors.some((e) => /"fixReview.maxRounds" must be 1, 2 or 3/.test(e)) && frErrors.some((e) => /"fixReview.markReady" must be true or false/.test(e)), frErrors);
t.check("fixReview must be an object", c.validateConfig({ ...base, fixReview: "copilot" }).some((e) => /"fixReview" must be/.test(e)));
const frCheck = c.checkConfig({ ...base, fixReview: { reviewer: "copilot", waitMinutes: 10 } });
t.check("an unknown fixReview field is only a warning at run time", frCheck.errors.length === 0 && frCheck.unknown.includes('unknown field "fixReview.waitMinutes"'), frCheck);

// autoReview and the profile fields it reads
const paths = { autoReviewPaths: { config: ["config/devices/**"] } };
t.check("autoReview is off without the field", c.autoReviewOf(withBot, paths).enabled === false && c.autoReviewOf(withBot, paths).reason === null && c.loadInstance("widgets").config.autoReview === undefined);
t.check("autoReview on takes the defaults for the rest", JSON.stringify(c.autoReviewOf({ ...withBot, autoReview: { enabled: true } }, paths)) === '{"enabled":true,"kinds":["config"],"maxPerRun":3,"reason":null}');
t.check("autoReview works with allowOwnTokenPushes", c.autoReviewOf({ ...base, allowOwnTokenPushes: true, autoReview: { enabled: true } }, paths).enabled === true);
t.check("autoReview is off without an account that may post", /no account may post/.test(c.autoReviewOf({ ...base, autoReview: { enabled: true } }, paths).reason));
t.check("autoReview is off when the profile names no paths for its kinds", /names no autoReviewPaths for config/.test(c.autoReviewOf({ ...withBot, autoReview: { enabled: true } }, { autoReviewPaths: {} }).reason) && c.autoReviewOf({ ...withBot, autoReview: { enabled: true } }, { autoReviewPaths: { config: [] } }).enabled === false);
t.check("autoReview with maxPerRun 0 or no kinds is off", c.autoReviewOf({ ...withBot, autoReview: { enabled: true, maxPerRun: 0 } }, paths).enabled === false && c.autoReviewOf({ ...withBot, autoReview: { enabled: true, kinds: [] } }, paths).enabled === false);
t.check("a full autoReview is valid", c.validateConfig({ ...base, autoReview: { enabled: true, kinds: ["config"], maxPerRun: 5 } }).length === 0);
const arErrors = c.validateConfig({ ...base, autoReview: { enabled: "yes", kinds: ["config", "docs"], maxPerRun: 51 } });
t.check("autoReview refuses values outside its lists", arErrors.length === 3 && arErrors.some((e) => /"autoReview.enabled" must be true or false/.test(e)) && arErrors.some((e) => /"autoReview.kinds" must be a list with only config/.test(e)) && arErrors.some((e) => /"autoReview.maxPerRun"/.test(e)), arErrors);
t.check("autoReview must be an object", c.validateConfig({ ...base, autoReview: true }).some((e) => /"autoReview" must be/.test(e)));
const arCheck = c.checkConfig({ ...base, autoReview: { enabled: true, onlyFirstTimers: true } });
t.check("an unknown autoReview field is only a warning at run time", arCheck.errors.length === 0 && arCheck.unknown.includes('unknown field "autoReview.onlyFirstTimers"'), arCheck);
t.check("autoReviewPaths maps a kind to globs", c.validateProfile({ ...gprofile, ...paths }).length === 0 && c.validateProfile({ ...gprofile, autoReviewPaths: ["config/**"] }).some((e) => /"autoReviewPaths" must map/.test(e)) && c.validateProfile({ ...gprofile, autoReviewPaths: { config: "config/**" } }).some((e) => /"autoReviewPaths.config" must be a list of globs/.test(e)));
const kindCheck = c.checkProfile({ ...gprofile, autoReviewPaths: { docs: ["docs/**"] } });
t.check("paths for a kind this version does not know are only a warning", kindCheck.errors.length === 0 && kindCheck.unknown.includes('unknown field "autoReviewPaths.docs"'), kindCheck);
const er = (v) => c.validateProfile({ ...gprofile, escalateResult: v });
t.check("escalateResult takes a pattern with one group, or null", er("^Escalated to an issue: #(\\d+)").length === 0 && er("^(?:Moved|Escalated) to #(\\d+)").length === 0 && er(null).length === 0, er("^Escalated to an issue: #(\\d+)"));
t.check("escalateResult refuses a pattern without a group or with two", [er("^Escalated: #\\d+"), er("^(Escalated): #(\\d+)")].every((e) => e.some((x) => /exactly one capture group/.test(x))));
t.check("escalateResult refuses a broken regex", er("^#(\\d+").some((e) => /not a valid regular expression/.test(e)) && er("^#(\\d+)\\").some((e) => /not a valid regular expression/.test(e)));
t.check("escalateResult refuses nested quantifiers", er("^(?:a+)+#(\\d+)").some((e) => /nests quantifiers/.test(e)));
t.check("escalateResult refuses other values and long patterns", [er(4), er(""), er(`(${"a".repeat(500)})`)].every((e) => e.some((x) => /at most 500/.test(x))));
t.check("the link needs the field and a bot", c.escalationOf({ bot: { login: "b" } }, { escalateResult: "#(\\d+)" }).enabled && !c.escalationOf({ bot: null }, { escalateResult: "#(\\d+)" }).enabled && !c.escalationOf({ bot: { login: "b" } }, {}).enabled);
t.check("formatCommand is one line without backticks", c.validateProfile({ ...gprofile, formatCommand: "npm run fmt" }).length === 0 && c.validateProfile({ ...gprofile, formatCommand: null }).length === 0 && ["`rm -rf`", "a\nb", "", 5, "x".repeat(201)].every((v) => c.validateProfile({ ...gprofile, formatCommand: v }).some((e) => /"formatCommand" must be/.test(e))));
t.check("JSONC: comments and trailing commas are dropped, strings are kept", JSON.stringify(parseJsonc('// a\n{ "u": "http://x/*y*/", /* b */ "l": [1, 2,], "s": ",]", }')) === '{"u":"http://x/*y*/","l":[1,2],"s":",]"}' && stripJsonc("{\n/* a\nb */\n}").split("\n").length === 4);
t.check("JSONC: a value is replaced in place and its comment stays", setJsoncValue('{\n\t// c\n\t"repo": "a/b", // d\n\t"x": []\n}', "repo", "o/n") === '{\n\t// c\n\t"repo": "o/n", // d\n\t"x": []\n}');
const af = (fields) => c.validateProfile({ ...gprofile, autofixCommands: [], autofixSetup: null, ...fields });
t.check("autofixCommands and autofixSetup take commands with their placeholders", af({ autofixCommands: ["npx prettier --write {files}"], autofixSetup: "npm ci" }).length === 0 && af({}).length === 0);
t.check("an autofix command may run on the whole project or on the files its globs match", af({ autofixCommands: ["npm run lint:fix", { run: "npx eslint --fix {files}", files: ["**/*.ts"] }] }).length === 0);
t.check("the object form needs run and files and nothing else", [{ run: "x" }, { files: ["a"] }, { run: "x", files: [] }, { run: "x", files: ["a"], extra: 1 }].every((v) => af({ autofixCommands: [v] }).some((e) => /"autofixCommands" must be/.test(e))));
t.check("autofixCommands refuses other values", [[""], ["a {files}\nb"], "npx prettier {files}", [5], Array(11).fill("x {files}")].every((v) => af({ autofixCommands: v }).some((e) => /"autofixCommands" must be/.test(e))));
t.check("autofixSetup is one line", ["", "a\nb", 5, "x".repeat(501)].every((v) => af({ autofixCommands: ["x {files}"], autofixSetup: v }).some((e) => /"autofixSetup" must be/.test(e))));
t.check("autofixSetup needs commands", af({ autofixSetup: "npm ci" }).some((e) => /"autofixSetup" needs "autofixCommands"/.test(e)));
t.check("mergeMethod is squash, merge or rebase, default squash", ["squash", "merge", "rebase"].every((m) => c.validateProfile({ ...gprofile, mergeMethod: m }).length === 0) && [null, "fast-forward"].every((m) => c.validateProfile({ ...gprofile, mergeMethod: m }).some((e) => /"mergeMethod" must be one of/.test(e))) && c.PROFILE_DEFAULTS.mergeMethod === "squash");
t.check("commitFormat is null or conventional", c.validateProfile({ ...gprofile, commitFormat: "conventional" }).length === 0 && c.validateProfile({ ...gprofile, commitFormat: null }).length === 0 && ["angular", "", 1].every((v) => c.validateProfile({ ...gprofile, commitFormat: v }).some((e) => /"commitFormat" must be null or one of "conventional"/.test(e))) && c.PROFILE_DEFAULTS.commitFormat === null);
t.check("the defaults have no format check", JSON.stringify(c.PROFILE_DEFAULTS.autofixCommands) === "[]" && c.PROFILE_DEFAULTS.autofixSetup === null);
t.check("the template profile is valid and carries the new fields", (() => {
	const tpl = parseJsonc(readFileSync(join(ROOT, "profiles", "template", "profile.json"), "utf8"));
	return c.validateProfile(tpl).length === 0 && JSON.stringify(tpl.autoReviewPaths) === '{"config":[]}' && tpl.formatCommand === null && JSON.stringify(tpl.autofixCommands) === "[]" && tpl.autofixSetup === null && tpl.commitFormat === null && tpl.mergeMethod === "squash";
})());
// A broken autoReview keeps the last valid settings, like every other field
const wfile = join(root, "instances", "widgets", "config.json");
const wgood = readFileSync(wfile, "utf8");
writeFileSync(wfile, JSON.stringify({ ...JSON.parse(wgood), autoReview: { enabled: true } }));
t.check("a valid autoReview loads", c.loadInstance("widgets").config.autoReview.enabled === true);
writeFileSync(wfile, JSON.stringify({ ...JSON.parse(wgood), autoReview: { enabled: true, kinds: ["everything"] }, maxFullReviewsPerRun: 4 }));
const kept = c.loadInstance("widgets");
t.check("an autoReview with an unknown kind keeps the last valid settings and names the error", JSON.stringify(kept.config.autoReview) === '{"enabled":true}' && /"autoReview.kinds" must be a list with only config/.test(kept.settingsError), kept.settingsError);
writeFileSync(wfile, wgood + "\n");
let error = "";

// Root config rules
writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0 }));
error = "";
try {
	c.rootConfig();
} catch (e) {
	error = e.message;
}
t.check("rootConfig refuses a bad port", /"port" must be a port number/.test(error), error);
writeFileSync(join(root, "config.json"), "{}");
t.check("rootConfig defaults the port", c.rootConfig().port === 7878);

removeDir(T);
t.done();
