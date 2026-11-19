// The models setting: validation, defaults, the root and instance layers, `gary models` and the doctor line.
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, PROFILE, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("models");
const T = tempDir();
const { root, env } = makeHome(T, { models: { fast: "sonnet", worker: "claude-sonnet-9-1" } });
makeHome(T, { bot: null }, "gadgets");
process.env.GARY_HOME = root;
delete process.env.GARY_INSTANCE;
const c = await import("../scripts/lib/config.mjs");

const base = { profile: "p", me: "me" };
const errorsOf = (models) => c.validateConfig({ ...base, models });
const rootFile = join(root, "config.json");
const setRoot = (data) => writeFileSync(rootFile, JSON.stringify(data));
const rootError = () => {
	try {
		c.rootConfig();
		return "";
	} catch (e) {
		return e.message;
	}
};

// Defaults and layers
t.check("the defaults put sessions on sonnet and reviews on opus", JSON.stringify(c.modelsOf(base, { models: {} }).models) === '{"master":"sonnet","worker":"sonnet","review":"opus","standard":"sonnet","fast":"haiku"}');
t.check("every default comes from the default layer", Object.values(c.modelsOf(base, { models: {} }).sources).every((s) => s === "default"));
const layered = c.modelsOf({ ...base, models: { review: "fable", fast: "sonnet" } }, { models: { master: "opus", review: "sonnet", worker: "claude-sonnet-9-1" } });
t.check("the instance wins over the root, and the root over the default", JSON.stringify(layered.models) === '{"master":"opus","worker":"claude-sonnet-9-1","review":"fable","standard":"sonnet","fast":"sonnet"}', layered.models);
t.check("sources name the layer per role", JSON.stringify(layered.sources) === '{"master":"root","worker":"root","review":"instance","standard":"default","fast":"instance"}', layered.sources);

// The fallback after a safety-filter stop
const fallback = (review, standard) => c.modelsOf({ ...base, models: { review, standard } }, { models: {} }).fallback;
t.check("the fallback is the standard model, smaller by default", JSON.stringify(c.modelsOf(base, { models: {} }).fallback) === '{"model":"sonnet","relation":"smaller"}');
t.check("haiku is smaller than sonnet", fallback("sonnet", "haiku")?.relation === "smaller");
t.check("a larger standard model is only another model", JSON.stringify(fallback("sonnet", "opus")) === '{"model":"opus","relation":"other"}');
t.check("fable is never called smaller or larger", fallback("fable", "opus")?.relation === "other" && fallback("opus", "fable")?.relation === "other");
t.check("the same model in both roles leaves no fallback", fallback("opus", "opus") === null);

// Validation of an instance config
t.check("a config without models is valid", c.validateConfig(base).length === 0);
t.check("every alias is valid for every instance role", ["haiku", "sonnet", "opus", "fable"].every((m) => errorsOf({ worker: m, review: m, standard: m, fast: m }).length === 0));
t.check("a partial models object is valid", errorsOf({ review: "opus" }).length === 0 && errorsOf({}).length === 0);
t.check("worker takes a full model id", errorsOf({ worker: "claude-sonnet-9-1" }).length === 0);
t.check("the subagent roles refuse a full model id", ["review", "standard", "fast"].every((role) => errorsOf({ [role]: "claude-opus-9-1" }).some((e) => e.startsWith(`"models.${role}" must be one of haiku, sonnet, opus, fable. A subagent start takes no full model id`))));
t.check("an unknown alias and a malformed id are refused", ["gpt", "Sonnet", "claude-", "claude-Opus", "claude_opus", "sonnet[1m]", 5, null, ""].every((v) => errorsOf({ worker: v }).some((e) => /"models.worker" must be one of/.test(e))));
t.check("master is refused in an instance config", errorsOf({ master: "sonnet" }).some((e) => /"models.master" belongs in the root config.json/.test(e)));
t.check("models must be an object", [[], "opus", 1, null].every((v) => errorsOf(v).some((e) => /"models" must map a role/.test(e))));
const unknownRole = c.checkConfig({ ...base, models: { planner: "opus" } });
t.check("an unknown role is an unknown field, a warning at run time", unknownRole.errors.length === 0 && unknownRole.unknown.includes('unknown field "models.planner"'), unknownRole);

// Validation of the root config
setRoot({ port: 9, models: { master: "claude-fable-9-1", worker: "opus", review: "opus", standard: "sonnet", fast: "haiku" } });
t.check("the root config takes every role, and a full id for master", rootError() === "" && c.rootConfig().models.master === "claude-fable-9-1" && c.rootConfig().port === 9);
setRoot({ port: 9, models: { review: "claude-opus-9-1", master: "big", planner: "opus" } });
t.check("the root config refuses a full id for review, a bad master and an unknown role", /"models.review" must be one of/.test(rootError()) && /"models.master" must be one of/.test(rootError()) && /unknown field "models.planner"/.test(rootError()), rootError());
setRoot({ port: 9, models: "opus" });
t.check("the root models must be an object", /"models" must map a role/.test(rootError()), rootError());
setRoot({ port: 9 });
t.check("a root config without models resolves to none", JSON.stringify(c.rootConfig().models) === "{}");

// gary models
const gary = (args, extra = {}) => spawnSync(process.execPath, [GARY, ...args], { cwd: T, env: { ...env, ...extra }, encoding: "utf8" });
setRoot({ port: 9, models: { master: "opus", review: "sonnet", fast: "opus" } });
let r = gary(["--instance", "widgets", "models", "--json"]);
let out = JSON.parse(r.stdout || "null");
t.check("gary models --json prints the layered models of the instance", r.status === 0 && out?.instance === "widgets" && JSON.stringify(out.models) === '{"master":"opus","worker":"claude-sonnet-9-1","review":"sonnet","standard":"sonnet","fast":"sonnet"}' && JSON.stringify(out.sources) === '{"master":"root","worker":"instance","review":"root","standard":"default","fast":"instance"}' && out.fallback === null, r.stdout + r.stderr);
r = gary(["--instance", "gadgets", "models"]);
t.check("gary models prints one line per role with its layer", r.status === 0 && /^master\s+opus\s+root config$/m.test(r.stdout) && /^worker\s+sonnet\s+default$/m.test(r.stdout) && /^review\s+sonnet\s+root config$/m.test(r.stdout) && /^standard\s+sonnet\s+default$/m.test(r.stdout) && /^fast\s+opus\s+root config$/m.test(r.stdout) && /^fallback\s+none, review and standard use the same model$/m.test(r.stdout), r.stdout + r.stderr);
setRoot({ port: 9 });
r = gary(["--instance", "gadgets", "models"]);
t.check("gary models prints the defaults and the smaller fallback", /^review\s+opus\s+default$/m.test(r.stdout) && /^fallback\s+sonnet, smaller than review$/m.test(r.stdout), r.stdout);
r = gary(["models"]);
t.check("gary models needs an instance when several exist", r.status === 2 && /belongs to no instance/.test(r.stderr), r.stderr);
r = gary(["models"], { GARY_INSTANCE: "widgets" });
t.check("gary models follows GARY_INSTANCE", r.status === 0 && /^worker\s+claude-sonnet-9-1\s+instance config$/m.test(r.stdout), r.stdout);

// gary models --all, with an invalid instance next to the valid ones
const gfile = join(root, "instances", "gadgets", "config.json");
const ggood = readFileSync(gfile, "utf8");
writeFileSync(gfile, JSON.stringify({ ...JSON.parse(ggood), models: { review: "claude-opus-9-1" } }));
setRoot({ port: 9, models: { master: "fable" } });
r = gary(["models", "--all", "--json"]);
out = JSON.parse(r.stdout || "null");
t.check("gary models --all prints the master and every instance", r.status === 0 && out?.master === "fable" && out.instances.widgets.models.worker === "claude-sonnet-9-1" && out.instances.widgets.models.review === "opus" && out.instances.widgets.fallback.model === "sonnet", r.stdout + r.stderr);
t.check("gary models --all names an invalid instance with its error", /"models.review" must be one of/.test(out?.instances.gadgets.error ?? "") && !out.instances.gadgets.models, out?.instances.gadgets);
r = gary(["models", "--all"]);
t.check("the plain --all list has a block per instance", /^master\s+fable$/m.test(r.stdout) && /^== gadgets\nerror: /m.test(r.stdout) && /^== widgets\nmaster\s+fable\s+root config$/m.test(r.stdout), r.stdout);
r = gary(["--instance", "gadgets", "models"]);
t.check("gary models fails on an invalid config with exit 2", r.status === 2 && /"models.review" must be one of/.test(r.stderr), r.stderr);
r = gary(["--instance", "gadgets", "doctor"]);
t.check("doctor fails the config check on an invalid model", r.status === 1 && /fail\s+config\s+Config .* is invalid/.test(r.stdout) && !/^\S+\s+models\s/m.test(r.stdout), r.stdout);
writeFileSync(gfile, ggood);

// The doctor line
r = gary(["--instance", "widgets", "doctor"]);
t.check("doctor prints the resolved models and says master is not checked", /^ok\s+models\s+worker claude-sonnet-9-1, review opus, standard sonnet, fast sonnet, a review stopped by the safety filter is retried on sonnet\. master fable, not checked: the host sets the master session's model$/m.test(r.stdout), r.stdout);
r = gary(["doctor", "--all", "--json"]);
out = JSON.parse(r.stdout || "null");
t.check("doctor --all has a models line per instance", ["widgets", "gadgets"].every((n) => out?.[n]?.find((x) => x.name === "models")?.status === "ok") && /^worker sonnet, review opus, standard sonnet, fast haiku,/.test(out.gadgets.find((x) => x.name === "models").detail), r.stdout.slice(0, 400));
setRoot({ port: 9, models: { review: "sonnet" } });
r = gary(["--instance", "gadgets", "doctor"]);
t.check("doctor says when no retry is left", /models\s+.*no retry after a safety-filter stop, because review and standard are the same model/.test(r.stdout), r.stdout);
setRoot({ port: 9, models: { master: "big" } });
r = gary(["--instance", "widgets", "doctor"]);
t.check("doctor fails the models line on an invalid root config", r.status === 1 && /^fail\s+models\s+Root config .* is invalid/m.test(r.stdout), r.stdout);

// gary setup --port keeps the root models
setRoot({ port: 9, models: { master: "opus" } });
const third = join(T, "profile-third");
cpSync(PROFILE, third, { recursive: true });
writeFileSync(join(third, "profile.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(PROFILE, "profile.json"), "utf8")), name: "third", repo: "acme/third" }));
r = gary(["setup", "--profile", third, "--me", "octocat", "--no-bot", "--no-links", "--instance", "third", "--port", "7001"]);
const rootNow = JSON.parse(readFileSync(rootFile, "utf8"));
t.check("gary setup --port keeps the models in the root config", r.status === 0 && rootNow.port === 7001 && rootNow.models?.master === "opus", r.stdout + r.stderr);

removeDir(T);
t.done();
