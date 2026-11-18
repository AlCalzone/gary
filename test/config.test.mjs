// The instance library: loadInstance, listInstances, repo lookups, the root config, scoping and live settings.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PROFILE, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

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
