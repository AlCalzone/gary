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
t.check("listInstances returns the readable instances with their facts", JSON.stringify(list.map((i) => i.name)) === '["gadgets","widgets"]' && list.every((i) => i.kind === "maintainer" && Array.isArray(i.repos) && typeof i.paused === "boolean" && "checkout" in i && i.title), list);
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
let error = "";
try {
	c.loadInstance("gadgets");
} catch (e) {
	error = e.message;
}
t.check("a config broken by an edit fails loudly", /is not valid JSON/.test(error), error);

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
