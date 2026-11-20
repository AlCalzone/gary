// Where a PR by the instance's bot comes from when Gary did not open it: the local Claude Code session whose tool calls
// created it. Claude Code keeps one JSONL transcript per session at <sessions>/<project dir>/<session id>.jsonl. Every
// line carries `sessionId`, `cwd` and `timestamp`. Transcripts can hold secrets and are read as data only. An origin
// keeps only the session id, its directory, its times, the first prompt cut to 100 characters and the transcript's name.
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readJson, writeAtomic } from "./board-store.mjs";
import { expandHome, rootConfig, stateDir } from "./config.mjs";

export const DEFAULT_SESSIONS_DIR = "~/.claude/projects";
// `ORIGIN_QUIET_MS` sets how long the origin session must be quiet before the watch acts on its PR
export const ORIGIN_QUIET_MS = 30 * 60000;
const PROMPT_LENGTH = 100;
// The clock of the transcripts and GitHub's clock differ a little
const SLACK_MS = 5 * 60000;
const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;

/** The directory of the session transcripts: GARY_SESSIONS_DIR, then `sessionsDir` in the root config.json. */
export function sessionsDir() {
	let configured = null;
	try {
		configured = rootConfig().sessionsDir ?? null;
	} catch {}
	return resolve(expandHome(process.env.GARY_SESSIONS_DIR || configured || DEFAULT_SESSIONS_DIR));
}

export const originsFile = () => join(stateDir(), "origins.json");

/** The cached origins of the instance by item id: `{ "pr-<n>": origin }`. */
export async function readOrigins() {
	return (await readJson(originsFile())) ?? {};
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const validTime = (t) => typeof t === "string" && Number.isFinite(Date.parse(t));

function resultText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
}

/**
 * How the transcript `text` shows that its session opened `pr` (`{ number, repo, branch, createdAt }`):
 * `{ via: "gh_pr_create" | "mcp" | "push", at }`, or null. The call must come before the PR's creation time.
 * `gh pr create` and an MCP create-PR call count when their result names the PR's URL. A `git push` of the head
 * branch counts when a later tool result names the URL. A session that only reads or mentions the PR has none of these.
 */
export function openerEvidence(text, pr) {
	const url = new RegExp(`github\\.com/${escapeRe(pr.repo)}/pull/${pr.number}(?!\\d)`, "i");
	const branch = pr.branch ? new RegExp(`(^|[\\s:'"=])${escapeRe(pr.branch)}($|[\\s'";&|)])`, "m") : null;
	const created = Date.parse(pr.createdAt ?? "");
	const inTime = (at) => validTime(at) && (!Number.isFinite(created) || Date.parse(at) <= created + SLACK_MS);
	const calls = new Map();
	let pushedAt = null;
	let found = null;
	for (const line of text.split("\n")) {
		const use = line.includes('"tool_use"') && (line.includes("pr create") || /create.?pull.?request/i.test(line) || line.includes("push"));
		const result = line.includes('"tool_result"') && (line.includes(`/pull/${pr.number}`) || (!!pr.branch && line.includes(pr.branch)));
		if (!use && !result) continue;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		const content = o?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const c of content) {
			if (c?.type === "tool_use" && typeof c.id === "string") {
				const command = typeof c.input?.command === "string" ? c.input.command : "";
				if (/\bgh\s+pr\s+create\b/.test(command)) calls.set(c.id, { via: "gh_pr_create", at: o.timestamp });
				else if (/create[_-]?pull[_-]?request/i.test(String(c.name ?? ""))) calls.set(c.id, { via: "mcp", at: o.timestamp });
				else if (/\bgit\b.*\bpush\b/.test(command)) calls.set(c.id, { via: "push", at: o.timestamp, named: !!branch && branch.test(command) });
			} else if (c?.type === "tool_result") {
				const call = calls.get(c.tool_use_id);
				const out = resultText(c.content);
				if (call?.via === "push") {
					if (!pushedAt && inTime(call.at) && (call.named || (!!branch && branch.test(out)))) pushedAt = call.at;
				} else if (call && inTime(call.at) && url.test(out)) {
					return { via: call.via, at: call.at };
				}
				if (!found && pushedAt && url.test(out) && validTime(o.timestamp) && Date.parse(o.timestamp) >= Date.parse(pushedAt)) found = { via: "push", at: pushedAt };
			}
		}
	}
	return found;
}

function promptOf(content) {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		if (content.some((c) => c?.type === "tool_result")) return "";
		text = content.map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).join(" ");
	}
	if (/^\s*<(local-command|system-reminder)/.test(text)) return "";
	// A slash command keeps its name and arguments
	const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
	if (name) text = `${name} ${/<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? ""}`;
	text = text.replace(/\s+/g, " ").trim();
	return text.length > PROMPT_LENGTH ? text.slice(0, PROMPT_LENGTH - 1).trimEnd() + "…" : text;
}

/** The session id, the first `cwd`, the first timestamp and the first prompt of a transcript. */
export function sessionFacts(text) {
	const out = { sessionId: null, cwd: null, startedAt: null, prompt: null };
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		if (!o || typeof o !== "object") continue;
		if (!out.sessionId && typeof o.sessionId === "string") out.sessionId = o.sessionId;
		if (!out.cwd && typeof o.cwd === "string") out.cwd = o.cwd;
		if (!out.startedAt && validTime(o.timestamp)) out.startedAt = new Date(o.timestamp).toISOString();
		if (out.prompt === null && o.type === "user" && o.isMeta !== true && o.isSidechain !== true) out.prompt = promptOf(o.message?.content) || null;
		if (out.sessionId && out.cwd && out.startedAt && out.prompt !== null) break;
	}
	return out;
}

async function transcripts(root) {
	let dirs;
	try {
		dirs = await readdir(root, { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
		throw e;
	}
	const out = [];
	for (const d of dirs) {
		if (!d.isDirectory()) continue;
		let names = [];
		try {
			names = await readdir(join(root, d.name));
		} catch {
			continue;
		}
		for (const n of names) if (n.endsWith(".jsonl")) out.push(join(root, d.name, n));
	}
	return out;
}

// gh and an MCP call beat a push. Among equals the call closest to the PR's creation wins
function better(a, b) {
	if (!b) return true;
	if ((a.via === "push") !== (b.via === "push")) return b.via === "push";
	return Date.parse(a.at) > Date.parse(b.at);
}

/**
 * The origin of each PR in `prs` (`[{ number, repo, branch, createdAt }]`) by number: a found origin, or null.
 * A transcript is read only when it changed after the PR was created, and parsed only when it names the PR's URL.
 */
export async function findOrigins(prs, root = sessionsDir(), now = new Date()) {
	const out = new Map(prs.map((p) => [p.number, null]));
	const best = new Map();
	const open = prs.filter((p) => validTime(p.createdAt) && typeof p.repo === "string");
	if (!open.length) return out;
	const earliest = Math.min(...open.map((p) => Date.parse(p.createdAt)));
	for (const file of await transcripts(root)) {
		let st;
		try {
			st = await stat(file);
		} catch {
			continue;
		}
		if (st.mtimeMs < earliest - SLACK_MS) continue;
		const candidates = open.filter((p) => st.mtimeMs >= Date.parse(p.createdAt) - SLACK_MS);
		if (!candidates.length) continue;
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		for (const p of candidates) {
			if (!text.includes(`/pull/${p.number}`)) continue;
			const evidence = openerEvidence(text, p);
			if (evidence && better(evidence, best.get(p.number)?.evidence)) best.set(p.number, { evidence, file, text, mtime: st.mtime });
		}
	}
	for (const [number, { evidence, file, text, mtime }] of best) {
		const facts = sessionFacts(text);
		const sessionId = basename(file, ".jsonl");
		if (!SESSION_ID.test(sessionId) || typeof facts.cwd !== "string") continue;
		out.set(number, {
			found: true,
			sessionId,
			cwd: facts.cwd,
			transcript: relative(root, file).split(sep).join("/"),
			startedAt: facts.startedAt,
			lastActiveAt: mtime.toISOString(),
			prompt: facts.prompt,
			via: evidence.via,
			checkedAt: now.toISOString(),
		});
	}
	return out;
}

/** The time the origin's transcript last changed, or its cached `lastActiveAt` when the file is gone. */
export async function lastActive(origin, root = sessionsDir()) {
	if (!origin?.found) return null;
	if (typeof origin.transcript === "string" && !origin.transcript.split("/").includes("..")) {
		try {
			return (await stat(join(root, ...origin.transcript.split("/")))).mtime.toISOString();
		} catch {}
	}
	return validTime(origin.lastActiveAt) ? origin.lastActiveAt : null;
}

/** The found origin with a fresh `lastActiveAt` while its session was active in the last 30 minutes, or null. */
export async function busyOrigin(origin, now = Date.now(), root = sessionsDir()) {
	const at = await lastActive(origin, root);
	return at && now - Date.parse(at) < ORIGIN_QUIET_MS ? { ...origin, lastActiveAt: at } : null;
}

/**
 * Looks up the origin of every PR in `prs` that the cache does not hold yet, or of all with `refresh`, and refreshes
 * `lastActiveAt` of the cached ones. Writes and returns the cache, which keeps only the PRs in `prs`. A PR without a
 * found session is cached as `{ found: false, checkedAt }` and not searched again.
 */
export async function updateOrigins(prs, { refresh = false, root = sessionsDir(), now = new Date() } = {}) {
	const cache = await readOrigins();
	const key = (p) => `pr-${p.number}`;
	const found = await findOrigins(prs.filter((p) => refresh || !cache[key(p)]), root, now);
	const next = {};
	for (const p of prs) {
		let o = found.has(p.number) ? (found.get(p.number) ?? { found: false, checkedAt: now.toISOString() }) : cache[key(p)];
		if (o?.found) o = { ...o, lastActiveAt: (await lastActive(o, root)) ?? o.lastActiveAt };
		next[key(p)] = o;
	}
	if (JSON.stringify(next) !== JSON.stringify(cache)) {
		await mkdir(dirname(originsFile()), { recursive: true });
		await writeAtomic(originsFile(), next);
	}
	return next;
}

/** The session directory with the home directory as `~`. */
export function shortDir(dir) {
	const home = homedir();
	return dir === home ? "~" : dir.startsWith(home + sep) ? "~" + dir.slice(home.length) : dir;
}

/** The shell command that resumes the session in its directory. */
export function resumeCommand(origin) {
	const dir = shortDir(origin.cwd);
	const quoted = /^~?[\w./+@-]*$/.test(dir) ? dir : dir.startsWith("~/") ? "~/" + quote(dir.slice(2)) : quote(dir);
	return `cd ${quoted} && claude --resume ${origin.sessionId}`;
}

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
