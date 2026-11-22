// Links the fix PRs of an escalated discussion to the issue it became: the records move to the issue, and each open
// PR's body gets one closing line. The issue number comes only from the bot's comment on the discussion.
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { boardDir, readJson, writeAtomic } from "./board-store.mjs";
import { releaseClaim, takeClaim, claimRefusal } from "./claims.mjs";
import { AUTOMATED_TEXT_LIMIT, escalationOf, instanceName, loadConfig, loadProfile, repoParts, stateDir } from "./config.mjs";
import { PAUSED_MESSAGE, isPaused } from "./control.mjs";
import { driveDir, fixRecordOf, moveFixRecords, movedRecords, patchFixRecord, prItemId, readFixRecords, readSnapshotItems } from "./fixes.mjs";
import { focusHold, focusRefusal } from "./focus.mjs";
import { GRAPHQL_ARGS, graphql } from "./gh.mjs";

export const LINK_ACTION = "link_issue";
const LAST_COMMENTS = 30;
const MAX_BODY = 65536;
const CLAIM_MINUTES = 2;
const DISCUSSION_ID = /^disc-([1-9]\d*)$/;
const ISSUE_ID = /^issue-([1-9]\d*)$/;

const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		discussion(number: $number) {
			closed
			resultComments: comments(last: ${LAST_COMMENTS}) { nodes { author { login } body createdAt lastEditedAt editor { login } } }
		}
	}
}`;

const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		escalatedIssue: issue(number: $number) { number repository { nameWithOwner } }
	}
}`;

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			id url state body author { login }
			closingIssuesReferences(first: 50) { nodes { number repository { nameWithOwner } } }
		}
	}
}`;

const UPDATE_BODY = "mutation($id: ID!, $body: String!) { updatePullRequest(input: { pullRequestId: $id, body: $body }) { pullRequest { url } } }";

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The issue number in the newest of `comments` that `bot` wrote and that starts with `pattern`, or null.
 * A comment that someone else edited does not count.
 */
export function issueInComments(comments, { pattern, bot }) {
	const re = new RegExp(pattern);
	let issue = null;
	for (const c of comments ?? []) {
		if (!same(c?.author?.login, bot)) continue;
		// People with write access can edit the bot's comment
		if (c.lastEditedAt && !same(c.editor?.login, bot)) continue;
		const m = re.exec((c.body ?? "").trimStart().slice(0, AUTOMATED_TEXT_LIMIT));
		// The text further down can quote other people
		if (!m || m.index !== 0 || !/^[1-9]\d*$/.test(m[1] ?? "")) continue;
		if (Number.isSafeInteger(Number(m[1]))) issue = Number(m[1]);
	}
	return issue;
}

/** The body with code fences, HTML comments and inline code blanked, at the same offsets and lines. */
function proseOf(body) {
	return body.replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))|<!--[\s\S]*?(?:-->|(?![\s\S]))|`[^`\n]*`/gm, (hidden, fence) =>
		// Inline code must keep visible characters because an empty line ends a paragraph
		hidden.replace(/[^\r\n]/g, !fence && hidden.startsWith("`") ? "`" : " "));
}

/** Whether the body's prose has a closing keyword for issue `issue` of `repo`. */
export function closesInText(body, { repo, issue }) {
	const r = escapeRegex(repo);
	const target = `(?:(?:${r})?#|https://github\\.com/${r}/issues/)${issue}(?!\\d)`;
	return new RegExp(`(?:^|[^\\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\\s*|\\s+)${target}`, "i").test(proseOf(body));
}

/**
 * The body with the line `fixes #<issue>` as its own paragraph, after the paragraph that refers to the discussion.
 * A link to the discussion wins over a `#<number>`. The last one counts. Without either the line goes to the end.
 * Every other character of the body stays.
 */
export function bodyWithClosing(body, { repo, issue, discussion }) {
	const line = `fixes #${issue}`;
	const eol = body.includes("\r\n") ? "\r\n" : "\n";
	const prose = proseOf(body).split("\n");
	const lastMatch = (re) => prose.findLastIndex((l) => re.test(l));
	const byUrl = lastMatch(new RegExp(`github\\.com/${escapeRegex(repo)}/discussions/${discussion}(?!\\d)`, "i"));
	let end = byUrl >= 0 ? byUrl : lastMatch(new RegExp(`(?:^|[^\\w/&#-])#${discussion}(?!\\d)`));
	if (end < 0) {
		const gap = !body || /\n[ \t\r]*\n$/.test(body) ? "" : body.endsWith("\n") ? eol : eol + eol;
		return body + gap + line;
	}
	while (end + 1 < prose.length && prose[end + 1].trim()) end++;
	const head = body.split("\n").slice(0, end + 1).join("\n").replace(/\r$/, "");
	return head + eol + eol + line + body.slice(head.length);
}

/**
 * Finds the issues that escalated discussions with fix records became and links their fix PRs to them.
 * With `discussion`, an item id, it looks only at that discussion. `settled` then says that nothing is left to do.
 * Without it, it looks at the discussions that left the snapshot as closed or still have an open fix PR.
 * With `dryRun` it writes nothing and returns the GitHub writes as `invocations`.
 * Call it inside the instance's scope.
 */
export async function linkEscalated({ discussion: only, dryRun = false } = {}) {
	const profile = loadProfile();
	const setting = escalationOf(loadConfig(), profile);
	const out = { ok: true, enabled: setting.enabled, dryRun, moved: [], linked: [], skipped: [], waiting: [], wouldHave: [], invocations: [], errors: [] };
	if (!setting.enabled) return { ...out, reason: setting.reason, settled: true };
	const c = { ...setting, repo: profile.repo, dryRun, out };

	let records = await readFixRecords();
	const current = only === undefined ? await readSnapshotItems() : {};
	const baseline = only === undefined ? ((await readJson(join(stateDir(), "snapshot.json")))?.items ?? {}) : {};
	const toRead = only === undefined
		// The snapshot holds only open discussions. Its baseline still has one that closed since the last run
		? (id) => !current[id] && (!!baseline[id] || records[id].some((r) => current[prItemId(r?.number)]))
		: (id) => id === only;
	for (const id of Object.keys(records)) {
		const number = Number(DISCUSSION_ID.exec(id)?.[1]);
		if (!number || !records[id]?.length || !toRead(id)) continue;
		try {
			const issue = await escalatedTo(c, number);
			if (!issue) continue;
			const to = `issue-${issue}`;
			out.moved.push({ from: id, to, prs: records[id].map((r) => r.number) });
			records = dryRun ? movedRecords(records, id, to) : await moveFixRecords(id, to);
		} catch (e) {
			out.errors.push({ itemId: id, error: e.message });
		}
	}

	for (const [issueItem, list] of Object.entries(records)) {
		const issue = Number(ISSUE_ID.exec(issueItem)?.[1]);
		if (!issue) continue;
		for (const record of list ?? []) {
			if (!record?.from || record.linked || (only !== undefined && record.from !== only)) continue;
			// A PR that ended is read again only when it is open again
			if (record.ended && !current[prItemId(record.number)]) continue;
			const discussion = Number(DISCUSSION_ID.exec(record.from)?.[1]);
			if (!discussion) continue;
			try {
				await linkPr(c, { issue, issueItem, discussion, record });
			} catch (e) {
				out.errors.push({ itemId: prItemId(record.number), error: e.message });
			}
		}
	}
	out.ok = !out.errors.length;
	return only === undefined ? out : { ...out, settled: out.ok && !out.waiting.length && !records[only]?.length };
}

/** The issue a closed discussion became, or null. */
async function escalatedTo({ repo, pattern, bot }, number) {
	const { owner, name } = repoParts(repo);
	const d = (await graphql(DISCUSSION_QUERY, { owner, name, number })).repository?.discussion;
	if (!d) throw new Error(`Discussion #${number} not found`);
	if (d.closed !== true) return null;
	const issue = issueInComments(d.resultComments?.nodes, { pattern, bot });
	if (!issue) return null;
	const found = (await graphql(ISSUE_QUERY, { owner, name, number: issue })).repository?.escalatedIssue;
	if (found?.number !== issue || !same(found.repository?.nameWithOwner, repo)) throw new Error(`#${issue} is no issue of ${repo}`);
	return issue;
}

/** Adds the closing line to one PR unless it needs none or must wait. */
async function linkPr(c, target) {
	const { out, dryRun } = c;
	const { issue, issueItem, record } = target;
	const pr = prItemId(record.number);
	const wait = (reason) => out.waiting.push({ pr: record.number, issue, reason });
	for (const id of [pr, issueItem, record.from]) {
		const focus = focusHold(id, instanceName());
		if (focus) return wait(focusRefusal(id, focus));
	}
	if (dryRun || isPaused()) return editBody(c, target);
	// The claim keeps the edit apart from an agent that rewrites the PR's description
	const run = `link-escalated-${randomBytes(4).toString("hex")}`;
	const claim = await takeClaim({ itemId: pr, kind: "push", run, ttlMinutes: CLAIM_MINUTES });
	if (!claim.ok) return wait(claimRefusal(pr, "push", claim));
	try {
		// Another process can have linked it before this one got the claim
		if (fixRecordOf(await readFixRecords(), record.number)?.record.linked) return;
		const file = join(driveDir(), `${pr}.json`);
		const drive = await readJson(file);
		if (drive?.fixFor && drive.fixFor !== issueItem) await writeAtomic(file, { ...drive, fixFor: issueItem });
		await editBody(c, target);
	} finally {
		await releaseClaim({ itemId: pr, kind: "push", run });
	}
}

async function editBody({ repo, bot, dryRun, out }, { issue, issueItem, discussion, record }) {
	const { number } = record;
	const { owner, name } = repoParts(repo);
	const pr = (await graphql(PR_QUERY, { owner, name, number })).repository?.pullRequest;
	if (!pr) throw new Error(`PR #${number} not found`);
	const skip = (reason) => out.skipped.push({ pr: number, issue, reason });
	if (pr.state !== "OPEN") {
		const ended = pr.state === "MERGED" ? "merged" : "closed";
		if (!dryRun) await patchFixRecord(number, { ended });
		return skip(`the PR is ${ended}`);
	}
	// A wrong number in fixes.json must never edit someone else's PR
	if (!same(pr.author?.login, bot)) return skip(`the PR is not by ${bot}`);

	const body = pr.body ?? "";
	const referenced = (pr.closingIssuesReferences?.nodes ?? []).some((n) => n?.number === issue && same(n.repository?.nameWithOwner, repo));
	// The text counts too because the references can lag behind an edit.
	// They also stay empty for a PR to another base branch
	const edit = !referenced && !closesInText(body, { repo, issue });
	if (edit) {
		const next = bodyWithClosing(body, { repo, issue, discussion });
		if (next.length > MAX_BODY) return skip("the PR's description has no room for the line");
		const variables = { id: pr.id, body: next };
		if (dryRun) {
			out.invocations.push({ command: ["gh", ...GRAPHQL_ARGS], as: bot, stdin: { query: UPDATE_BODY, variables } });
		} else if (isPaused()) {
			out.waiting.push({ pr: number, issue, reason: PAUSED_MESSAGE });
			out.wouldHave.push({ itemId: prItemId(number), action: LINK_ACTION, params: { pr: number, issue }, reason: `Discussion #${discussion} became issue #${issue}` });
			return;
		} else {
			await graphql(UPDATE_BODY, variables);
		}
	}
	out.linked.push({ pr: number, issue, edited: edit });
	if (dryRun) return;
	const at = new Date().toISOString();
	await logLink({ at, bot, url: pr.url, edit, number, issue, issueItem, from: record.from });
	await patchFixRecord(number, { linked: at, ended: undefined });
}

/** Writes one action doc for the PR's item and one for the issue's. Their timelines show it. */
async function logLink({ at, bot, url, edit, number, issue, issueItem, from }) {
	const dir = join(boardDir(), "actions");
	await mkdir(dir, { recursive: true });
	const pr = prItemId(number);
	// `params.by` keeps the doc from counting as a choice of the maintainer
	const doc = { action: LINK_ACTION, params: { by: "fix", pr: number, issue, from, edited: edit }, text: edit ? `fixes #${issue}` : "", as: bot, status: "done", via: "server", createdAt: at, finishedAt: at, result: url };
	for (const [itemId, other] of [[pr, issueItem], [issueItem, pr]]) await writeAtomic(join(dir, `${itemId}-linked-${other}.json`), { itemId, ...doc });
}
