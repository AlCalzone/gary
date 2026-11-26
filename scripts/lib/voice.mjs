// The data side of the voice skill: collect the maintainer's GitHub text, split it, measure it and score drafts against it.
// Everything here reads GitHub with GraphQL queries under the maintainer's stored `gh` login and writes only local files.
import { execFile } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { instanceNames, loadInstance, personalFile, repoMatches, rootDir, rootStateDir } from "./config.mjs";

export const dataDir = () => join(rootStateDir(), "voice");
export const styleDir = () => join(rootDir(), "style");
export const SECTION_START = "<!-- gary-voice:start -->";
export const SECTION_END = "<!-- gary-voice:end -->";
export const SITUATIONS = ["ask_info", "confirm_diagnosis", "already_fixed", "correct_user", "recommend", "device_fault", "decline", "pushback", "config_request", "thank_contributor", "maintainer_discussion", "pr_review", "own_pr_note", "closing", "pointer", "other"];
const KNOWN_BOTS = /^(dependabot|renovate|copilot|github-actions|codecov|changeset-bot|mergify|stale)\b/i;
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

// GitHub access

/** Runs one GraphQL query under the stored `gh` login. Refuses anything but a query. Retries server errors twice. */
export async function query(text, variables = {}) {
	if (!/^\s*query\b/.test(text)) throw new Error("gary voice only sends GraphQL queries");
	const env = { ...process.env, GH_PROMPT_DISABLED: "1" };
	for (const name of TOKEN_VARS) delete env[name];
	for (let attempt = 0; ; attempt++) {
		try {
			const stdout = await new Promise((resolve, reject) => {
				const child = execFile("gh", ["api", "graphql", "--input", "-"], { env, maxBuffer: 256 * 1024 * 1024 }, (err, out, stderr) => {
					if (err) reject(Object.assign(new Error((stderr || err.message).trim()), { stdout: out }));
					else resolve(out);
				});
				child.stdin.end(JSON.stringify({ query: text, variables }));
			});
			const response = JSON.parse(stdout);
			if (response.errors?.length) throw new Error(response.errors.map((e) => e.message).join("; "));
			return response.data;
		} catch (e) {
			if (attempt >= 2 || !/50[234]|timeout|ECONNRESET|something went wrong/i.test(e.message)) throw e;
			await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
		}
	}
}

async function paginate(text, pick, variables = {}) {
	const nodes = [];
	let after = null;
	do {
		const conn = pick(await query(text, { ...variables, after }));
		nodes.push(...conn.nodes.filter(Boolean));
		after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
	} while (after);
	return nodes;
}

// Text

/** Drops quoted lines, HTML comments and collapsed `<details>` blocks, so only the author's own words remain. */
export function clean(body) {
	let t = String(body ?? "").replace(/\r/g, "");
	t = t.replace(/<!--[\s\S]*?-->/g, "").replace(/<details>[\s\S]*?<\/details>/gi, "");
	t = t.split("\n").filter((l) => !l.trimStart().startsWith(">")).join("\n");
	return t.replace(/\n{3,}/g, "\n\n").trim();
}

/** The bot logins of this machine's instances, lowercased. */
export function instanceBots() {
	const bots = new Set();
	for (const name of instanceNames()) {
		try {
			const login = loadInstance(name).config.bot?.login;
			if (login) bots.add(login.toLowerCase());
		} catch {
			// An instance with broken settings names no bot
		}
	}
	return bots;
}

export function isBot(author, bots) {
	if (!author) return false;
	if (author.type === "Bot") return true;
	const login = String(author.login ?? "").toLowerCase();
	return login.endsWith("[bot]") || bots.has(login) || KNOWN_BOTS.test(login);
}

/** Whether a reply is nothing but commands to bots, like `@dependabot rebase`. */
export function isCommandOnly(text, bots) {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	if (!lines.length) return false;
	let sawCommand = false;
	for (const line of lines) {
		const m = line.match(/^@([A-Za-z0-9-]+(?:\[bot\])?)\s+\S/);
		if (m) {
			const login = m[1].toLowerCase();
			if (!(bots.has(login) || login.endsWith("-bot") || login.endsWith("[bot]") || KNOWN_BOTS.test(login))) return false;
			sawCommand = true;
		} else if (!/^```|^[\w-]+:\s|^[{}[\]]/.test(line)) {
			// Lines that are not a fence or a key: value belong to prose, which makes the reply more than a command
			return false;
		}
	}
	return sawCommand;
}

/** Replaces @-handles with `@user`, except the logins in `keep`. */
export function anonymize(text, keep = new Set()) {
	return String(text).replace(/(?<![\w`/])@([A-Za-z0-9-]+)/g, (m, login) => (keep.has(login.toLowerCase()) ? m : "@user"));
}

export const threadHash = (key) => parseInt(createHash("sha1").update(key).digest("hex").slice(0, 8), 16) % 100;

/** train for 70% of the threads, dev and test for 15% each. The split depends only on the thread key. */
export function splitOf(key) {
	const h = threadHash(key);
	return h < 70 ? "train" : h < 85 ? "dev" : "test";
}

export const replyId = (url) => createHash("sha1").update(url).digest("hex").slice(0, 10);

// Collect

const VIEWER = "query VoiceViewer { viewer { login } }";
const ISSUE_COMMENTS = `query VoiceIssueComments($after: String) { viewer { issueComments(first: 100, after: $after) {
	pageInfo { hasNextPage endCursor }
	nodes { createdAt url body issue { number repository { nameWithOwner } } pullRequest { number } } } } }`;
const DISCUSSION_COMMENTS = `query VoiceDiscussionComments($after: String) { viewer { repositoryDiscussionComments(first: 100, after: $after) {
	pageInfo { hasNextPage endCursor }
	nodes { createdAt url body discussion { number repository { nameWithOwner } } } } } }`;
const PULL_REQUESTS = `query VoicePullRequests($after: String) { viewer { pullRequests(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
	pageInfo { hasNextPage endCursor }
	nodes { number url title body createdAt merged additions deletions repository { nameWithOwner } } } } }`;
const REVIEWED_PRS = `query VoiceReviews($from: DateTime!, $to: DateTime!, $after: String) { viewer { contributionsCollection(from: $from, to: $to) {
	pullRequestReviewContributions(first: 100, after: $after) {
		pageInfo { hasNextPage endCursor }
		nodes { pullRequest { number repository { nameWithOwner } } } } } } }`;
const LOGIN = /^[A-Za-z0-9-]+$/;

/** The GraphQL query that reads the maintainer's reviews on up to ten PRs. contributionsCollection lists only one review per PR. */
export function reviewsQuery(keys, me) {
	if (!LOGIN.test(me)) throw new Error(`Bad login: ${me}`);
	const parts = keys.map((key, i) => {
		const [, repo, number] = key.match(/^issue:(.+)#(\d+)$/);
		if (!REPO_NAME.test(repo)) throw new Error(`Bad repository name: ${repo}`);
		const [owner, name] = repo.split("/");
		return `r${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) { author { login }
			reviews(first: 30, author: "${me}") { nodes { url body createdAt comments(first: 100) { nodes { url body path diffHunk createdAt replyTo { id } } } } } } }`;
	});
	return `query VoicePrReviews { ${parts.join("\n")} }`;
}

const AUTHOR = "author { __typename login }";
const ISSUE_THREAD = `title body createdAt ${AUTHOR} comments(first: 100) { nodes { url body createdAt ${AUTHOR} } }`;
const DISCUSSION_THREAD = `title body createdAt ${AUTHOR} comments(first: 60) { nodes { url body createdAt ${AUTHOR} replies(first: 30) { nodes { url body createdAt ${AUTHOR} } } } }`;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The GraphQL query that reads up to ten threads at once. Each key is `issue:owner/name#n` or `discussion:owner/name#n`. */
export function threadsQuery(keys) {
	const parts = keys.map((key, i) => {
		const [, kind, repo, number] = key.match(/^(issue|discussion):(.+)#(\d+)$/);
		if (!REPO_NAME.test(repo)) throw new Error(`Bad repository name: ${repo}`);
		const [owner, name] = repo.split("/");
		const body = kind === "issue"
			? `issueOrPullRequest(number: ${number}) { __typename ... on Issue { ${ISSUE_THREAD} } ... on PullRequest { ${ISSUE_THREAD} } }`
			: `discussion(number: ${number}) { ${DISCUSSION_THREAD} }`;
		return `t${i}: repository(owner: "${owner}", name: "${name}") { ${body} }`;
	});
	return `query VoiceThreads { ${parts.join("\n")} }`;
}

function inRange(at, from, to) {
	return at >= from && at < to;
}

function wanted(repo, { include, exclude }) {
	if (include.length && !include.some((g) => repoMatches(repo, g))) return false;
	return !exclude.some((g) => repoMatches(repo, g));
}

/** Year-long windows from `from` to `to`, because contributionsCollection spans at most one year. */
function yearWindows(from, to) {
	const out = [];
	for (let start = new Date(from); start < new Date(to); ) {
		const end = new Date(Math.min(new Date(to), new Date(start).setUTCFullYear(start.getUTCFullYear() + 1)));
		out.push([start.toISOString(), new Date(end - 1000).toISOString()]);
		start = end;
	}
	return out;
}

/**
 * Collects the maintainer's comments, PRs and review comments created in [from, to), with the thread around each comment.
 * Writes replies.jsonl, prs.jsonl, reviews.jsonl, others.jsonl and meta.json into `dir`. `log` gets progress lines.
 */
export async function collect({ from, to, include = [], exclude = [], dir = dataDir(), log = () => {} }) {
	mkdirSync(dir, { recursive: true });
	const bots = instanceBots();
	const me = (await query(VIEWER)).viewer.login;
	const filter = { include, exclude };
	log(`Collecting for ${me}, ${from} to ${to}`);

	const comments = [];
	for (const c of await paginate(ISSUE_COMMENTS, (d) => d.viewer.issueComments)) {
		const repo = c.issue?.repository?.nameWithOwner;
		if (repo && inRange(c.createdAt, from, to) && wanted(repo, filter)) comments.push({ ...c, key: `issue:${repo}#${c.issue.number}`, kind: c.pullRequest ? "pr" : "issue" });
	}
	log(`${comments.length} issue and PR comments`);
	for (const c of await paginate(DISCUSSION_COMMENTS, (d) => d.viewer.repositoryDiscussionComments)) {
		const repo = c.discussion?.repository?.nameWithOwner;
		if (repo && inRange(c.createdAt, from, to) && wanted(repo, filter)) comments.push({ ...c, key: `discussion:${repo}#${c.discussion.number}`, kind: "discussion" });
	}
	log(`${comments.length} comments with discussions`);

	const prs = (await paginate(PULL_REQUESTS, (d) => d.viewer.pullRequests))
		.filter((p) => inRange(p.createdAt, from, to) && wanted(p.repository.nameWithOwner, filter))
		.map((p) => ({ key: `issue:${p.repository.nameWithOwner}#${p.number}`, repo: p.repository.nameWithOwner, number: p.number, url: p.url, title: p.title, body: clean(p.body), rawEmpty: !String(p.body ?? "").trim(), merged: p.merged, changedLines: p.additions + p.deletions, createdAt: p.createdAt }))
		.map((p) => ({ ...p, split: splitOf(p.key) }));
	log(`${prs.length} PRs`);

	const reviewed = new Set();
	for (const [wFrom, wTo] of yearWindows(from, to)) {
		for (const { pullRequest: pr } of await paginate(REVIEWED_PRS, (d) => d.viewer.contributionsCollection.pullRequestReviewContributions, { from: wFrom, to: wTo })) {
			if (pr && wanted(pr.repository.nameWithOwner, filter)) reviewed.add(`issue:${pr.repository.nameWithOwner}#${pr.number}`);
		}
	}
	const reviews = [];
	const prKeys = [...reviewed];
	for (let i = 0; i < prKeys.length; i += 10) {
		const batch = prKeys.slice(i, i + 10);
		const data = await query(reviewsQuery(batch, me)).catch(() => ({}));
		batch.forEach((key, j) => {
			const pr = data[`r${j}`]?.pullRequest;
			for (const r of pr?.reviews?.nodes ?? []) {
				if (!inRange(r.createdAt, from, to)) continue;
				reviews.push({ key, split: splitOf(key), url: r.url, summary: clean(r.body), prAuthor: pr.author?.login ?? null, createdAt: r.createdAt,
					comments: r.comments.nodes.map((c) => ({ url: c.url, body: clean(c.body), path: c.path, diffHunk: String(c.diffHunk ?? "").slice(-1500), isReply: !!c.replyTo })) });
			}
		});
	}
	log(`${reviews.length} reviews`);

	const keys = [...new Set(comments.map((c) => c.key))];
	const threads = new Map();
	for (let i = 0; i < keys.length; i += 10) {
		const batch = keys.slice(i, i + 10);
		let data;
		try {
			data = await query(threadsQuery(batch));
		} catch (e) {
			// A deleted repo or thread fails the whole batch, so read its threads one by one
			data = {};
			for (const [j, key] of batch.entries()) {
				try {
					data[`t${j}`] = (await query(threadsQuery([key]))).t0;
				} catch {
					data[`t${j}`] = null;
				}
			}
		}
		batch.forEach((key, j) => {
			const repo = data[`t${j}`];
			const node = repo?.issueOrPullRequest ?? repo?.discussion;
			if (node) threads.set(key, node);
		});
		if (i % 200 === 0) log(`threads ${i}/${keys.length}`);
	}

	const replies = [];
	const others = [];
	for (const [key, t] of threads) {
		const list = [];
		for (const c of t.comments.nodes) {
			list.push(c);
			for (const r of c.replies?.nodes ?? []) list.push(r);
		}
		list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		for (const c of list) if (!isMe(c.author, me) && !isBot(c.author, bots)) others.push(clean(c.body));
		if (!isMe(t.author, me) && !isBot(t.author, bots)) others.push(clean(t.body));
		const mine = comments.filter((c) => c.key === key);
		for (const c of mine) {
			const reply = clean(c.body);
			if (!reply) continue;
			const idx = list.findIndex((x) => x.url === c.url);
			const before = (idx >= 0 ? list.slice(0, idx) : []).filter((x) => !isBot(x.author, bots));
			const prev = before.at(-1) ?? (idx >= 0 && !isMe(t.author, me) ? { author: t.author, body: t.body } : null);
			replies.push({
				id: replyId(c.url), key, split: splitOf(key), kind: c.kind, url: c.url, createdAt: c.createdAt,
				title: t.title, opening: clean(t.body).slice(0, 4000), openAuthor: t.author?.login ?? "ghost", openIsMe: isMe(t.author, me),
				// Up to six earlier comments, so a draft sees what the maintainer saw
				context: before.slice(-6).map((x) => ({ author: x.author?.login ?? "ghost", isMe: isMe(x.author, me), body: clean(x.body).slice(0, 1500) })),
				contextPartial: idx < 0,
				prevAuthor: prev?.author?.login ?? null, prevIsMe: isMe(prev?.author, me), prev: prev ? clean(prev.body).slice(0, 3000) : null,
				reply, cmd: isCommandOnly(reply, bots),
			});
		}
	}
	writeJsonl(join(dir, "replies.jsonl"), replies);
	writeJsonl(join(dir, "prs.jsonl"), prs);
	writeJsonl(join(dir, "reviews.jsonl"), reviews);
	writeJsonl(join(dir, "others.jsonl"), others.filter(Boolean).map((body) => ({ body })));
	const meta = { me, from, to, include, exclude, collectedAt: new Date().toISOString(), counts: countsOf(replies, prs, reviews), threads: threads.size };
	writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, "\t"));
	return meta;
}

const isMe = (author, me) => String(author?.login ?? "").toLowerCase() === me.toLowerCase();

function countsOf(replies, prs, reviews) {
	const by = (list, f) => list.reduce((o, x) => ((o[f(x)] = (o[f(x)] ?? 0) + 1), o), {});
	return {
		replies: replies.length, commandOnly: replies.filter((r) => r.cmd).length, byKind: by(replies, (r) => r.kind), bySplit: by(replies, (r) => r.split),
		repos: Object.keys(by(replies, (r) => r.key.replace(/^\w+:|#\d+$/g, ""))).length,
		prs: prs.length, reviews: reviews.length, reviewComments: reviews.reduce((n, r) => n + r.comments.length, 0),
	};
}

// Files

export function writeJsonl(file, rows) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

export function readJsonl(file) {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export const readJsonFile = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);

// Features

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|(?<!\w)[:;]-?[)(DPp/](?!\w)|¯\\_\(ツ\)_\/¯/u;
export const HEDGES = ["i think", "probably", "maybe", "might", "seems", "i guess", "likely", "perhaps", "not sure", "should", "afaik", "iirc", "i believe"];
const stripCode = (t) => String(t).replace(/```[\s\S]*?```/g, " ");
export const words = (t) => stripCode(t).match(/[A-Za-z0-9'’-]+/g) ?? [];

/** Countable features of one text. The calibration compares them between real and drafted texts. */
export function features(t) {
	const p = stripCode(t);
	const w = words(t);
	const sentences = p.replace(/`[^`]*`/g, "X").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter((s) => s.trim());
	const paras = p.split(/\n\s*\n/).filter((x) => x.trim());
	const noUrls = p.replace(/https?:\/\/\S+/g, "");
	return {
		words: w.length,
		sentLen: w.length / Math.max(1, sentences.length),
		paras: paras.length,
		greeting: /^\s*(hi|hello|hey|dear|good (morning|evening))\b/i.test(t),
		signoff: /(^|\n)\s*(cheers|regards|best|kind regards|br)\W*\s*$/i.test(t),
		mention: /(?<![\w`])@[A-Za-z0-9-]+/.test(p),
		link: /https?:\/\/|#\d{2,}/.test(p),
		codeblock: t.includes("```"),
		inlinecode: /`[^`\n]+`/.test(p),
		bold: /\*\*[^*]+\*\*/.test(p),
		bullets: /^\s*([-*]|\d+\.)\s+/m.test(p),
		headings: /^#{1,6}\s/m.test(p),
		emoji: EMOJI.test(p),
		question: noUrls.includes("?"),
		exclaim: p.replace(/!\[/g, "").includes("!"),
		startsThanks: /^\s*(thanks?\b|thank you)/i.test(t),
		singleBreaks: /[.!?:)]\s*\n(?!\s*\n)\s*\S/.test(p.replace(/^\s*([-*]|\d+\.)\s.*$/gm, "")),
		contractions: /\b\w+['’](t|s|re|ll|ve|d|m)\b/i.test(p),
		parenthesis: /\([^)]{3,}\)/.test(noUrls),
	};
}

const NUMERIC = ["words", "sentLen", "paras"];

function pct(sorted, q) {
	return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
}

/** Percentiles of the numeric features and rates in percent of the others. */
export function summarize(texts) {
	const F = texts.map(features);
	const out = { n: F.length };
	for (const k of NUMERIC) {
		const v = F.map((f) => f[k]).sort((a, b) => a - b);
		out[k] = { p10: round(pct(v, 0.1)), median: round(pct(v, 0.5)), p90: round(pct(v, 0.9)) };
	}
	for (const k of Object.keys(features(""))) if (!NUMERIC.includes(k)) out[k] = F.length ? round((100 * F.filter((f) => f[k]).length) / F.length) : 0;
	return out;
}

const round = (x) => Math.round(x * 10) / 10;
const norm = (t) => stripCode(t).toLowerCase().match(/[a-z0-9'’]+/g) ?? [];

/** The n-grams the maintainer uses more than everyone else in the same threads, by log-odds with a prior of one. */
export function distinctive(mine, theirs, n, { min = 12, top = 30 } = {}) {
	const grams = (texts) => {
		const c = new Map();
		for (const t of texts) {
			const w = norm(t);
			for (let i = 0; i + n <= w.length; i++) {
				const g = w.slice(i, i + n).join(" ");
				c.set(g, (c.get(g) ?? 0) + 1);
			}
		}
		return c;
	};
	const A = grams(mine);
	const B = grams(theirs);
	const na = [...A.values()].reduce((a, b) => a + b, 0);
	const nb = [...B.values()].reduce((a, b) => a + b, 0);
	const V = new Set([...A.keys(), ...B.keys()]).size;
	const scored = [];
	for (const [g, ca] of A) {
		if (ca < min) continue;
		const cb = B.get(g) ?? 0;
		const z = (Math.log((ca + 1) / (na + V - ca - 1)) - Math.log((cb + 1) / (nb + V - cb - 1))) / Math.sqrt(1 / (ca + 1) + 1 / (cb + 1));
		scored.push({ gram: g, mine: ca, others: cb, z: round(z) });
	}
	return scored.sort((a, b) => b.z - a.z).slice(0, top);
}

/** Share in percent of `texts` that contain each phrase, compared without regard to case. */
export function phraseShares(texts, phrases) {
	const lower = texts.map((t) => t.toLowerCase());
	return Object.fromEntries(phrases.map((p) => [p, round((100 * lower.filter((t) => t.includes(p.toLowerCase())).length) / Math.max(1, texts.length))]));
}

function topCounts(values, top) {
	const c = new Map();
	for (const v of values) if (v) c.set(v, (c.get(v) ?? 0) + 1);
	return [...c].sort((a, b) => b[1] - a[1]).slice(0, top);
}

const ENGLISH = new Set(["the", "is", "to", "and", "a", "of", "you", "it", "that", "this", "in", "for", "not", "be", "with", "on", "if", "are", "can", "should"]);

/** Whether a text reads as English: at least 8% of its words are common English words. Texts under 8 words count as English. */
export function isEnglish(text) {
	const w = norm(text);
	if (w.length < 8) return true;
	return w.filter((x) => ENGLISH.has(x)).length / w.length >= 0.08;
}

/**
 * The replies the stats and the calibration use: no commands to bots, and, when most replies are English, only English ones.
 * A maintainer who writes in two languages would otherwise get a profile that mixes both.
 */
export function usable(replies) {
	const list = replies.filter((r) => !r.cmd);
	const english = list.filter((r) => isEnglish(r.reply));
	return english.length >= 0.8 * list.length ? english : list;
}

/** Everything the profile is written from, as one object. Reads the files that `collect` and `merge` wrote. */
export function stats(dir = dataDir()) {
	const replies = usable(readJsonl(join(dir, "replies.jsonl")));
	const train = replies.filter((r) => r.split === "train");
	const situations = readJsonFile(join(dir, "situations.json"), {});
	const others = readJsonl(join(dir, "others.jsonl")).map((o) => o.body);
	const out = { replies: summarize(train.map((r) => r.reply)), byKind: {}, bySituation: {} };
	for (const kind of ["issue", "pr", "discussion"]) out.byKind[kind] = summarize(train.filter((r) => r.kind === kind).map((r) => r.reply));
	for (const s of SITUATIONS) {
		const texts = train.filter((r) => situations[r.id] === s).map((r) => r.reply);
		if (texts.length) out.bySituation[s] = summarize(texts);
	}
	out.firstWords = topCounts(train.map((r) => norm(r.reply).slice(0, 3).join(" ")), 30);
	out.lastWords = topCounts(train.map((r) => norm(r.reply).slice(-3).join(" ")), 20);
	out.distinctive = { 1: distinctive(train.map((r) => r.reply), others, 1), 2: distinctive(train.map((r) => r.reply), others, 2), 3: distinctive(train.map((r) => r.reply), others, 3) };
	out.hedges = phraseShares(train.map((r) => r.reply), HEDGES);

	const prs = readJsonl(join(dir, "prs.jsonl")).filter((p) => p.split === "train");
	const buckets = { "<=20": [], "21-100": [], "101-500": [], ">500": [] };
	for (const p of prs) buckets[p.changedLines <= 20 ? "<=20" : p.changedLines <= 100 ? "21-100" : p.changedLines <= 500 ? "101-500" : ">500"].push(words(p.body).length);
	out.prs = {
		n: prs.length,
		emptyPct: round((100 * prs.filter((p) => !p.body).length) / Math.max(1, prs.length)),
		titlePrefixes: topCounts(prs.map((p) => (p.title.match(/^(\w+)(\([^)]*\))?!?:/) ?? [, "none"])[1]), 12),
		issueRefs: topCounts(prs.flatMap((p) => [...p.body.matchAll(/\b(fixes|closes|resolves|fixed|related to|see|part of)\b:?\s*(#\d+|https:\/\/github\.com\/\S+\/(issues|pull)\/\d+)/gi)].map((m) => m[1].toLowerCase())), 10),
		bodyWordsBySize: Object.fromEntries(Object.entries(buckets).map(([b, v]) => [b, { n: v.length, median: pct(v.sort((x, y) => x - y), 0.5) }])),
		body: summarize(prs.map((p) => p.body).filter(Boolean)),
	};
	const reviews = readJsonl(join(dir, "reviews.jsonl")).filter((r) => r.split === "train");
	const inline = reviews.flatMap((r) => r.comments.filter((c) => !c.isReply && c.body).map((c) => c.body));
	out.reviews = {
		n: reviews.length, summaries: summarize(reviews.map((r) => r.summary).filter(Boolean)), emptySummaryPct: round((100 * reviews.filter((r) => !r.summary).length) / Math.max(1, reviews.length)),
		inline: summarize(inline), suggestionPct: round((100 * inline.filter((b) => b.includes("```suggestion")).length) / Math.max(1, inline.length)),
	};
	return out;
}

// Classification

/** Writes the train replies (or a random sample of `sample`) into batches of `size` for the classifier agents. */
export function classifyBatches({ dir = dataDir(), size = 250, sample = 0, seed = 1 } = {}) {
	let train = usable(readJsonl(join(dir, "replies.jsonl"))).filter((r) => r.split === "train");
	if (sample && sample < train.length) train = shuffled(train, seed).slice(0, sample);
	const out = join(dir, "classify");
	mkdirSync(out, { recursive: true });
	const files = [];
	for (let i = 0; i * size < train.length; i++) {
		const file = join(out, `in_${i}.jsonl`);
		writeJsonl(file, train.slice(i * size, (i + 1) * size).map((r) => ({ id: r.id, kind: r.kind, title: r.title.slice(0, 150), opening: r.opening.slice(0, 400), prevAuthor: r.prevAuthor, prevIsMe: r.prevIsMe, prev: (r.prev ?? "").slice(0, 500), reply: r.reply.slice(0, 1200) })));
		files.push({ in: file, out: join(out, `out_${i}.jsonl`) });
	}
	return files;
}

/** Merges the classifier outputs into situations.json. Unknown keys count as `other`. */
export function mergeClassified(dir = dataDir()) {
	const out = join(dir, "classify");
	const situations = {};
	let unknown = 0;
	for (const name of existsSync(out) ? readdirSync(out).filter((n) => /^out_\d+\.jsonl$/.test(n)) : []) {
		for (const row of readJsonl(join(out, name))) {
			if (!SITUATIONS.includes(row.situation)) unknown++;
			situations[row.id] = SITUATIONS.includes(row.situation) ? row.situation : "other";
		}
	}
	writeFileSync(join(dir, "situations.json"), JSON.stringify(situations));
	const counts = topCounts(Object.values(situations), SITUATIONS.length);
	return { classified: Object.keys(situations).length, unknown, counts };
}

// Seeded shuffle, so a sample can be repeated

function shuffled(list, seed) {
	const a = [...list];
	let s = seed >>> 0 || 1;
	const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

// Examples

/** Writes `<style>/examples/<situation>.md` with up to `per` real replies each, handles anonymized but for `keep`. */
export function writeExamples({ dir = dataDir(), out = join(styleDir(), "examples"), per = 8, keep = [], seed = 5 } = {}) {
	const replies = usable(readJsonl(join(dir, "replies.jsonl"))).filter((r) => r.split === "train" && r.prev && !r.prevIsMe && r.reply.length < 1500);
	const situations = readJsonFile(join(dir, "situations.json"), {});
	const keepSet = new Set(keep.map((k) => k.toLowerCase()));
	mkdirSync(out, { recursive: true });
	const oneLine = (t, n) => {
		const s = String(t ?? "").replace(/```[\s\S]*?```/g, "[code]").replace(/\s+/g, " ").trim();
		return s.length > n ? s.slice(0, n) + "…" : s;
	};
	const written = {};
	for (const s of SITUATIONS) {
		const list = shuffled(replies.filter((r) => situations[r.id] === s), seed).slice(0, per);
		if (!list.length) continue;
		const parts = [`# ${s}\n\nReal replies. Each one: the message it answered, shortened, then the reply as written.\n`];
		for (const r of list) {
			const who = keepSet.has(String(r.prevAuthor).toLowerCase()) ? `@${r.prevAuthor}` : "@user";
			parts.push(`## ${r.kind}: ${oneLine(r.title, 90)}\n\nPrevious (${who}): ${anonymize(oneLine(r.prev, 220), keepSet)}\n\nReply:\n\n\`\`\`\`md\n${anonymize(r.reply, keepSet)}\n\`\`\`\`\n`);
		}
		writeFileSync(join(out, `${s}.md`), parts.join("\n"));
		written[s] = list.length;
	}
	return written;
}

// Calibration rounds

export const roundDir = (dir, round) => join(dir, "rounds", round);
const usedIds = (dir) => {
	const root = join(dir, "rounds");
	const ids = new Set();
	for (const r of existsSync(root) ? readdirSync(root) : []) for (const x of readJsonFile(join(root, r, "items.json"), [])) ids.add(x.id);
	return ids;
};

function contextOf(r) {
	return { genre: "reply", kind: r.kind, title: r.title, opening: r.opening.slice(0, 2500), openAuthor: r.openIsMe ? "the maintainer" : r.openAuthor,
		earlier: r.context.map((c) => ({ author: c.isMe ? "the maintainer" : c.author, body: c.body })) };
}

/**
 * Picks `n` replies and `prs` PR bodies of `split` that no earlier round used, one per thread, spread over issue, discussion and PR
 * threads. Writes items.json with the real texts and gen_<k>.json without them, `batches` files.
 */
export function sample({ dir = dataDir(), round, split = "dev", n = 24, prs = 3, batches = 3, seed = 1 }) {
	const used = usedIds(dir);
	const pool = usable(readJsonl(join(dir, "replies.jsonl"))).filter((r) => r.split === split && r.prev && !r.prevIsMe && !r.contextPartial && isEnglish(`${r.title} ${r.prev} ${r.reply}`) && words(r.reply).length >= 3 && words(r.reply).length <= 250 && !used.has(r.id));
	const kinds = ["issue", "discussion", "pr"];
	const share = Object.fromEntries(kinds.map((k) => [k, pool.filter((r) => r.kind === k).length]));
	const total = Object.values(share).reduce((a, b) => a + b, 0) || 1;
	const items = [];
	for (const k of kinds) {
		const want = Math.round((n * share[k]) / total);
		const seen = new Set();
		for (const r of shuffled(pool.filter((x) => x.kind === k), seed)) {
			if (items.filter((x) => x.kind === k).length >= want || items.length >= n) break;
			// A comment posted in two threads would show the judge the real text in the other item's context
			if (seen.has(r.key) || items.some((x) => x.real === r.reply || x.context.earlier.some((e) => e.body === r.reply) || r.context.some((e) => e.body === x.real))) continue;
			seen.add(r.key);
			items.push({ id: r.id, genre: "reply", kind: r.kind, real: r.reply, context: contextOf(r) });
		}
	}
	const prPool = readJsonl(join(dir, "prs.jsonl")).filter((p) => p.split === split && words(p.body).length >= 8 && !used.has(`pr-${p.repo}#${p.number}`));
	for (const p of shuffled(prPool, seed).slice(0, prs)) items.push({ id: `pr-${p.repo}#${p.number}`, genre: "pr_body", kind: "pr", real: p.body, context: { genre: "pr_body", title: p.title, changedLines: p.changedLines } });
	const out = roundDir(dir, round);
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, "items.json"), JSON.stringify(items, null, "\t"));
	const blind = items.map(({ real, ...rest }) => rest);
	const files = [];
	for (let b = 0; b < batches; b++) {
		const file = join(out, `gen_${b}.json`);
		writeFileSync(file, JSON.stringify(blind.filter((_, i) => i % batches === b), null, "\t"));
		files.push({ in: file, out: join(out, `gen_out_${b}.json`) });
	}
	return { items: items.length, files };
}

function generated(out) {
	const gen = {};
	for (const name of readdirSync(out).filter((x) => /^gen_out_\d+\.json$/.test(x))) Object.assign(gen, JSON.parse(readFileSync(join(out, name), "utf8")));
	return gen;
}

/** Writes judge.json with each real text and its draft as A and B in random order, and key.json with the answer. */
export function pairs({ dir = dataDir(), round }) {
	const out = roundDir(dir, round);
	const items = readJsonFile(join(out, "items.json"), []);
	const gen = generated(out);
	const key = {};
	const list = [];
	for (const x of items) {
		if (typeof gen[x.id] !== "string") continue;
		const realFirst = randomInt(2) === 0;
		key[x.id] = realFirst ? "A" : "B";
		list.push({ id: x.id, context: x.context, A: realFirst ? x.real : gen[x.id], B: realFirst ? gen[x.id] : x.real });
	}
	const order = list.map((x) => [randomInt(1e9), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
	writeFileSync(join(out, "judge.json"), JSON.stringify(order, null, "\t"));
	writeFileSync(join(out, "key.json"), JSON.stringify(key));
	return { pairs: order.length, file: join(out, "judge.json"), out: join(out, "judge_out.json") };
}

/** Judge accuracy, the features where drafts leave the maintainer's range, and the judge's tells. Writes score.json. */
export function score({ dir = dataDir(), round }) {
	const out = roundDir(dir, round);
	const items = Object.fromEntries(readJsonFile(join(out, "items.json"), []).map((x) => [x.id, x]));
	const key = readJsonFile(join(out, "key.json"), {});
	const judged = Object.fromEntries(readJsonFile(join(out, "judge_out.json"), []).map((j) => [j.id, j]));
	const gen = generated(out);
	const ids = Object.keys(key).filter((id) => judged[id]);
	const right = ids.filter((id) => judged[id].pick === key[id]);
	const replyIds = ids.filter((id) => items[id].genre === "reply");
	const drafted = summarize(replyIds.map((id) => gen[id]));
	const real = summarize(replyIds.map((id) => items[id].real));
	const base = summarize(usable(readJsonl(join(dir, "replies.jsonl"))).filter((r) => r.split === "train").map((r) => r.reply));
	const deviations = [];
	for (const [k, v] of Object.entries(base)) {
		if (k === "n") continue;
		if (typeof v === "object") {
			const m = drafted[k].median;
			if (m < v.p10 || m > v.p90 || Math.abs(m - v.median) > Math.max(3, 0.5 * v.median)) deviations.push({ feature: k, drafted: m, maintainer: v.median, kind: "median" });
		} else if (Math.abs(drafted[k] - v) > 15) deviations.push({ feature: k, drafted: drafted[k], maintainer: v, kind: "percent" });
	}
	const result = {
		round, judged: ids.length, correct: right.length, accuracy: ids.length ? Math.round((100 * right.length) / ids.length) : null,
		byGenre: Object.fromEntries(["reply", "pr_body"].map((g) => [g, `${right.filter((id) => items[id].genre === g).length}/${ids.filter((id) => items[id].genre === g).length}`])),
		confidence: topCounts(ids.map((id) => String(judged[id].confidence)), 5),
		words: { drafted: drafted.words, sample: real.words },
		deviations,
		tells: ids.map((id) => ({ id, genre: items[id].genre, caught: judged[id].pick === key[id], confidence: judged[id].confidence, tell: judged[id].tell })),
	};
	writeFileSync(join(out, "score.json"), JSON.stringify(result, null, "\t"));
	return result;
}

// Preference check

/**
 * Reads variants.json, `[{ id, context, dimension, variants: [{ label, text }] }]`, puts the maintainer's real text in place of one
 * variant in `real` items picked at random, shuffles the options and writes questions.json and key.json. Handles are anonymized.
 */
export function swap({ dir = dataDir(), file, real = 2, keep = [] }) {
	const items = JSON.parse(readFileSync(file, "utf8"));
	const keepSet = new Set(keep.map((k) => k.toLowerCase()));
	const replies = Object.fromEntries(readJsonl(join(dir, "replies.jsonl")).map((r) => [r.id, r.reply]));
	const prs = Object.fromEntries(readJsonl(join(dir, "prs.jsonl")).map((p) => [`pr-${p.repo}#${p.number}`, p.body]));
	const withReal = new Set();
	const candidates = items.map((x, i) => [i, x]).filter(([, x]) => replies[x.id] ?? prs[x.id]);
	while (withReal.size < Math.min(real, candidates.length)) withReal.add(candidates[randomInt(candidates.length)][0]);
	const key = {};
	const questions = items.map((x, i) => {
		const options = x.variants.map((v) => ({ label: v.label, text: v.text }));
		if (withReal.has(i)) options[randomInt(options.length)] = { label: "REAL", text: replies[x.id] ?? prs[x.id] };
		const shuffledOptions = options.map((o) => [randomInt(1e9), o]).sort((a, b) => a[0] - b[0]).map(([, o]) => o);
		key[x.id] = { dimension: x.dimension, options: Object.fromEntries(shuffledOptions.map((o, j) => [String.fromCharCode(65 + j), o.label])) };
		return { id: x.id, context: x.context, options: shuffledOptions.map((o, j) => ({ letter: String.fromCharCode(65 + j), text: anonymize(o.text, keepSet) })) };
	});
	const out = join(dir, "preference");
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, "questions.json"), JSON.stringify(questions, null, "\t"));
	writeFileSync(join(out, "key.json"), JSON.stringify(key, null, "\t"));
	return { questions: questions.length, withReal: withReal.size, file: join(out, "questions.json") };
}

// Writing the result

/**
 * Puts `section` between the voice markers of the shared personal.md, or appends it with the markers when there are none.
 * Keeps a copy of the old file in `<style>/backups/`. Returns the paths. With `check`, writes nothing and returns the new text.
 */
export function applySection(section, { check = false, file = personalFile() } = {}) {
	const old = existsSync(file) ? readFileSync(file, "utf8") : "";
	const block = `${SECTION_START}\n${section.trim()}\n${SECTION_END}`;
	const start = old.indexOf(SECTION_START);
	const end = old.indexOf(SECTION_END);
	if ((start < 0) !== (end < 0) || end < start) throw new Error(`${file} has only one of the voice markers or has them in the wrong order. Fix the file first.`);
	const next = start >= 0 ? old.slice(0, start) + block + old.slice(end + SECTION_END.length) : (old.trimEnd() ? old.trimEnd() + "\n\n" : "") + block + "\n";
	if (check) return { file, text: next, changed: next !== old };
	let backup = null;
	if (old) {
		mkdirSync(join(styleDir(), "backups"), { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		for (let i = 0; !backup || existsSync(backup); i++) backup = join(styleDir(), "backups", `personal.${stamp}${i ? `-${i}` : ""}.md`);
		copyFileSync(file, backup);
	}
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, next);
	renameSync(tmp, file);
	return { file, backup, changed: next !== old };
}
