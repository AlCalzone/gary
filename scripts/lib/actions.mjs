import { allowedRepo, instanceName, loadConfig, loadProfile, repoParts, withInstance } from "./config.mjs";
import { PAUSED_MESSAGE, isPaused } from "./control.mjs";
import { GRAPHQL_ARGS, accountMode, assertWriteAllowed, gh, graphql, requestCopilotReview, verifyOwnLogin, writeLogin } from "./gh.mjs";

export const KINDS = ["pr", "issue", "discussion"];
const BOARD_ACTIONS = ["dismiss", "snooze"];
export const AGENT_ACTIONS = ["full_review", "reanalyze", "start_fix", "address_review", "take_over", "revise", "drive", "format"];
const MERGE_METHODS = { squash: "SQUASH", merge: "MERGE", rebase: "REBASE" };
const ISSUE_CLOSE_REASONS = { completed: "COMPLETED", not_planned: "NOT_PLANNED", duplicate: "DUPLICATE" };
const DISCUSSION_CLOSE_REASONS = { completed: "RESOLVED", not_planned: "OUTDATED", duplicate: "DUPLICATE" };
export const REVIEW_EVENTS = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" };
const MAX_REVIEW_COMMENTS = 50;
const MAX_TITLE_LENGTH = 256;
const REPO_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const FAILED_CONCLUSIONS = ["failure", "cancelled", "timed_out", "startup_failure"];
const MAX_BODY_LENGTH = 65536;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
export const REACTIONS = ["THUMBS_UP", "HEART", "HOORAY", "ROCKET", "EYES"];

/** GitHub actions, keyed by name. `params` lists the allowed parameter names. */
export const ACTIONS = {
	comment: {
		description: "Post `text` as a comment on the PR, issue or discussion.",
		kinds: KINDS,
		params: [],
		run: async (ctx) => {
			const body = requireText(ctx);
			return postComment(ctx, body);
		},
	},
	review: {
		description:
			"Submit one PR review with `text` as the body. `params.event` is approve, request_changes or comment. `params.comments` holds inline comments as `[{ path, line, startLine, text }]` on the right side of the diff, `startLine` only for a range. Optional `params.sha` pins the review to that commit.",
		kinds: ["pr"],
		params: ["event", "comments", "sha"],
		run: async (ctx) => {
			const { event } = ctx.params;
			if (!Object.hasOwn(REVIEW_EVENTS, event ?? "")) {
				throw new Error(`params.event must be one of ${Object.keys(REVIEW_EVENTS).join(", ")}`);
			}
			const comments = reviewComments(ctx.params.comments);
			const sha = optionalSha(ctx.params.sha);
			const body = optionalText(ctx);
			// GitHub rejects a change request or comment review that has neither a body nor inline comments
			if (event !== "approve" && !body && !comments.length) {
				throw new Error(`A ${event} review needs a text or inline comments`);
			}
			const target = await resolveTarget(ctx);
			requireOpen(target);
			const data = await mutate(
				ctx,
				`mutation($id: ID!, $event: PullRequestReviewEvent!, $body: String, $sha: GitObjectID, $threads: [DraftPullRequestReviewThread]) {
					addPullRequestReview(input: { pullRequestId: $id, event: $event, body: $body, commitOID: $sha, threads: $threads }) {
						pullRequestReview { url }
					}
				}`,
				{
					id: target.id,
					event: REVIEW_EVENTS[event],
					body: body ?? null,
					sha: sha ?? null,
					threads: comments.length
						? comments.map((c) => ({
								path: c.path,
								line: c.line,
								side: "RIGHT",
								...(c.startLine !== undefined && { startLine: c.startLine, startSide: "RIGHT" }),
								body: c.text,
							}))
						: null,
				},
			);
			return data?.addPullRequestReview.pullRequestReview.url;
		},
	},
	merge: {
		description:
			"Merge the PR. `params.method` is squash (default), merge or rebase. Optional `params.sha` makes the merge fail when the PR head moved.",
		kinds: ["pr"],
		params: ["method", "sha"],
		run: async (ctx) => {
			const method = ctx.params.method ?? "squash";
			if (!Object.hasOwn(MERGE_METHODS, method)) {
				throw new Error(`params.method must be one of ${Object.keys(MERGE_METHODS).join(", ")}`);
			}
			const sha = optionalSha(ctx.params.sha);
			forbidText(ctx);
			const target = await resolveTarget(ctx);
			requireOpen(target);
			if (target.isDraft) throw new Error(`PR #${ctx.number} is a draft`);
			const data = await mutate(
				ctx,
				`mutation($id: ID!, $method: PullRequestMergeMethod!, $sha: GitObjectID) {
					mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $sha }) {
						pullRequest { url mergeCommit { oid } }
					}
				}`,
				{ id: target.id, method: MERGE_METHODS[method], sha: sha ?? null },
			);
			return data?.mergePullRequest.pullRequest.url;
		},
	},
	ready: {
		description: "Mark the draft PR as ready for review.",
		kinds: ["pr"],
		params: [],
		run: async (ctx) => {
			forbidText(ctx);
			const target = await resolveTarget(ctx);
			requireOpen(target);
			if (!target.isDraft) throw new Error(`PR #${ctx.number} is not a draft`);
			const data = await mutate(
				ctx,
				`mutation($id: ID!) {
					markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { url } }
				}`,
				{ id: target.id },
			);
			return data?.markPullRequestReadyForReview.pullRequest.url;
		},
	},
	close: {
		description:
			"Close the item. Optional `text` is posted as a comment first. `params.reason` is completed (default), not_planned or duplicate and is ignored for PRs. `params.duplicateOf` names the original issue, required for an issue closed as duplicate.",
		kinds: KINDS,
		params: ["reason", "duplicateOf"],
		run: async (ctx) => {
			const reason = ctx.params.reason ?? "completed";
			if (!Object.hasOwn(ISSUE_CLOSE_REASONS, reason)) {
				throw new Error(`params.reason must be one of ${Object.keys(ISSUE_CLOSE_REASONS).join(", ")}`);
			}
			const { duplicateOf } = ctx.params;
			if (duplicateOf !== undefined) {
				if (reason !== "duplicate") throw new Error("params.duplicateOf needs reason duplicate");
				if (!Number.isSafeInteger(duplicateOf) || duplicateOf <= 0 || duplicateOf === ctx.number) {
					throw new Error("params.duplicateOf must be the number of another item");
				}
			}
			if (ctx.kind === "issue" && reason === "duplicate" && duplicateOf === undefined) {
				throw new Error("Closing an issue as duplicate needs params.duplicateOf");
			}
			const text = optionalText(ctx);
			const target = await resolveTarget(ctx);
			requireOpen(target);
			let original;
			if (ctx.kind === "issue" && duplicateOf !== undefined) {
				original = await resolveTarget({ ...ctx, number: duplicateOf });
			}
			if (text) await postComment(ctx, text, target);

			let data;
			if (ctx.kind === "pr") {
				data = await mutate(
					ctx,
					`mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { pullRequest { url } } }`,
					{ id: target.id },
				);
				return data?.closePullRequest.pullRequest.url;
			} else if (ctx.kind === "issue") {
				data = await mutate(
					ctx,
					`mutation($id: ID!, $reason: IssueClosedStateReason, $duplicate: ID) {
						closeIssue(input: { issueId: $id, stateReason: $reason, duplicateIssueId: $duplicate }) { issue { url } }
					}`,
					{ id: target.id, reason: ISSUE_CLOSE_REASONS[reason], duplicate: original?.id ?? null },
				);
				return data?.closeIssue.issue.url;
			} else {
				// closeDiscussion has no field for the original discussion, so duplicateOf stays unused here
				data = await mutate(
					ctx,
					`mutation($id: ID!, $reason: DiscussionCloseReason) {
						closeDiscussion(input: { discussionId: $id, reason: $reason }) { discussion { url } }
					}`,
					{ id: target.id, reason: DISCUSSION_CLOSE_REASONS[reason] },
				);
				return data?.closeDiscussion.discussion.url;
			}
		},
	},
	reopen: {
		description: "Reopen the closed PR, issue or discussion. Optional `text` is posted as a comment first.",
		kinds: KINDS,
		params: [],
		run: async (ctx) => {
			const text = optionalText(ctx);
			const target = await resolveTarget(ctx);
			if (target.state === "MERGED") throw new Error(`${target.url} is merged and cannot be reopened`);
			if (target.state !== "CLOSED") throw new Error(`${target.url} is not closed`);
			if (text) await postComment(ctx, text, target);
			const mutation = {
				pr: ["reopenPullRequest", "pullRequestId", "pullRequest"],
				issue: ["reopenIssue", "issueId", "issue"],
				discussion: ["reopenDiscussion", "discussionId", "discussion"],
			}[ctx.kind];
			const [field, input, result] = mutation;
			const data = await mutate(
				ctx,
				`mutation($id: ID!) { ${field}(input: { ${input}: $id }) { ${result} { url } } }`,
				{ id: target.id },
			);
			return data?.[field][result].url;
		},
	},
	request_review: {
		description:
			"Request a review on the PR. With `params.reviewer: \"copilot\"` it requests a Copilot review under your own gh login, or as the bot with `params.as: \"bot\"`, and copilot must be listed in the profile's reviewBots. With `params.reviewer: \"maintainer\"` the writing identity requests your review, added to the reviewers already requested. It sends nothing when you wrote the PR, when the PR is closed, merged or a draft, or when your review is already requested.",
		kinds: ["pr"],
		params: ["reviewer", "as"],
		run: async (ctx) => {
			if (ctx.params.reviewer === "maintainer") return requestMaintainerReview(ctx);
			if (ctx.params.reviewer !== "copilot") throw new Error("params.reviewer must be copilot or maintainer");
			if (!loadProfile().reviewBots.includes("copilot")) throw new Error("The profile does not list copilot in reviewBots");
			forbidText(ctx);
			const target = await resolveTarget(ctx);
			requireOpen(target);
			// requestCopilotCodeReview also starts a new request after a finished Copilot review, per its schema description
			const outcome = await requestCopilotReview(target.id, { dryRun: ctx.dryRun, as: ctx.params.as ?? "me" });
			if (ctx.dryRun) {
				ctx.invocations.push(outcome.invocation);
				return target.url;
			}
			if (!outcome.success) {
				throw new Error(`GitHub did not request the Copilot review: ${outcome.failureReason ?? "no reason given"}`);
			}
			return target.url;
		},
	},
	create_issue: {
		description:
			"Open a new issue with `params.title` and `text` as the body. `kind` and `number` name the item it follows up on. Returns the new issue's URL.",
		kinds: KINDS,
		params: ["title"],
		run: async (ctx) => {
			const { title } = ctx.params;
			if (typeof title !== "string" || !title.trim() || title.length > MAX_TITLE_LENGTH) {
				throw new Error(`params.title must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters`);
			}
			await resolveTarget(ctx);
			const repositoryId = await resolveRepositoryId(ctx, repoParts(ctx.repo).name);
			const data = await mutate(
				ctx,
				`mutation($repo: ID!, $title: String!, $body: String) {
					createIssue(input: { repositoryId: $repo, title: $title, body: $body }) { issue { url number } }
				}`,
				{ repo: repositoryId, title: title.trim(), body: optionalText(ctx) ?? null },
			);
			return data?.createIssue.issue.url;
		},
	},
	transfer: {
		description: "Transfer the issue to `params.repo`, a repository of the same owner listed in the profile's relatedRepos.",
		kinds: ["issue"],
		params: ["repo"],
		run: async (ctx) => {
			const { repo } = ctx.params;
			if (typeof repo !== "string" || !REPO_NAME_PATTERN.test(repo)) {
				throw new Error("params.repo must be a repository name of the same owner");
			}
			if (repo.toLowerCase() === repoParts(ctx.repo).name.toLowerCase()) {
				throw new Error("params.repo must be a different repository");
			}
			const related = loadProfile().relatedRepos;
			if (!related.some((r) => r.toLowerCase() === repo.toLowerCase())) {
				throw new Error(`params.repo must be one of the profile's relatedRepos: ${related.join(", ") || "none listed"}`);
			}
			forbidText(ctx);
			const target = await resolveTarget(ctx);
			requireOpen(target);
			const repositoryId = await resolveRepositoryId(ctx, repo);
			const data = await mutate(
				ctx,
				`mutation($id: ID!, $repo: ID!) {
					transferIssue(input: { issueId: $id, repositoryId: $repo }) { issue { url } }
				}`,
				{ id: target.id, repo: repositoryId },
			);
			return data?.transferIssue.issue.url;
		},
	},
	update_branch: {
		description: "Merge the base branch into the PR branch. Optional `params.sha` makes it fail when the PR head moved.",
		kinds: ["pr"],
		params: ["sha"],
		run: async (ctx) => {
			const sha = optionalSha(ctx.params.sha);
			forbidText(ctx);
			const target = await resolveTarget(ctx);
			requireOpen(target);
			const data = await mutate(
				ctx,
				`mutation($id: ID!, $sha: GitObjectID) {
					updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $sha, updateMethod: MERGE }) {
						pullRequest { url }
					}
				}`,
				{ id: target.id, sha: sha ?? null },
			);
			return data?.updatePullRequestBranch.pullRequest.url;
		},
	},
	rerun_ci: {
		description: "Restart the failed GitHub Actions jobs of the PR head.",
		kinds: ["pr"],
		params: [],
		run: async (ctx) => {
			forbidText(ctx);
			const target = await resolveTarget(ctx);
			requireOpen(target);
			const { owner, name } = repoParts(ctx.repo);
			const runs = await restGet(
				`repos/${owner}/${name}/actions/runs?head_sha=${target.headRefOid}&per_page=100`,
			);
			const failed = (runs.workflow_runs ?? []).filter(
				(r) => r.status === "completed" && FAILED_CONCLUSIONS.includes(r.conclusion),
			);
			if (!failed.length) throw new Error(`No failed workflow runs on the head of PR #${ctx.number}`);
			for (const run of failed) {
				await restPost(ctx, `repos/${owner}/${name}/actions/runs/${run.id}/rerun-failed-jobs`);
			}
			return `${target.url}/checks`;
		},
	},
	label: {
		description: "Add the labels in `params.add` and remove the labels in `params.remove`.",
		kinds: KINDS,
		params: ["add", "remove"],
		run: async (ctx) => {
			const add = stringList(ctx.params.add, "params.add", 20);
			const remove = stringList(ctx.params.remove, "params.remove", 20);
			if (!add.length && !remove.length) {
				throw new Error("params.add or params.remove must contain at least one label");
			}
			if (add.some((l) => remove.includes(l))) {
				throw new Error("A label cannot be in both params.add and params.remove");
			}
			forbidText(ctx);
			const target = await resolveTarget(ctx);
			const ids = await resolveLabels(ctx, [...add, ...remove]);
			if (add.length) {
				await mutate(
					ctx,
					`mutation($id: ID!, $labels: [ID!]!) {
						addLabelsToLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId }
					}`,
					{ id: target.id, labels: add.map((l) => ids.get(l)) },
				);
			}
			if (remove.length) {
				await mutate(
					ctx,
					`mutation($id: ID!, $labels: [ID!]!) {
						removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId }
					}`,
					{ id: target.id, labels: remove.map((l) => ids.get(l)) },
				);
			}
			return target.url;
		},
	},
	assign: {
		description: "Assign the users in `params.assignees` to the PR or issue.",
		kinds: ["pr", "issue"],
		params: ["assignees"],
		run: async (ctx) => {
			const assignees = stringList(ctx.params.assignees, "params.assignees", 10);
			if (!assignees.length) throw new Error("params.assignees must contain at least one login");
			for (const login of assignees) {
				if (!LOGIN_PATTERN.test(login)) throw new Error(`Invalid GitHub login "${login}"`);
			}
			forbidText(ctx);
			const target = await resolveTarget(ctx);
			const ids = await resolveUsers(assignees);
			await mutate(
				ctx,
				`mutation($id: ID!, $users: [ID!]!) {
					addAssigneesToAssignable(input: { assignableId: $id, assigneeIds: $users }) { clientMutationId }
				}`,
				{ id: target.id, users: assignees.map((a) => ids.get(a)) },
			);
			return target.url;
		},
	},
	react: {
		description:
			"Add a reaction. `params.content` is THUMBS_UP (default), HEART, HOORAY, ROCKET or EYES. With `params.commentId` the reaction goes on that comment, otherwise on the PR, issue or discussion.",
		kinds: KINDS,
		params: ["content", "commentId"],
		run: async (ctx) => {
			const content = ctx.params.content ?? "THUMBS_UP";
			if (!REACTIONS.includes(content)) {
				throw new Error(`params.content must be one of ${REACTIONS.join(", ")}`);
			}
			const { commentId } = ctx.params;
			if (commentId !== undefined && (typeof commentId !== "string" || !NODE_ID_PATTERN.test(commentId))) {
				throw new Error("params.commentId must be a comment node id");
			}
			forbidText(ctx);
			const target = await resolveTarget(ctx);
			let subject = { id: target.id, url: target.url };
			if (commentId) {
				const node = await commentNode(commentId);
				if (!node || !node.parents.includes(target.id)) {
					throw new Error(`Comment ${commentId} does not belong to #${ctx.number}`);
				}
				subject = { id: commentId, url: node.url };
			}
			await mutate(
				ctx,
				`mutation($id: ID!, $content: ReactionContent!) {
					addReaction(input: { subjectId: $id, content: $content }) { reaction { content } }
				}`,
				{ id: subject.id, content },
			);
			return subject.url;
		},
	},
	answer_discussion: {
		description: "Mark the discussion comment with node id `params.commentId` as the answer.",
		kinds: ["discussion"],
		params: ["commentId"],
		run: async (ctx) => {
			const { commentId } = ctx.params;
			if (typeof commentId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(commentId)) {
				throw new Error("params.commentId must be a discussion comment node id");
			}
			forbidText(ctx);
			const target = await resolveTarget(ctx);
			if (!target.isAnswerable) {
				throw new Error(`Discussion #${ctx.number} is in a category without answers`);
			}
			const { node } = await graphql(
				`query($id: ID!) {
					node(id: $id) {
						... on DiscussionComment { url replyTo { id } discussion { id } }
					}
				}`,
				{ id: commentId },
			);
			if (!node?.discussion || node.discussion.id !== target.id) {
				throw new Error(`Comment ${commentId} does not belong to discussion #${ctx.number}`);
			}
			if (node.replyTo) throw new Error("Only top-level comments can be marked as the answer");
			await mutate(
				ctx,
				`mutation($id: ID!) { markDiscussionCommentAsAnswer(input: { id: $id }) { clientMutationId } }`,
				{ id: commentId },
			);
			return node.url;
		},
	},
};

/**
 * Validates and runs one GitHub action as the bot. Never throws.
 * `instance` scopes everything to that instance. `repo` is the item's repo and must be allowed for the instance.
 * With `dryRun`, read-only lookups still run and every write is returned in `result.invocations` instead.
 * With `autonomous`, the action counts as one nobody clicked, and only label and assign within the profile's rules may run.
 * `markedReady` tells that the caller marked the PR ready in the same dry run, so a draft counts as ready.
 * An action that sends nothing by its own rules returns `skipped` with the reason.
 */
export async function runAction({ instance, repo, ...request } = {}) {
	if (instance) return withInstance(instance, () => runAction({ repo, ...request }));
	const { action, kind, number, params, text, dryRun = false, autonomous = false, markedReady = false } = request;
	try {
		if (isPaused()) return { ok: false, result: PAUSED_MESSAGE, paused: true };
		const ctx = validate({ action, kind, number, params, text });
		// The repo comes from the item. Without one the instance's own repo applies
		ctx.repo = repo ?? loadProfile().repo;
		if (!allowedRepo(instanceName(), ctx.repo)) throw new Error(`${ctx.repo} is not a repository of instance ${instanceName()}`);
		forbidBotCommands(ctx);
		if (autonomous) checkAutonomous(ctx);
		ctx.dryRun = !!dryRun;
		ctx.markedReady = ctx.dryRun && markedReady === true;
		ctx.invocations = [];
		const result = await ACTIONS[action].run(ctx);
		if (ctx.skipped) return { ok: true, skipped: ctx.skipped, result: ctx.dryRun ? { dryRun: true, invocations: [] } : ctx.skipped };
		if (ctx.dryRun) return { ok: true, result: { dryRun: true, invocations: ctx.invocations } };
		return { ok: true, result: result ?? "" };
	} catch (e) {
		return { ok: false, result: e?.message ?? String(e) };
	}
}

function validate({ action, kind, number, params, text }) {
	if (typeof action !== "string") throw new Error("action must be a string");
	if (BOARD_ACTIONS.includes(action)) {
		throw new Error(`"${action}" is a board-only action and makes no GitHub call`);
	}
	if (AGENT_ACTIONS.includes(action)) {
		throw new Error(`"${action}" is an agent request for the master session and makes no GitHub call`);
	}
	if (!Object.hasOwn(ACTIONS, action)) throw new Error(`Unknown action "${action}"`);
	const def = ACTIONS[action];

	if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
	if (!def.kinds.includes(kind)) {
		throw new Error(`Action "${action}" is not available for kind "${kind}"`);
	}
	if (!Number.isSafeInteger(number) || number <= 0) {
		throw new Error("number must be a positive integer");
	}

	params ??= {};
	if (typeof params !== "object" || Array.isArray(params)) {
		throw new Error("params must be an object");
	}
	for (const key of Object.keys(params)) {
		if (!def.params.includes(key)) {
			throw new Error(`Unknown parameter "${key}" for action "${action}"`);
		}
	}

	text ??= "";
	if (typeof text !== "string") throw new Error("text must be a string");
	if (text.length > MAX_BODY_LENGTH) {
		throw new Error(`text is longer than ${MAX_BODY_LENGTH} characters`);
	}

	return { action, kind, number, params, text };
}

const AUTONOMOUS_ACTIONS = ["label", "assign"];

/**
 * Limits an action nobody clicked to what the routine may do on its own: labels from the profile's autoLabels,
 * and assignments.
 */
function checkAutonomous(ctx) {
	if (!AUTONOMOUS_ACTIONS.includes(ctx.action)) {
		throw new Error(`"${ctx.action}" needs a click on the board. Without one only ${AUTONOMOUS_ACTIONS.join(" and ")} may run`);
	}
	if (ctx.action !== "label") return;
	const allowed = loadProfile().autoLabels.map((l) => l.toLowerCase());
	const labels = [...(Array.isArray(ctx.params.add) ? ctx.params.add : []), ...(Array.isArray(ctx.params.remove) ? ctx.params.remove : [])];
	const outside = labels.filter((l) => typeof l === "string" && !allowed.includes(l.toLowerCase()));
	if (outside.length) {
		throw new Error(`Label ${outside.map((l) => `"${l}"`).join(", ")} is not in the profile's autoLabels, so it needs a click on the board`);
	}
}

/** Rejects text that contains a bot command from the profile. Only the maintainer posts those, on GitHub. */
function forbidBotCommands(ctx) {
	const commands = Object.values(loadProfile().botCommands).map((c) => c.trim().toLowerCase()).filter(Boolean);
	if (!commands.length) return;
	const comments = Array.isArray(ctx.params.comments) ? ctx.params.comments : [];
	const texts = [ctx.text, ctx.params.title, ...comments.map((c) => c?.text)].filter((t) => typeof t === "string");
	for (const text of texts) {
		const hit = commands.find((c) => text.toLowerCase().includes(c));
		if (hit) throw new Error(`The text contains the bot command "${hit}". Post bot commands on GitHub yourself.`);
	}
}

function requireText(ctx) {
	const text = ctx.text.trim();
	if (!text) throw new Error(`Action "${ctx.action}" requires a non-empty text`);
	return ctx.text;
}

function optionalText(ctx) {
	return ctx.text.trim() ? ctx.text : undefined;
}

function forbidText(ctx) {
	if (ctx.text.trim()) throw new Error(`Action "${ctx.action}" does not post text`);
}

function stringList(value, name, max) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	if (value.length > max) throw new Error(`${name} has more than ${max} entries`);
	for (const v of value) {
		if (typeof v !== "string" || !v.trim() || v.length > 100) {
			throw new Error(`${name} entries must be non-empty strings`);
		}
	}
	return [...new Set(value)];
}

function optionalSha(sha) {
	if (sha !== undefined && (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))) {
		throw new Error("params.sha must be a full 40-character commit SHA");
	}
	return sha;
}

function reviewComments(value) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("params.comments must be an array");
	if (value.length > MAX_REVIEW_COMMENTS) {
		throw new Error(`params.comments has more than ${MAX_REVIEW_COMMENTS} entries`);
	}
	return value.map((c, i) => {
		const where = `params.comments[${i}]`;
		if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`${where} must be an object`);
		for (const key of Object.keys(c)) {
			if (!["path", "line", "startLine", "text"].includes(key)) throw new Error(`${where} has unknown field "${key}"`);
		}
		if (typeof c.path !== "string" || !c.path || c.path.length > 500 || c.path.startsWith("/")) {
			throw new Error(`${where}.path must be a repository-relative file path`);
		}
		if (!Number.isSafeInteger(c.line) || c.line <= 0) throw new Error(`${where}.line must be a positive integer`);
		if (c.startLine !== undefined && (!Number.isSafeInteger(c.startLine) || c.startLine <= 0 || c.startLine >= c.line)) {
			throw new Error(`${where}.startLine must be a positive integer below line`);
		}
		if (typeof c.text !== "string" || !c.text.trim() || c.text.length > MAX_BODY_LENGTH) {
			throw new Error(`${where}.text must be a non-empty string`);
		}
		return c;
	});
}

const sameLogin = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * Requests the maintainer's review as the writing identity, with `union: true` so other requested reviewers stay.
 * It sets `ctx.skipped` and sends nothing when he wrote the PR, when the writing identity is his own login, when the
 * PR is not open or is a draft, and when his review is already requested.
 */
async function requestMaintainerReview(ctx) {
	if (ctx.params.as !== undefined) throw new Error("params.as is only for a Copilot review. The writing identity requests the maintainer's review");
	forbidText(ctx);
	assertWriteAllowed();
	const { me } = loadConfig();
	const { owner, name } = repoParts(ctx.repo);
	let data;
	try {
		data = await graphql(
			`query($owner: String!, $name: String!, $number: Int!, $me: String!) {
				repository(owner: $owner, name: $name) {
					pullRequest(number: $number) {
						id url state isDraft author { login }
						reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } } } }
					}
				}
				user(login: $me) { id }
			}`,
			{ owner, name, number: ctx.number, me },
		);
	} catch (e) {
		if (/Could not resolve to a PullRequest/i.test(e.message)) throw new Error(`PR #${ctx.number} not found`);
		throw e;
	}
	const pr = data?.repository?.pullRequest;
	if (!pr) throw new Error(`PR #${ctx.number} not found`);
	if (!data.user?.id) throw new Error(`User ${me} from config.json not found on GitHub`);
	if (sameLogin(pr.author?.login, me)) ctx.skipped = `You wrote PR #${ctx.number}, so your review is not requested.`;
	else if (sameLogin(writeLogin(), me)) ctx.skipped = "Writes run under your own login, so your review is not requested.";
	else if (pr.state !== "OPEN") ctx.skipped = `PR #${ctx.number} is ${pr.state.toLowerCase()}, so your review is not requested.`;
	else if (pr.isDraft && !ctx.markedReady) ctx.skipped = `PR #${ctx.number} is a draft, so your review is not requested.`;
	else if ((pr.reviewRequests?.nodes ?? []).some((n) => sameLogin(n?.requestedReviewer?.login, me))) ctx.skipped = `Your review is already requested on PR #${ctx.number}.`;
	if (ctx.skipped) return pr.url;
	const result = await mutate(
		ctx,
		`mutation($id: ID!, $users: [ID!]) {
			requestReviews(input: { pullRequestId: $id, userIds: $users, union: true }) { pullRequest { url } }
		}`,
		{ id: pr.id, users: [data.user.id] },
	);
	return result?.requestReviews.pullRequest.url ?? pr.url;
}

function requireOpen(target) {
	if (target.state !== "OPEN") throw new Error(`${target.url} is not open`);
}

/** Applies the account rules of a real write in dry-run mode too, including the read-only login check. */
async function checkDryRunWrite(ctx) {
	assertWriteAllowed();
	if (accountMode() === "own" && !ctx.ownLoginChecked) {
		await verifyOwnLogin();
		ctx.ownLoginChecked = true;
	}
}

/** Runs a write, or records it for the dry-run output. Returns `undefined` in dry-run mode. */
async function mutate(ctx, query, variables) {
	if (ctx.dryRun) {
		await checkDryRunWrite(ctx);
		ctx.invocations.push({
			command: ["gh", ...GRAPHQL_ARGS],
			as: writeLogin(),
			stdin: { query: query.replace(/\s+/g, " ").trim(), variables },
		});
		return undefined;
	}
	return graphql(query, variables);
}

async function restGet(path) {
	const stdout = await gh(["api", path]).catch((e) => {
		throw new Error(e.stderr?.trim() || e.message);
	});
	return JSON.parse(stdout);
}

/** Sends a REST POST without a body, or records it for the dry-run output. */
async function restPost(ctx, path) {
	const args = ["api", "-X", "POST", path];
	if (ctx.dryRun) {
		await checkDryRunWrite(ctx);
		ctx.invocations.push({ command: ["gh", ...args], as: writeLogin() });
		return undefined;
	}
	await gh(args).catch((e) => {
		throw new Error(e.stderr?.trim() || e.message);
	});
}

async function resolveRepositoryId(ctx, repo) {
	const { owner } = repoParts(ctx.repo);
	let data;
	try {
		data = await graphql(
			`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
			{ owner, name: repo },
		);
	} catch (e) {
		if (/Could not resolve/i.test(e.message)) throw new Error(`Repository ${owner}/${repo} not found`);
		throw e;
	}
	if (!data?.repository) throw new Error(`Repository ${owner}/${repo} not found`);
	return data.repository.id;
}

/** Looks up the node id and state, and checks that `number` really is of the given kind. */
async function resolveTarget(ctx) {
	const { owner, name } = repoParts(ctx.repo);
	if (ctx.kind === "discussion") {
		const { repository } = await graphql(
			`query($owner: String!, $name: String!, $number: Int!) {
				repository(owner: $owner, name: $name) {
					discussion(number: $number) { id url closed category { isAnswerable } }
				}
			}`,
			{ owner, name, number: ctx.number },
		);
		const d = repository?.discussion;
		if (!d) throw new Error(`Discussion #${ctx.number} not found`);
		return {
			id: d.id,
			url: d.url,
			state: d.closed ? "CLOSED" : "OPEN",
			isAnswerable: d.category?.isAnswerable ?? false,
		};
	}

	let repository;
	try {
		({ repository } = await graphql(
			`query($owner: String!, $name: String!, $number: Int!) {
				repository(owner: $owner, name: $name) {
					issueOrPullRequest(number: $number) {
						__typename
						... on Issue { id url state }
						... on PullRequest { id url state isDraft headRefOid }
					}
				}
			}`,
			{ owner, name, number: ctx.number },
		));
	} catch (e) {
		if (/Could not resolve/i.test(e.message)) throw new Error(`#${ctx.number} not found`);
		throw e;
	}
	const item = repository?.issueOrPullRequest;
	if (!item) throw new Error(`#${ctx.number} not found`);
	const expected = ctx.kind === "pr" ? "PullRequest" : "Issue";
	if (item.__typename !== expected) {
		throw new Error(`#${ctx.number} is ${expected === "Issue" ? "a pull request" : "an issue"}`);
	}
	return item;
}

async function postComment(ctx, body, target) {
	target ??= await resolveTarget(ctx);
	if (ctx.kind === "discussion") {
		const data = await mutate(
			ctx,
			`mutation($id: ID!, $body: String!) {
				addDiscussionComment(input: { discussionId: $id, body: $body }) { comment { url } }
			}`,
			{ id: target.id, body },
		);
		return data?.addDiscussionComment.comment.url;
	}
	const data = await mutate(
		ctx,
		`mutation($id: ID!, $body: String!) {
			addComment(input: { subjectId: $id, body: $body }) { commentEdge { node { url } } }
		}`,
		{ id: target.id, body },
	);
	return data?.addComment.commentEdge.node.url;
}

/** Looks up a comment by node id. Returns its url and the node ids of the threads it belongs to, or null. */
export async function commentNode(commentId) {
	let data;
	try {
		data = await graphql(
			`query($id: ID!) {
				node(id: $id) {
					... on IssueComment { url issue { id } pullRequest { id } }
					... on DiscussionComment { url discussion { id } }
					... on PullRequestReviewComment { url pullRequest { id } }
				}
			}`,
			{ id: commentId },
		);
	} catch (e) {
		if (/Could not resolve/i.test(e.message)) return null;
		throw e;
	}
	const node = data?.node;
	if (!node?.url) return null;
	return { url: node.url, parents: [node.issue?.id, node.pullRequest?.id, node.discussion?.id].filter(Boolean) };
}

/** Resolves label names to node ids. Rejects unknown labels so a typo never creates a new label. */
async function resolveLabels(ctx, names) {
	const { owner, name } = repoParts(ctx.repo);
	const fields = names.map((_, i) => `l${i}: label(name: $n${i}) { id name }`).join("\n");
	const decls = names.map((_, i) => `$n${i}: String!`).join(", ");
	const variables = { owner, name };
	names.forEach((n, i) => (variables[`n${i}`] = n));
	const { repository } = await graphql(
		`query($owner: String!, $name: String!, ${decls}) {
			repository(owner: $owner, name: $name) { ${fields} }
		}`,
		variables,
	);
	const ids = new Map();
	names.forEach((n, i) => {
		const label = repository[`l${i}`];
		if (!label) throw new Error(`Label "${n}" does not exist in the repository`);
		ids.set(n, label.id);
	});
	return ids;
}

async function resolveUsers(logins) {
	const fields = logins.map((_, i) => `u${i}: user(login: $l${i}) { id }`).join("\n");
	const decls = logins.map((_, i) => `$l${i}: String!`).join(", ");
	const variables = {};
	logins.forEach((l, i) => (variables[`l${i}`] = l));
	let data;
	try {
		data = await graphql(`query(${decls}) { ${fields} }`, variables);
	} catch (e) {
		throw new Error(`Could not resolve assignees: ${e.message}`);
	}
	const ids = new Map();
	logins.forEach((l, i) => {
		const user = data[`u${i}`];
		if (!user) throw new Error(`User "${l}" not found`);
		ids.set(l, user.id);
	});
	return ids;
}
