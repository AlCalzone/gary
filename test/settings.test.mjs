// Setting proposals: their validation, `gary shadow propose` and `convert`, and accept and dismiss against a dry-run server.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BOT, BOT_TOKEN, ME } from "./fixtures/github.mjs";
import { GARY, PROFILE, ROOT, freePort, makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("settings");
const T = tempDir();
const port = await freePort();
const { home, root, env } = makeHome(T, { port });
const BOARD = join(home, "state", "board");
const configFile = join(home, "config.json");
// Two spaces and fastTier in the middle, so a write that reorders or reformats shows
const tokenFile = join(T, "bot-token");
writeFileSync(tokenFile, BOT_TOKEN + "\n", { mode: 0o600 });
const configText = (fastTier, extra = {}) => JSON.stringify({ kind: "maintainer", profile: PROFILE, fastTier, me: ME, bot: { login: BOT, tokenFile }, activeWindowDays: 14, ...extra }, null, 2) + "\n";
writeFileSync(configFile, configText("shadow"));

const run = (e, ...args) => spawnSync(process.execPath, [GARY, ...args], { env: e, encoding: "utf8" });
const gary = (...args) => run(env, ...args);
const json = (r) => {
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { unparsed: r.stdout + r.stderr };
	}
};
let n = 0;
const file = (data) => {
	const f = join(T, `doc-${++n}.json`);
	writeFileSync(f, JSON.stringify(data));
	return f;
};
const stored = (id, board = BOARD) => JSON.parse(readFileSync(join(board, "proposals", id + ".json"), "utf8"));
const ago = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const entry = (over) => ({ at: ago(1), run: "run-1", itemId: "pr-12", repo: "acme/widgets", tier: "fast", model: "small", section: "easy", hasRoutes: true, recommendedType: "merge", handedUp: false, reason: "Clean.", ...over });
const pair = (fast, standard = {}) => [entry(fast), entry({ ...fast, section: "easy", recommendedType: "merge", hasRoutes: true, handedUp: false, tier: "standard", model: "big", ...standard })];
const handedUp = { section: null, hasRoutes: false, recommendedType: null, handedUp: true };

const stats = { pairs: 130, handedUp: 76, answered: 54, sameSection: 54, sameRouteType: 51 };
const answers = { fast: { section: "deferred", recommendedType: "follow_up" }, standard: { section: "deferred", recommendedType: null } };
const setting = (id, extra) => ({
	id, createdAt: "2026-11-19T01:00:00Z", kind: "setting", setting: { key: "fastTier", value: "on" }, title: "Use the faster model for obvious items",
	stats, differences: [{ itemId: "issue-9413", number: 9413, url: "https://github.com/acme/widgets/issues/9413", runs: 3, ...answers }], status: "open", decidedAt: null, reason: "", ...extra,
});
const put = (id, doc) => gary("put", "proposals", id, file(doc));

// Validation on write
let r = put("set-ok", setting("set-ok"));
t.check("put proposals writes a setting proposal", r.status === 0 && stored("set-ok").kind === "setting", r.stdout + r.stderr);
r = put("set-key", setting("set-key", { setting: { key: "allowOwnTokenPushes", value: true } }));
t.check("a setting outside the allow-list is refused", r.status === 1 && /one of the keys fastTier/.test(r.stdout), r.stdout);
r = put("set-value", setting("set-value", { setting: { key: "fastTier", value: "off" } }));
t.check("a value outside the allow-list is refused", r.status === 1 && /must be one of on, shadow/.test(r.stdout), r.stdout);
r = put("set-rule", setting("set-rule", { target: "profile", file: "rules/classification.md", text: "Set fastTier." }));
t.check("a setting proposal takes no rule fields", r.status === 1 && json(r).problems.includes('a setting proposal has no field "target"') && json(r).problems.includes('a setting proposal has no field "text"'), r.stdout);
r = put("set-stats", setting("set-stats", { stats: { ...stats, answered: 60 } }));
t.check("the numbers must add up", r.status === 1 && /add up to stats\.pairs/.test(r.stdout), r.stdout);
r = put("set-diff", setting("set-diff", { differences: [{ itemId: "issue-1", runs: 0, fast: { section: "easy" }, standard: answers.standard }] }));
t.check("a difference needs its runs and both answers", r.status === 1 && /runs must be a whole number/.test(r.stdout) && /fast\.recommendedType/.test(r.stdout), r.stdout);
r = put("set-kind", { ...setting("set-kind"), kind: "config" });
t.check("an unknown kind is refused", r.status === 1 && json(r).problems.some((m) => m.startsWith('kind must be "setting"')), r.stdout);
r = put("set-back", setting("set-back", { setting: { key: "fastTier", value: "shadow" } }));
t.check("a proposal that switches back needs its reasons", r.status === 1 && /reasons must list/.test(r.stdout), r.stdout);
r = put("set-back", setting("set-back", { setting: { key: "fastTier", value: "shadow" }, reasons: ["agreement"], stats: { ...stats, recent: { answered: 40, sameSection: 30, needed: 38 } } }));
t.check("a proposal that switches back is written with its reason and numbers", r.status === 0, r.stdout + r.stderr);
r = put("set-over", setting("set-over", { setting: { key: "fastTier", value: "shadow" }, reasons: ["overrides"] }));
t.check("the reason overrides needs both rates", r.status === 1 && /stats\.overrides must be/.test(r.stdout), r.stdout);
writeFileSync(join(BOARD, "proposals", "set-ok.json"), JSON.stringify({ ...setting("set-ok"), status: "dismissed", decidedAt: ago(30) }));
writeFileSync(join(BOARD, "proposals", "set-back.json"), JSON.stringify({ ...stored("set-back"), status: "dismissed", decidedAt: ago(30) }));

// gary shadow propose, for fastTier shadow
writeFileSync(join(BOARD, "items", "issue-22.json"), JSON.stringify({ kind: "issue", repo: "acme/widgets", number: 22, url: "https://github.com/acme/widgets/issues/22", title: "t", section: "deferred" }));
gary("shadow", "record", file(Array.from({ length: 10 }, (_, k) => pair({ itemId: `pr-a${k}` })).flat()));
r = gary("shadow", "propose");
t.check("propose writes nothing below 40 pairs", json(r).ok && json(r).written === false && /10 pairs, fewer than 40/.test(json(r).why), r.stdout + r.stderr);
gary("shadow", "record", file([
	...Array.from({ length: 15 }, (_, k) => pair({ itemId: `pr-b${k}` })).flat(),
	...Array.from({ length: 12 }, (_, k) => pair({ itemId: `pr-c${k}`, ...handedUp })).flat(),
	...["run-2", "run-3", "run-4"].flatMap((id) => pair({ run: id, itemId: "issue-22", section: "deferred", recommendedType: "follow_up" }, { section: "deferred", hasRoutes: false, recommendedType: null })),
	...pair({ run: "run-5", itemId: "issue-9", section: "active", recommendedType: "reply" }),
]));
r = gary("shadow", "propose", "--dry-run");
const today = new Date().toISOString().slice(0, 10);
const onId = `learn-${today}-fast-tier-on`;
t.check("propose --dry-run prints the proposal and writes nothing", json(r).written === false && json(r).proposal?.id === onId && gary("proposals", "--json").stdout.includes(onId) === false, r.stdout + r.stderr);
r = gary("shadow", "propose");
t.check("propose writes the proposal to turn the fast tier on", json(r).written === true && json(r).id === onId && json(r).value === "on", r.stdout + r.stderr);
let p = stored(onId);
t.check("it is a setting proposal for fastTier on, without rule fields", p.kind === "setting" && p.setting.key === "fastTier" && p.setting.value === "on" && p.status === "open" && !("text" in p) && !("target" in p) && !("why" in p), p);
t.check("its numbers come from the report", JSON.stringify(p.stats) === JSON.stringify({ pairs: 41, handedUp: 12, answered: 29, sameSection: 28, sameRouteType: 25 }), p.stats);
const d22 = p.differences.find((x) => x.itemId === "issue-22");
t.check("the differences are grouped per item with their runs", p.differences.length === 2 && p.differences[0] === d22 && d22.runs === 3 && d22.fast.recommendedType === "follow_up" && d22.standard.recommendedType === null, p.differences);
t.check("a difference takes number and URL from the board item", d22.number === 22 && d22.url === "https://github.com/acme/widgets/issues/22" && !("url" in p.differences[1]), p.differences);
r = gary("shadow", "propose");
t.check("propose writes no second one while one is open", json(r).written === false && json(r).why === `${onId} is still open`, r.stdout);
r = gary("proposals");
t.check("gary proposals names the setting", new RegExp(`open\\s+${onId}  Use the faster model for obvious items  -> fastTier=on`).test(r.stdout), r.stdout);

const server = spawn(process.execPath, [join(ROOT, "server/server.mjs"), "--dry-run", "--port", String(port)], { env, stdio: ["ignore", "inherit", "pipe"] });
let stderr = "";
server.stderr.on("data", (d) => (stderr += d));
for (let i = 0; i < 50 && !stderr.includes(" on http://127.0.0.1:"); i++) await sleep(100);
try {
	const token = readFileSync(join(root, "state", "server-token"), "utf8").trim();
	const api = async (path, body) => {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? "POST" : "GET", headers: { "X-Board-Token": token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		return { status: res.status, data: await res.json() };
	};
	const act = (action, proposalId, text) => api("/api/action", { instance: "widgets", action, proposalId, text });
	const log = () => {
		try {
			return readFileSync(join(home, "state", "decisions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
		} catch {
			return [];
		}
	};
	const open = async () => (await api("/api/state")).data.proposals;

	t.check("/api/state serves the open setting proposal", (await open()).some((x) => x.id === onId && x.kind === "setting" && x.stats.pairs === 41), await open());

	// A config that would be invalid is left alone
	writeFileSync(configFile, configText("shadow", { activeWindowDays: "soon" }));
	r = await act("accept_proposal", onId);
	t.check("accept refuses when the config would be invalid", r.data.ok === false && /would be invalid, so nothing was changed/.test(r.data.result) && /activeWindowDays/.test(r.data.result), r);
	t.check("the config and the proposal stay as they were", readFileSync(configFile, "utf8") === configText("shadow", { activeWindowDays: "soon" }) && stored(onId).status === "open");
	writeFileSync(configFile, configText("shadow"));

	// A proposal changed on disk to another key is refused
	writeFileSync(join(BOARD, "proposals", "set-evil.json"), JSON.stringify(setting("set-evil", { setting: { key: "allowOwnTokenPushes", value: true } })));
	r = await act("accept_proposal", "set-evil");
	t.check("accept checks the allow-list again", r.data.ok === false && /invalid and was not applied/.test(r.data.result) && readFileSync(configFile, "utf8") === configText("shadow") && stored("set-evil").status === "open", r);
	writeFileSync(join(BOARD, "proposals", "set-evil.json"), JSON.stringify({ ...setting("set-evil"), kind: "other", text: "x" }));
	r = await act("accept_proposal", "set-evil");
	t.check("accept refuses an unknown kind", r.data.ok === false && readFileSync(configFile, "utf8") === configText("shadow"), r);
	writeFileSync(join(BOARD, "proposals", "set-evil.json"), JSON.stringify({ ...setting("set-evil"), status: "dismissed" }));

	// Accept writes the config
	r = await act("accept_proposal", onId);
	t.check("accept answers with the setting and the config file", r.data.ok && r.data.changed === true && r.data.setting?.key === "fastTier" && r.data.setting.value === "on" && r.data.result === configFile, r);
	t.check("the config has the new value, with its key order and indentation kept", readFileSync(configFile, "utf8") === configText("on"), readFileSync(configFile, "utf8"));
	p = stored(onId);
	t.check("the proposal is accepted", p.status === "accepted" && !!p.decidedAt && !("note" in p), p);
	await sleep(50);
	const accepted = log().filter((e) => e.type === "accepted_proposal");
	t.check("the decision log has the accept with the old value", accepted.length === 1 && accepted[0].proposal.id === onId && accepted[0].proposal.setting.value === "on" && accepted[0].from === "shadow" && accepted[0].instance === "widgets", log());
	r = await act("accept_proposal", onId);
	t.check("a decided setting proposal cannot be decided again", r.status === 409, r);
	r = gary("shadow", "propose");
	t.check("the next command reads the new value and counts from the accept on", json(r).written === false && /agrees with the standard tier/.test(json(r).why) && json(r).pairs === 0, r.stdout + r.stderr);
	r = gary("decisions");
	t.check("gary decisions prints the accept", /accepted_proposal .*fastTier from shadow to on/.test(r.stdout), r.stdout);

	// The config already has the value
	await api("/api/db", { instance: "widgets", op: "set", path: "proposals/set-again", data: setting("set-again") });
	const before = statSync(configFile).mtimeMs;
	r = await act("accept_proposal", "set-again");
	p = stored("set-again");
	t.check("accept with the value already set writes no config", r.data.ok && r.data.changed === false && statSync(configFile).mtimeMs === before, r);
	t.check("that proposal is accepted with a note", p.status === "accepted" && p.note === 'fastTier was already "on"' && r.data.note === p.note, p);
	await sleep(50);
	t.check("no second accept is logged", log().filter((e) => e.type === "accepted_proposal").length === 1);

	// A config without the key gets it at the end
	writeFileSync(configFile, JSON.stringify({ profile: PROFILE, me: ME, bot: null }, null, "\t") + "\n");
	await api("/api/db", { instance: "widgets", op: "set", path: "proposals/set-default", data: setting("set-default") });
	r = await act("accept_proposal", "set-default");
	t.check("a config without the key gets it, with tabs kept", r.data.ok && r.data.changed && readFileSync(configFile, "utf8") === JSON.stringify({ profile: PROFILE, me: ME, bot: null, fastTier: "on" }, null, "\t") + "\n", readFileSync(configFile, "utf8"));
	await sleep(50);
	t.check("the old value of a missing key is the default", log().filter((e) => e.type === "accepted_proposal").at(-1).from === "off", log().at(-1));

	// Dismiss
	await api("/api/db", { instance: "widgets", op: "set", path: "proposals/set-no", data: setting("set-no", { setting: { key: "fastTier", value: "shadow" }, reasons: ["agreement"], stats: { ...stats, recent: { answered: 40, sameSection: 30, needed: 38 } } }) });
	r = await act("dismiss_proposal", "set-no", "One bad day");
	p = stored("set-no");
	t.check("dismiss stores the reason and leaves the config", r.data.ok && p.status === "dismissed" && p.reason === "One bad day" && JSON.parse(readFileSync(configFile, "utf8")).fastTier === "on", p);
	await sleep(50);
	const dismissed = log().filter((e) => e.type === "dismissed_proposal");
	t.check("the dismissal is logged with the setting", dismissed.length === 1 && dismissed[0].proposal.kind === "setting" && dismissed[0].proposal.setting.value === "shadow" && dismissed[0].reason === "One bad day", dismissed);
	t.check("no open proposals are left", (await open()).length === 0, await open());
} finally {
	server.kill("SIGTERM");
}

// gary shadow propose, for fastTier on
const second = makeHome(join(T, "second"), { fastTier: "on" });
const g2 = (...args) => run(second.env, ...args);
r = g2("shadow", "propose");
t.check("propose writes nothing without a reason to switch back", json(r).written === false && /agrees with the standard tier/.test(json(r).why), r.stdout + r.stderr);
g2("shadow", "record", file([
	...Array.from({ length: 30 }, (_, k) => pair({ itemId: `pr-s${k}`, sampled: true }, { sampled: true })).flat(),
	...Array.from({ length: 10 }, (_, k) => pair({ itemId: `pr-d${k}`, section: "active", sampled: true }, { sampled: true })).flat(),
	// Older than the week the proposal looks at
	...Array.from({ length: 5 }, (_, k) => pair({ at: ago(20), run: "run-old", itemId: `pr-o${k}` }, { at: ago(20) })).flat(),
]));
const decision = (k, tier, type) => JSON.stringify({ at: ago(2), instance: "widgets", type, itemId: `pr-${tier}${k}`, item: { kind: "pr", classifiedBy: tier } });
mkdirSync(join(second.home, "state"), { recursive: true });
writeFileSync(join(second.home, "state", "decisions.jsonl"), [
	...Array.from({ length: 20 }, (_, k) => decision(k, "fast", k < 8 ? "chose_alternative" : "snoozed")),
	...Array.from({ length: 25 }, (_, k) => decision(k, "standard", k < 2 ? "edited_text" : "snoozed")),
].join("\n") + "\n");
r = g2("shadow", "propose");
const backId = `learn-${today}-fast-tier-shadow`;
p = json(r).written ? stored(backId, join(second.home, "state", "board")) : {};
t.check("propose writes the proposal to switch back", json(r).written === true && json(r).id === backId && p.setting?.value === "shadow" && p.title === "Go back to the standard model for all items", r.stdout + r.stderr);
t.check("it names both reasons", JSON.stringify(p.reasons) === JSON.stringify(["agreement", "overrides"]), p.reasons);
t.check("it carries the recent agreement and both override rates", JSON.stringify(p.stats?.recent) === JSON.stringify({ answered: 40, sameSection: 30, needed: 38 })
	&& JSON.stringify(p.stats?.overrides) === JSON.stringify({ fast: { items: 20, changed: 8 }, standard: { items: 25, changed: 2 } }) && p.stats.pairs === 40, p.stats);
t.check("the differences leave out the equal answers", p.differences?.length === 10 && p.differences.every((x) => x.runs === 1 && x.fast.section === "active" && x.standard.section === "easy"), p.differences);

// gary shadow convert
const third = makeHome(join(T, "third"), { fastTier: "shadow" });
const g3 = (...args) => run(third.env, ...args);
const board3 = join(third.home, "state", "board");
mkdirSync(join(board3, "proposals"), { recursive: true });
const oldId = "learn-2026-11-19-fast-tier-on";
const old = {
	id: oldId, createdAt: "2026-11-19T01:00:00Z", title: "Let the fast model classify the obvious items", why: "The shadow log has 130 pairs.",
	evidence: [{ at: "2026-11-18T15:52:50Z", itemId: "issue-22", type: "shadow_disagreement", gist: "run 1: fast deferred / follow_up, standard deferred / no route" }],
	target: "profile", file: "rules/classification.md", heading: "",
	text: "To turn the fast tier on, set `fastTier` to `\"on\"` in `/home/someone/.config/gary/instances/widgets/config.json`. Accepting this card only adds this note here and leaves the config unchanged.",
	status: "open", decidedAt: null, reason: "",
};
const rule = { ...old, id: "learn-2026-11-19-rule", title: "Close stale PRs", text: "Close them." };
writeFileSync(join(board3, "proposals", oldId + ".json"), JSON.stringify(old));
writeFileSync(join(board3, "proposals", rule.id + ".json"), JSON.stringify(rule));
g3("shadow", "record", file([
	...Array.from({ length: 4 }, (_, k) => pair({ itemId: `pr-b${k}` })).flat(),
	...Array.from({ length: 3 }, (_, k) => pair({ itemId: `pr-c${k}`, ...handedUp })).flat(),
	...["run-2", "run-3"].flatMap((id) => pair({ run: id, itemId: "issue-22", section: "deferred", recommendedType: "follow_up" }, { section: "deferred", hasRoutes: false, recommendedType: null })),
]));
r = g3("shadow", "propose");
t.check("an open fast tier proposal in the rule shape also blocks a new one", json(r).written === false && json(r).why === `${oldId} is still open`, r.stdout);
r = g3("shadow", "convert", oldId, "--dry-run");
t.check("convert --dry-run changes nothing", json(r).written === false && json(r).proposal?.kind === "setting" && stored(oldId, board3).text === old.text, r.stdout + r.stderr);
r = g3("shadow", "convert", oldId);
p = stored(oldId, board3);
t.check("convert rebuilds the proposal as a setting proposal under the same id", json(r).written === true && p.id === oldId && p.kind === "setting" && p.setting.key === "fastTier" && p.setting.value === "on", r.stdout + r.stderr);
t.check("it keeps the time and the status and drops the rule fields", p.createdAt === old.createdAt && p.status === "open" && ["target", "file", "heading", "text", "why", "evidence"].every((k) => !(k in p)), p);
t.check("its numbers and differences come from the report", JSON.stringify(p.stats) === JSON.stringify({ pairs: 9, handedUp: 3, answered: 6, sameSection: 6, sameRouteType: 4 }) && p.differences.length === 1 && p.differences[0].runs === 2, p);
r = g3("shadow", "convert", oldId);
t.check("a second convert changes nothing", json(r).written === false && /setting proposal already/.test(json(r).why), r.stdout);
r = g3("shadow", "convert", rule.id);
t.check("convert leaves a rule proposal alone", r.status !== 0 && /does not name fastTier/.test(r.stdout + r.stderr) && stored(rule.id, board3).text === "Close them.", r.stdout + r.stderr);
r = g3("shadow", "convert", "learn-none");
t.check("convert names a missing proposal", r.status !== 0 && /There is no proposal learn-none/.test(r.stdout + r.stderr), r.stdout + r.stderr);
r = g3("put", "proposals", oldId, file(p));
t.check("the converted proposal passes gary put", r.status === 0, r.stdout + r.stderr);

await sleep(200);
removeDir(T);
t.done();
