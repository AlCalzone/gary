// A PR's `ci` from its latest required checks, and the failing optional checks next to it.
// `gary item` and `gary snapshot` against the fake gh first, then unit checks on scripts/lib/ci.mjs.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GARY, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("ci");
const T = tempDir();
const { root, env } = makeHome(T);
process.env.GARY_HOME = root;
const overrides = join(T, "overrides.json");

const at = (m) => new Date(Date.UTC(2026, 10, 20, 12, m)).toISOString();
const run = (name, conclusion, m, isRequired, workflow = "CI") => ({
	__typename: "CheckRun", name, status: "COMPLETED", conclusion, startedAt: at(m), completedAt: at(m + 1), isRequired,
	checkSuite: { app: { slug: "github-actions" }, workflowRun: { workflow: { name: workflow } } },
});
const status = (context, state, m, isRequired) => ({ __typename: "StatusContext", context, state, createdAt: at(m), isRequired });
const failingRollup = { commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } };

const item = (checks) => {
	writeFileSync(overrides, JSON.stringify({ "pr-17": failingRollup, ...(checks && { "checks-17": checks }) }));
	const r = spawnSync(process.execPath, [GARY, "item", "pr", "17"], { env: { ...env, FAKE_GH_OVERRIDES: overrides }, encoding: "utf8" });
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { error: r.stdout + r.stderr };
	}
};

let e = item([run("Verify", "FAILURE", 0, false), run("Verify", "SUCCESS", 10, false), run("lint", "SUCCESS", 0, true)]);
t.check("an older failed run and a newer passing one are passing", e.ci === "passing" && e.facts?.ciGreen === true && !("ciOptionalFailing" in e), e.error ?? { ci: e.ci, ciOptionalFailing: e.ciOptionalFailing });
e = item([run("Verify", "FAILURE", 10, false), run("lint", "SUCCESS", 0, true)]);
t.check("a failing optional check with green required checks is passing", e.ci === "passing" && JSON.stringify(e.ciOptionalFailing) === '["Verify"]', e.error ?? { ci: e.ci, ciOptionalFailing: e.ciOptionalFailing });
t.check("the facts carry the failing optional checks", JSON.stringify(e.facts?.ciOptionalFailing) === '["Verify"]' && e.facts.ciGreen === true && e.facts.isClean === true, e.facts);
e = item([run("Verify", "SUCCESS", 10, false), run("lint", "FAILURE", 0, true)]);
t.check("a failing required check is failing", e.ci === "failing" && !("ciOptionalFailing" in e), e.error ?? e.ci);
e = item([run("Verify", "SUCCESS", 0, false), run("Verify", "FAILURE", 10, false), run("lint", "SUCCESS", 0, false)]);
t.check("without required checks a failing latest run is failing", e.ci === "failing" && !("ciOptionalFailing" in e), e.error ?? { ci: e.ci, ciOptionalFailing: e.ciOptionalFailing });
e = item([status("ci/jenkins", "FAILURE", 0, false), status("ci/jenkins", "SUCCESS", 5, false), status("deploy", "ERROR", 0, true)]);
t.check("statuses count by context and a failing required status is failing", e.ci === "failing", e.error ?? e.ci);
e = item([run("Verify", "SUCCESS", 0, true, "CI"), run("Verify", "FAILURE", 10, false, "Nightly")]);
t.check("runs of the same name in two workflows are two checks", e.ci === "passing" && JSON.stringify(e.ciOptionalFailing) === '["Verify"]', e.error ?? { ci: e.ci, ciOptionalFailing: e.ciOptionalFailing });
e = item([run("lint", "SUCCESS", 0, true), ...Array.from({ length: 120 }, (_, i) => run(`job ${i}`, "SUCCESS", 0, false)), run("test", "FAILURE", 0, true)]);
t.check("the checks beyond the first 100 count too", e.ci === "failing", e.error ?? e.ci);
e = item([run("lint", "SUCCESS", 0, true), ...Array.from({ length: 7 }, (_, i) => run(`job ${i}`, "FAILURE", 0, false))]);
t.check("at most 5 failing optional checks are listed", e.ci === "passing" && e.ciOptionalFailing?.length === 5, e.error ?? e.ciOptionalFailing);
e = item(null);
t.check("a failing rollup without readable checks stays failing", e.ci === "failing", e.error ?? e.ci);

// A stacked PR with only an optional check failing does not hold up its series
const snapshot = (checks) => {
	writeFileSync(overrides, JSON.stringify({ "pr-25": { baseRefName: "claude/restore-timeout" }, "pr-18": failingRollup, "checks-18": checks }));
	const r = spawnSync(process.execPath, [GARY, "snapshot"], { env: { ...env, FAKE_GH_OVERRIDES: overrides }, encoding: "utf8" });
	try {
		return JSON.parse(r.stdout).changed.find((c) => c.id === "pr-18") ?? {};
	} catch {
		return { error: r.stdout + r.stderr };
	}
};
let pr18 = snapshot([run("Verify", "FAILURE", 10, false), run("lint", "SUCCESS", 0, true)]);
t.check("the snapshot entry counts only the required checks", pr18.ci === "passing" && JSON.stringify(pr18.ciOptionalFailing) === '["Verify"]' && pr18.series?.size === 2 && !pr18.series.unready, pr18.error ?? { ci: pr18.ci, series: pr18.series });
pr18 = snapshot([run("Verify", "SUCCESS", 10, false), run("lint", "FAILURE", 0, true)]);
t.check("a failing required check makes the PR unready in its series", pr18.ci === "failing" && pr18.series?.unready === 1, pr18.error ?? { ci: pr18.ci, series: pr18.series });

const { validateItem } = await import("../scripts/lib/validate-item.mjs");
const doc = {
	kind: "pr", repo: "acme/widgets", number: 17, title: "Update typescript", url: "https://github.com/acme/widgets/pull/17", author: "renovate", authorType: "bot",
	category: "land", priority: 1, effortMinutes: 1, reviewDepth: "full", state: "Merge.", reviewedAt: at(0), labels: [], ci: "passing", routes: [], hint: null,
};
const codes = (extra) => validateItem("pr-17", { ...doc, ...extra }, { mode: "bot", profile: { repo: "acme/widgets", sensitivePaths: [] }, repos: ["acme/widgets"] }).errors.map((x) => x.code);
t.check("the validator accepts failing optional check names", !codes({ ciOptionalFailing: ["Verify"] }).includes("ciOptionalFailing"), codes({ ciOptionalFailing: ["Verify"] }));
t.check("the validator refuses other values", codes({ ciOptionalFailing: [1] }).includes("ciOptionalFailing") && codes({ ciOptionalFailing: "Verify" }).includes("ciOptionalFailing"));

removeDir(T);
t.done();
