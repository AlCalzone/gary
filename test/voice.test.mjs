// The data steps of the voice skill: cleaning, bot commands, the split, collect against the fake gh, stats, rounds and the write.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOT, ME } from "./fixtures/github.mjs";
import { makeHome, removeDir, runner, tempDir } from "./lib.mjs";

const t = runner("voice");
const T = tempDir();
const { root, env } = makeHome(T);
process.env.GARY_HOME = root;
process.env.PATH = env.PATH;
const fixture = join(T, "voice.json");
process.env.FAKE_GH_VOICE = fixture;
const voice = await import("../scripts/lib/voice.mjs");

// Text
t.check("clean drops quotes and HTML comments", voice.clean("> you said\n<!-- template -->\nMy answer.\n\n\n\nMore.") === "My answer.\n\nMore.");
t.check("clean drops collapsed blocks", voice.clean("See log.\n<details>\nlong\n</details>") === "See log.");
const bots = new Set([BOT.toLowerCase()]);
t.check("a bot command alone counts as command only", voice.isCommandOnly(`@${BOT} automerge`, bots));
t.check("a dependabot command counts as command only", voice.isCommandOnly("@dependabot rebase", bots));
t.check("a command with a config block counts as command only", voice.isCommandOnly(`@${BOT} add compat flag\n\`\`\`jsonc\nmanualValueRefreshDelayMs: 250\n\`\`\``, bots));
t.check("a mention of a person is a reply", !voice.isCommandOnly("@hubot can you test this?", bots));
t.check("a command plus prose is a reply", !voice.isCommandOnly(`@${BOT} automerge\nThanks for the fix!`, bots));
t.check("isBot knows the Bot type, [bot] logins and the instance bot", voice.isBot({ __typename: "Bot", type: "Bot", login: "x" }, bots) && voice.isBot({ login: "renovate[bot]" }, bots) && voice.isBot({ login: BOT }, bots) && !voice.isBot({ login: "hubot" }, bots));
t.check("anonymize keeps listed logins", voice.anonymize("@hubot and @Keeper, see `@scope/pkg`", new Set(["keeper"])) === "@user and @Keeper, see `@scope/pkg`");
t.check("the split depends only on the thread key", voice.splitOf("issue:a/b#1") === voice.splitOf("issue:a/b#1"));
const counts = { train: 0, dev: 0, test: 0 };
for (let i = 0; i < 2000; i++) counts[voice.splitOf(`issue:a/b#${i}`)]++;
t.check("the split is about 70/15/15", counts.train > 1300 && counts.train < 1500 && counts.dev > 220 && counts.test > 220, counts);

// Features
const f = voice.features("Ok it looks like the stick (a 700 series) is at fault.\nPlease update it. See https://example.com/x!");
t.check("features count words outside code", voice.features("one two ```three four``` five").words === 3);
t.check("features find a parenthesis, a link and single line breaks", f.parenthesis && f.link && f.singleBreaks && !f.greeting, f);
t.check("features find a greeting", voice.features("Hi there, try this").greeting);
t.check("summarize gives percentiles and rates", (() => {
	const s = voice.summarize(["a b c", "a b c d e", "Hi! a?"]);
	return s.n === 3 && s.words.median === 3 && s.question > 33 && s.question < 34;
})());

// Collect
const repo = "hubot/widgets";
const thread = (n, author, comments) => ({ title: `Thread ${n}`, body: "It broke.", createdAt: "2023-01-01T00:00:00Z", author: { __typename: "User", login: author }, comments: { nodes: comments } });
const c = (url, login, body, at, type = "User") => ({ url, body, createdAt: at, author: { __typename: type, login } });
const threads = {};
const issueComments = [];
for (let n = 1; n <= 60; n++) {
	const mine = c(`https://github.com/${repo}/issues/${n}#issuecomment-${n}`, ME, n % 10 === 0 ? `@${BOT} automerge` : `I think this is caused by the stick. Please make a driver log (loglevel debug) of issue ${n}.`, "2023-02-01T00:00:00Z");
	threads[`issue:${repo}#${n}`] = thread(n, "hubot", [c(`u${n}a`, "hubot", "Any news?", "2023-01-02T00:00:00Z"), c(`u${n}b`, "renovate[bot]", "bump", "2023-01-03T00:00:00Z", "Bot"), mine]);
	issueComments.push({ createdAt: mine.createdAt, url: mine.url, body: mine.body, issue: { number: n, repository: { nameWithOwner: repo } }, pullRequest: null });
}
issueComments.push({ createdAt: "2026-01-01T00:00:00Z", url: "late", body: "too late", issue: { number: 1, repository: { nameWithOwner: repo } }, pullRequest: null });
issueComments.push({ createdAt: "2023-02-01T00:00:00Z", url: "other", body: "elsewhere", issue: { number: 1, repository: { nameWithOwner: "hubot/excluded" } }, pullRequest: null });
writeFileSync(fixture, JSON.stringify({
	login: ME, issueComments, discussionComments: [],
	pullRequests: [{ number: 99, url: `https://github.com/${repo}/pull/99`, title: "fix: the thing", body: "We now do it right.\n\nfixes: #1", createdAt: "2023-03-01T00:00:00Z", merged: true, additions: 10, deletions: 2, repository: { nameWithOwner: repo } }],
	reviews: [{ pullRequestReview: { url: "r1", body: "Thanks, two minor things.", createdAt: "2023-04-01T00:00:00Z", pullRequest: { number: 98, author: { login: "hubot" }, repository: { nameWithOwner: repo } }, comments: { nodes: [{ url: "rc1", body: "Nit: Title Case", path: "a.json", diffHunk: "@@", createdAt: "2023-04-01T00:00:00Z", replyTo: null }] } } }],
	threads,
}));
const dir = voice.dataDir();
const meta = await voice.collect({ from: "2022-01-01T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z", exclude: ["hubot/excluded"], dir });
const replies = voice.readJsonl(join(dir, "replies.jsonl"));
t.check("collect keeps comments in range from wanted repos", meta.counts.replies === 60, meta.counts);
t.check("collect marks bot commands", meta.counts.commandOnly === 6, meta.counts);
t.check("collect sets the previous non-bot comment", replies[0].prevAuthor === "hubot" && replies[0].prev === "Any news?", replies[0]);
t.check("collect keeps earlier comments as context, without bots", replies[0].context.length === 1 && replies[0].context[0].body === "Any news?", replies[0].context);
t.check("collect writes PRs, reviews and others' text", meta.counts.prs === 1 && meta.counts.reviewComments === 1 && voice.readJsonl(join(dir, "others.jsonl")).length > 0, meta.counts);
t.check("threadsQuery refuses a bad repository name", (() => {
	try {
		voice.threadsQuery(['issue:a"){x}/b#1']);
		return false;
	} catch {
		return true;
	}
})());

// Classification, stats and examples
const files = voice.classifyBatches({ dir, size: 20 });
t.check("batches hold only train replies without commands", files.length >= 1 && files.every((x) => voice.readJsonl(x.in).every((r) => replies.find((y) => y.id === r.id && y.split === "train" && !y.cmd))));
for (const x of files) voice.writeJsonl(x.out, voice.readJsonl(x.in).map((r, i) => ({ id: r.id, situation: i % 2 ? "ask_info" : "nonsense" })));
const merged = voice.mergeClassified(dir);
t.check("merge maps unknown keys to other", merged.unknown > 0 && merged.counts.some(([k]) => k === "other"), merged);
const s = voice.stats(dir);
t.check("stats cover replies, situations, PRs and reviews", s.replies.n > 0 && s.bySituation.ask_info && "emptyPct" in s.prs && "suggestionPct" in s.reviews, Object.keys(s));
t.check("stats find distinctive words against others", s.distinctive[1].length > 0, s.distinctive[1].slice(0, 3));
const written = voice.writeExamples({ dir });
t.check("examples are written per situation and anonymized", written.ask_info > 0 && !readFileSync(join(voice.styleDir(), "examples", "ask_info.md"), "utf8").includes("@hubot"), written);

// A calibration round
const pool = replies.filter((r) => r.split === "dev" && !r.cmd).length;
const round = voice.sample({ dir, round: "r1", split: "dev", n: 4, prs: 0, batches: 2 });
t.check("sample takes dev items no round used yet", round.items === Math.min(4, pool), { round, pool });
const items = JSON.parse(readFileSync(join(dir, "rounds", "r1", "items.json"), "utf8"));
const blind = readFileSync(round.files[0].in, "utf8");
t.check("the generator input has no real text", items.length === 0 || !items.some((x) => blind.includes(x.real)));
for (const x of round.files) writeFileSync(x.out, JSON.stringify(Object.fromEntries(JSON.parse(readFileSync(x.in, "utf8")).map((y) => [y.id, "Hello! Thanks for reporting. Hope this helps."]))));
const p = voice.pairs({ dir, round: "r1" });
const key = JSON.parse(readFileSync(join(dir, "rounds", "r1", "key.json"), "utf8"));
writeFileSync(p.out, JSON.stringify(Object.entries(key).map(([id, k]) => ({ id, pick: k, confidence: 4, tell: "greeting" }))));
const sc = voice.score({ dir, round: "r1" });
t.check("score is 100% for a judge that is always right", sc.judged === 0 || sc.accuracy === 100, sc);
const second = voice.sample({ dir, round: "r2", split: "dev", n: 4, prs: 0 });
const ids2 = JSON.parse(readFileSync(join(dir, "rounds", "r2", "items.json"), "utf8")).map((x) => x.id);
t.check("a later round reuses no item", !ids2.some((id) => items.some((x) => x.id === id)), second);

// The preference check
const vfile = join(T, "variants.json");
const target = replies.find((r) => !r.cmd);
writeFileSync(vfile, JSON.stringify([
	{ id: target.id, context: "A user asks", dimension: "length", variants: [{ label: "short", text: "Ok." }, { label: "long", text: "Ok, @hubot, here is more." }] },
	{ id: "none", context: "Another", dimension: "tone", variants: [{ label: "warm", text: "a" }, { label: "cold", text: "b" }] },
]));
const sw = voice.swap({ dir, file: vfile, real: 2 });
const q = JSON.parse(readFileSync(sw.file, "utf8"));
const k2 = JSON.parse(readFileSync(join(dir, "preference", "key.json"), "utf8"));
t.check("swap puts the real text only where one exists", sw.withReal === 1 && Object.values(k2[target.id].options).includes("REAL") && !Object.values(k2.none.options).includes("REAL"), k2);
t.check("swap anonymizes and letters the options", q[0].options.every((o, i) => o.letter === "ABC"[i] && !o.text.includes("@hubot")), q[0]);

// Writing the result
const pfile = join(root, "personal.md");
writeFileSync(pfile, "# Personal rules\n\nKeep this.\n");
const a1 = voice.applySection("## How I write\n\nShort.");
t.check("apply appends the section with markers and keeps the rest", readFileSync(pfile, "utf8") === `# Personal rules\n\nKeep this.\n\n${voice.SECTION_START}\n## How I write\n\nShort.\n${voice.SECTION_END}\n` && existsSync(a1.backup), a1);
writeFileSync(pfile, readFileSync(pfile, "utf8") + "\n## After\n\nAlso keep.\n");
voice.applySection("## How I write\n\nLonger now.");
const after = readFileSync(pfile, "utf8");
t.check("apply replaces only the marked section", after.includes("Longer now.") && !after.includes("Short.") && after.includes("Keep this.") && after.includes("Also keep."), after);
const checked = voice.applySection("## Other", { check: true });
t.check("apply --check writes nothing", checked.changed && readFileSync(pfile, "utf8") === after);
writeFileSync(pfile, `x\n${voice.SECTION_START}\nno end`);
t.check("apply refuses a file with one marker", (() => {
	try {
		voice.applySection("y");
		return false;
	} catch {
		return true;
	}
})());
t.check("apply keeps one backup per write", readdirSync(join(voice.styleDir(), "backups")).length === 2);

// Only queries reach gh
t.check("query refuses a mutation", await voice.query("mutation { x }").then(() => false, () => true));

removeDir(T);
t.done();
