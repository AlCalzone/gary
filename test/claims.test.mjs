// gary claim, release and claims: exclusive claims on work for one item, with expiry.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("claims");
const T = tempDir();
const { home, env } = makeHome(T);
const gary = (...args) => spawnSync(process.execPath, [GARY, ...args], { env, encoding: "utf8" });
const json = (r) => {
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { unparsed: r.stdout + r.stderr };
	}
};
const file = (id, kind) => join(home, "state", "claims", `${id}.${kind}.json`);

let r = gary("claim", "disc-9492", "fix", "--run", "hourly-1");
let c = json(r);
t.check("a free item is claimed", r.status === 0 && c.ok === true && c.run === "hourly-1" && Date.parse(c.expiresAt) - Date.parse(c.at) === 60 * 60000, c);
t.check("the claim file holds run, at and expiresAt", JSON.stringify(Object.keys(JSON.parse(readFileSync(file("disc-9492", "fix"), "utf8")))) === '["run","at","expiresAt"]');
r = gary("claim", "disc-9492", "fix", "--run", "request-7");
t.check("another run gets exit 3 and the holder", r.status === 3 && json(r).holder?.run === "hourly-1" && /claimed by run hourly-1/.test(json(r).error), r.stdout);
r = gary("claim", "disc-9492", "review", "--run", "request-7", "--ttl", "5");
t.check("another kind on the same item is free", r.status === 0 && Date.parse(json(r).expiresAt) - Date.parse(json(r).at) === 5 * 60000, r.stdout);
r = gary("claim", "disc-9492", "fix", "--run", "hourly-1", "--ttl", "90");
t.check("the same run renews its claim", r.status === 0 && Date.parse(json(r).expiresAt) - Date.parse(json(r).at) === 90 * 60000, r.stdout);

writeFileSync(file("pr-12", "push"), JSON.stringify({ run: "old-run", at: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T01:00:00Z" }));
r = gary("claims", "--json");
const list = json(r);
t.check("gary claims lists every claim with kind and expiry", Array.isArray(list) && list.length === 3 && list.find((x) => x.itemId === "pr-12").expired === true && list.find((x) => x.itemId === "disc-9492" && x.kind === "fix").expired === false, list);
r = gary("claims");
t.check("the plain list marks expired claims", /pr-12\s+push\s+old-run\s+until 2026-01-01T01:00:00Z \(expired\)/.test(r.stdout) && /3 claims/.test(r.stdout), r.stdout);
r = gary("claim", "pr-12", "push", "--run", "new-run");
t.check("an expired claim is taken over", r.status === 0 && JSON.parse(readFileSync(file("pr-12", "push"), "utf8")).run === "new-run", r.stdout);

r = gary("release", "disc-9492", "fix", "--run", "request-7");
t.check("another run cannot release", r.status === 3 && existsSync(file("disc-9492", "fix")), r.stdout);
r = gary("release", "disc-9492", "fix", "--run", "hourly-1");
t.check("the holder releases", r.status === 0 && json(r).released === true && !existsSync(file("disc-9492", "fix")), r.stdout);
r = gary("release", "disc-9492", "fix", "--run", "hourly-1");
t.check("releasing a missing claim is fine", r.status === 0 && json(r).released === false, r.stdout);
r = gary("claim", "disc-9492", "fix", "--run", "request-7");
t.check("a released item can be claimed again", r.status === 0, r.stdout);

r = gary("claim", "disc-9492", "merge", "--run", "x");
t.check("an unknown kind is refused", r.status !== 0 && /fix, review, push/.test(r.stderr + r.stdout), r.stderr);
r = gary("claim", "../x", "fix", "--run", "x");
t.check("a bad item id is refused", r.status !== 0 && /item id must match/.test(r.stderr + r.stdout), r.stderr);
r = gary("claim", "disc-1", "fix");
t.check("--run is required", r.status !== 0 && /Usage/.test(r.stderr + r.stdout), r.stderr);
r = gary("claim", "disc-1", "fix", "--run", "x", "--ttl", "0");
t.check("a bad ttl is refused", r.status !== 0 && /--ttl/.test(r.stderr + r.stdout), r.stderr);

// Many runs at once: exactly one gets the claim
const { takeClaim } = await import("../scripts/lib/claims.mjs");
process.env.GARY_HOME = join(T, "root");
const results = await Promise.all(Array.from({ length: 20 }, (_, i) => takeClaim({ instance: "widgets", itemId: "issue-77", kind: "fix", run: `run-${i}` })));
t.check("of 20 concurrent claims exactly one wins", results.filter((x) => x.ok).length === 1, results.map((x) => x.ok));
writeFileSync(file("issue-78", "fix"), JSON.stringify({ run: "dead", at: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T01:00:00Z" }));
const takeovers = await Promise.all(Array.from({ length: 20 }, (_, i) => takeClaim({ instance: "widgets", itemId: "issue-78", kind: "fix", run: `run-${i}` })));
const winner = JSON.parse(readFileSync(file("issue-78", "fix"), "utf8")).run;
t.check("of 20 concurrent takeovers of an expired claim exactly one wins and holds the file", takeovers.filter((x) => x.ok).length === 1 && takeovers.find((x) => x.ok).claim.run === winner, { oks: takeovers.filter((x) => x.ok).length, winner });

removeDir(T);
t.done();
