// gary migrate: from per-instance ports and items without repo to the single-server layout, and idempotent.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, PROFILE, removeDir, runner, tempDir, testEnv } from "./lib.mjs";
import { parseJsonc } from "../scripts/lib/jsonc.mjs";

const t = runner("migrate");
const T = tempDir();
const root = join(T, "root");
const env = testEnv({ GARY_HOME: root });
const gary = (...args) => spawnSync(process.execPath, [GARY, ...args], { cwd: T, env, encoding: "utf8" });
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const gadgets = join(T, "profile-gadgets");
cpSync(PROFILE, gadgets, { recursive: true });
writeFileSync(join(gadgets, "profile.json"), JSON.stringify({ ...json(join(PROFILE, "profile.json")), name: "gadgets", repo: "acme/gadgets" }));

// The layout of the per-instance servers
const instance = (name, profile, port, items) => {
	const dir = join(root, "instances", name);
	mkdirSync(join(dir, "state", "board", "items"), { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ profile, me: "octocat", port }));
	writeFileSync(join(dir, "state", "server-token"), `${name}-token\n`);
	for (const [id, doc] of Object.entries(items)) writeFileSync(join(dir, "state", "board", "items", id + ".json"), JSON.stringify(doc));
	return dir;
};
const a = instance("gadgets", gadgets, 7901, { "pr-1": { kind: "pr", number: 1, title: "x" } });
const b = instance("widgets", PROFILE, 7900, { "pr-12": { kind: "pr", number: 12, title: "x" }, "issue-21": { kind: "issue", number: 21, title: "y", repo: "acme/widgets", hidden: true } });

let r = gary("--instance", "widgets", "paths");
t.check("an instance config with a port asks for gary migrate", r.status === 2 && /belongs in the root config.json now. Run `gary migrate`/.test(JSON.parse(r.stdout).error), r.stdout);

r = gary("migrate");
t.check("migrate runs", r.status === 0, r.stdout + r.stderr);
const ca = json(join(a, "config.json"));
const cb = json(join(b, "config.json"));
t.check("every instance gets kind maintainer and loses its port", ca.kind === "maintainer" && cb.kind === "maintainer" && !("port" in ca) && !("port" in cb), { ca, cb });
t.check("the root config gets the port of the first instance", json(join(root, "config.json")).port === 7901, json(join(root, "config.json")));
t.check("items without repo get the instance's repo", json(join(a, "state", "board", "items", "pr-1.json")).repo === "acme/gadgets" && json(join(b, "state", "board", "items", "pr-12.json")).repo === "acme/widgets");
t.check("other item fields stay", json(join(b, "state", "board", "items", "issue-21.json")).hidden === true && json(join(a, "state", "board", "items", "pr-1.json")).title === "x");
t.check("the first server-token moves to the root state", readFileSync(join(root, "state", "server-token"), "utf8") === "gadgets-token\n" && !existsSync(join(a, "state", "server-token")));
t.check("the second server-token is removed", !existsSync(join(b, "state", "server-token")));
t.check("the report names every change", /gadgets: set kind maintainer/.test(r.stdout) && /widgets: added repo acme\/widgets to 1 item$/m.test(r.stdout) && /root: set port 7901/.test(r.stdout), r.stdout);

r = gary("migrate");
t.check("a second run changes nothing", r.status === 0 && r.stdout.trim() === "Nothing to migrate.", r.stdout);
r = gary("--instance", "widgets", "paths");
t.check("the migrated instances load", r.status === 0 && JSON.parse(r.stdout).instance === "widgets", r.stdout);

// An existing root port is kept
writeFileSync(join(root, "config.json"), JSON.stringify({ port: 7999 }));
writeFileSync(join(b, "config.json"), JSON.stringify({ ...cb, port: 7900 }));
gary("migrate");
t.check("an existing root port is kept", json(join(root, "config.json")).port === 7999 && !("port" in json(join(b, "config.json"))));

// fixReview.reviewer goes: "copilot" is the default, "off" becomes maxRounds 0. Comments in a one-line fixReview stay
const fixCopilot = `{
	// the maintainer's note
	"kind": "maintainer",
	"profile": ${JSON.stringify(PROFILE)},
	"me": "octocat",
	"fixReview": { "reviewer": "copilot", "requestAs": "bot", "maxRounds": 2 },   // rounds of Gary's fix PRs
	"escalateAs": "prefill"
}
`;
writeFileSync(join(b, "config.json"), fixCopilot);
writeFileSync(join(a, "config.json"), JSON.stringify({ ...ca, fixReview: { reviewer: "off", markReady: false } }, null, "\t"));
r = gary("migrate");
const fa = json(join(a, "config.json"));
const fb = readFileSync(join(b, "config.json"), "utf8");
t.check("migrate replaces reviewer off with maxRounds 0", r.status === 0 && JSON.stringify(fa.fixReview) === '{"markReady":false,"maxRounds":0}' && /gadgets: replaced fixReview.reviewer off with fixReview.maxRounds 0/.test(r.stdout), [fa, r.stdout]);
t.check("migrate drops reviewer copilot and keeps the other fields", JSON.stringify(parseJsonc(fb).fixReview) === '{"requestAs":"bot","maxRounds":2}' && /widgets: removed fixReview.reviewer "copilot"/.test(r.stdout), [fb, r.stdout]);
t.check("the comments of the config stay", fb.includes("// the maintainer's note") && fb.includes("// rounds of Gary's fix PRs") && fb.split("\n").length === fixCopilot.split("\n").length, fb);
r = gary("migrate");
t.check("a second migrate leaves fixReview alone", r.status === 0 && r.stdout.trim() === "Nothing to migrate." && readFileSync(join(b, "config.json"), "utf8") === fb && JSON.stringify(json(join(a, "config.json"))) === JSON.stringify(fa), r.stdout);
r = gary("--instance", "widgets", "doctor");
t.check("the migrated config has no unknown fixReview field", !/unknown field "fixReview/.test(r.stdout), r.stdout.slice(0, 2000));
const multi = `{\n\t"kind": "maintainer",\n\t"profile": ${JSON.stringify(PROFILE)},\n\t"me": "octocat",\n\t"fixReview": {\n\t\t"reviewer": "off"\n\t}\n}\n`;
writeFileSync(join(b, "config.json"), multi);
gary("migrate");
t.check("a fixReview over several lines is migrated too", JSON.stringify(json(join(b, "config.json")).fixReview) === '{"maxRounds":0}', readFileSync(join(b, "config.json"), "utf8"));

// The layout from before instances is setup's job
const flat = join(T, "flat");
mkdirSync(flat, { recursive: true });
writeFileSync(join(flat, "config.json"), JSON.stringify({ profile: PROFILE, me: "octocat", port: 7878 }));
r = spawnSync(process.execPath, [GARY, "migrate"], { cwd: T, env: testEnv({ GARY_HOME: flat }), encoding: "utf8" });
t.check("migrate refuses the layout from before instances and names setup", r.status === 1 && /Run `gary setup` once/.test(r.stderr), r.stderr);


removeDir(T);
t.done();
