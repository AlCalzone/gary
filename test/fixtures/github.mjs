// The GitHub state the fake gh answers from: the project acme/widgets, the maintainer octocat and the bot widgets-bot.
export const OWNER = "acme";
export const REPO = "widgets";
export const URL = `https://github.com/${OWNER}/${REPO}`;
export const ME = "octocat";
export const BOT = "widgets-bot";
export const BOT_TOKEN = "fake-bot-token";
export const HEAD = "944d5aca1b70af1d87ca805b08639f3e17b83dcd";

const user = (login) => ({ login, __typename: "User" });
const bot = (login) => ({ login, __typename: "Bot" });
const iso = (h) => new Date(Date.UTC(2026, 10, 17, h)).toISOString();

export const repos = { widgets: "R_widgets", "widgets-desktop": "R_desktop" };
export const labels = { bug: "LA_bug", "help wanted": "LA_help", "needs-info": "LA_info" };
export const users = { octocat: "U_octocat", "widgets-bot": "U_bot", hubot: "U_hubot" };

// Targets for actions: number -> what resolveTarget reads
export const issuesAndPrs = {
	12: { __typename: "PullRequest", id: "PR_12", url: `${URL}/pull/12`, state: "OPEN", isDraft: false, headRefOid: HEAD },
	13: { __typename: "PullRequest", id: "PR_13", url: `${URL}/pull/13`, state: "OPEN", isDraft: true, headRefOid: "b".repeat(40) },
	14: { __typename: "PullRequest", id: "PR_14", url: `${URL}/pull/14`, state: "OPEN", isDraft: false, headRefOid: "c".repeat(40) },
	15: { __typename: "PullRequest", id: "PR_15", url: `${URL}/pull/15`, state: "CLOSED", isDraft: false, headRefOid: "d".repeat(40) },
	16: { __typename: "PullRequest", id: "PR_16", url: `${URL}/pull/16`, state: "MERGED", isDraft: false, headRefOid: "e".repeat(40) },
	20: { __typename: "Issue", id: "I_20", url: `${URL}/issues/20`, state: "CLOSED" },
	21: { __typename: "Issue", id: "I_21", url: `${URL}/issues/21`, state: "OPEN" },
	22: { __typename: "Issue", id: "I_22", url: `${URL}/issues/22`, state: "OPEN" },
};

export const discussions = {
	31: { id: "D_31", url: `${URL}/discussions/31`, closed: false, category: { isAnswerable: true } },
	32: { id: "D_32", url: `${URL}/discussions/32`, closed: false, category: { isAnswerable: false } },
	33: { id: "D_33", url: `${URL}/discussions/33`, closed: false, category: { isAnswerable: true } },
	34: { id: "D_34", url: `${URL}/discussions/34`, closed: true, category: { isAnswerable: true } },
};

// Comment nodes for answer_discussion and react
export const nodes = {
	DC_c1: { __typename: "DiscussionComment", url: `${URL}/discussions/31#c1`, replyTo: null, discussion: { id: "D_31" } },
	DC_c2: { __typename: "DiscussionComment", url: `${URL}/discussions/31#c2`, replyTo: null, discussion: { id: "D_31" } },
	DC_c3: { __typename: "DiscussionComment", url: `${URL}/discussions/32#c3`, replyTo: null, discussion: { id: "D_32" } },
	DC_r1: { __typename: "DiscussionComment", url: `${URL}/discussions/33#r1`, replyTo: { id: "DC_x" }, discussion: { id: "D_33" } },
	IC_1: { __typename: "IssueComment", url: `${URL}/issues/21#ic1`, issue: { id: "I_21" }, pullRequest: null },
	// All replies of a discussion comment whose inline page holds only the last one
	DC_c5: {
		__typename: "DiscussionComment",
		replies: { totalCount: 3, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
			{ author: user("hubot"), createdAt: iso(5), body: "Did not help" },
			{ author: user(ME), createdAt: iso(6), body: "Try the reset pin" },
			{ author: user("hubot"), createdAt: iso(7), body: "That worked, but now the LED blinks" },
		] },
	},
};

// Workflow runs per head SHA
export const runs = {
	["c".repeat(40)]: [
		{ id: 9001, status: "completed", conclusion: "failure" },
		{ id: 9002, status: "completed", conclusion: "success" },
		{ id: 9003, status: "completed", conclusion: "timed_out" },
	],
	[HEAD]: [{ id: 9101, status: "completed", conclusion: "success" }],
};

const thread = (id, path, line, author, { resolved = false, outdated = false } = {}) => ({
	id, isResolved: resolved, isOutdated: outdated, path, line: outdated ? null : line, originalLine: line,
	comments: { nodes: [{ author, createdAt: iso(10), url: `${URL}/pull/12#discussion_${id}`, body: `Comment ${id}` }] },
});

// Full GraphQL nodes for the snapshot and `gary item`
export const prNodes = {
	12: {
		number: 12, title: "Restart the watchdog after a failed restore", url: `${URL}/pull/12`, body: "Fixes #22", createdAt: iso(1), updatedAt: iso(12), isDraft: false,
		author: user("hubot"), authorAssociation: "CONTRIBUTOR",
		labels: { nodes: [{ name: "bug" }] }, assignees: { nodes: [] },
		headRefOid: HEAD, baseRefName: "main", reviewDecision: "APPROVED", mergeable: "MERGEABLE", additions: 20, deletions: 3,
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
		files: { totalCount: 2, nodes: [{ path: "src/restore.ts" }, { path: ".github/workflows/ci.yml" }] },
		comments: { totalCount: 1, nodes: [{ id: "IC_9", author: user(ME), authorAssociation: "OWNER", createdAt: iso(11), body: "Looks good" }] },
		reviews: { nodes: [
			{ author: user(ME), state: "APPROVED", submittedAt: iso(11), url: `${URL}/pull/12#pullrequestreview-1`, body: "" },
			{ author: bot("copilot-pull-request-reviewer"), state: "COMMENTED", submittedAt: iso(12), url: `${URL}/pull/12#pullrequestreview-2`, body: "<!-- x -->\nChanges recommended" },
		] },
		allReviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
			{ author: user(ME), state: "APPROVED", submittedAt: iso(11), url: `${URL}/pull/12#pullrequestreview-1` },
			{ author: bot("copilot-pull-request-reviewer"), state: "COMMENTED", submittedAt: iso(12), url: `${URL}/pull/12#pullrequestreview-2` },
		] },
		reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: ME } }] },
		reviewThreads: { totalCount: 4, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [
			thread("PRRT_1", "src/restore.ts", 40, bot("copilot-pull-request-reviewer")),
			thread("PRRT_2", "src/restore.ts", 48, bot("copilot-pull-request-reviewer")),
			thread("PRRT_3", "src/old.ts", 7, user(ME), { outdated: true }),
			thread("PRRT_4", "src/done.ts", 9, user(ME), { resolved: true }),
		] },
	},
	// A dependency update from Renovate, clean and green
	17: {
		number: 17, title: "chore(deps): update dependency typescript to v6", url: `${URL}/pull/17`, body: "This PR contains the following updates", createdAt: iso(2), updatedAt: iso(3), isDraft: false,
		author: bot("renovate"), authorAssociation: "CONTRIBUTOR",
		labels: { nodes: [{ name: "dependencies" }] }, assignees: { nodes: [{ login: ME }] },
		headRefOid: "f".repeat(40), baseRefName: "main", reviewDecision: null, mergeable: "MERGEABLE", additions: 4, deletions: 4,
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
		files: { totalCount: 2, nodes: [{ path: "package.json" }, { path: "yarn.lock" }] },
		comments: { totalCount: 0, nodes: [] },
		timelineComments: { totalCount: 0, nodes: [] },
		reviews: { nodes: [] },
		allReviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
		reviewRequests: { nodes: [] },
		reviewThreads: { totalCount: 0, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
	},
};

export const issueNodes = {
	22: {
		number: 22, title: "The watchdog stays off after a failed restore", url: `${URL}/issues/22`, body: "Steps…", createdAt: iso(0), updatedAt: iso(9),
		author: user("hubot"), authorAssociation: "NONE", labels: { nodes: [] }, assignees: { nodes: [] },
		comments: { totalCount: 0, nodes: [] },
		closedByPullRequestsReferences: { nodes: [{ number: 12, url: `${URL}/pull/12`, state: "OPEN", isDraft: false }] },
	},
	// We asked, they answered, then the bot posted its log feedback
	23: {
		number: 23, title: "The LED stays red", url: `${URL}/issues/23`, body: "It is red", createdAt: iso(0), updatedAt: iso(4),
		author: user("hubot"), authorAssociation: "NONE", labels: { nodes: [{ name: "bug" }] }, assignees: { nodes: [] },
		comments: { totalCount: 3, nodes: [
			{ id: "IC_31", author: user(ME), authorAssociation: "OWNER", createdAt: iso(1), body: "Please attach a log" },
			{ id: "IC_32", author: user("hubot"), authorAssociation: "NONE", createdAt: iso(2), body: "Here it is" },
			{ id: "IC_33", author: user(BOT), authorAssociation: "NONE", createdAt: iso(3), body: "<!-- LOGFILE_COMMENT_TAG -->\nThanks for the log" },
		] },
		timelineComments: { totalCount: 3, nodes: [
			{ author: user(ME), createdAt: iso(1), body: "Please attach a log" },
			{ author: user("hubot"), createdAt: iso(2), body: "Here it is" },
			{ author: user(BOT), createdAt: iso(3), body: "<!-- LOGFILE_COMMENT_TAG -->\nThanks for the log" },
		] },
		closedByPullRequestsReferences: { nodes: [] },
	},
};

export const discussionNodes = {
	31: {
		number: 31, title: "How do I reset the device?", url: `${URL}/discussions/31`, body: "Question", createdAt: iso(0), updatedAt: iso(8),
		author: user("hubot"), authorAssociation: "NONE", labels: { nodes: [] }, category: { name: "Q&A", isAnswerable: true }, isAnswered: false,
		comments: { totalCount: 1, nodes: [{ id: "DC_c1", author: user(ME), authorAssociation: "OWNER", createdAt: iso(8), body: "Hold the button.", replies: { totalCount: 0, nodes: [] } }] },
	},
	// More replies than the inline page holds: the snapshot fetches the rest through the node query
	35: {
		number: 35, title: "The reset does not work", url: `${URL}/discussions/35`, body: "How?", createdAt: iso(0), updatedAt: iso(7),
		author: user("hubot"), authorAssociation: "NONE", labels: { nodes: [] }, category: { name: "Q&A", isAnswerable: true }, isAnswered: false,
		comments: { totalCount: 1, nodes: [{ id: "DC_c5", author: user(ME), authorAssociation: "OWNER", createdAt: iso(4), body: "Hold the button.", replies: { totalCount: 3, nodes: [{ id: "DC_r7", author: user("hubot"), authorAssociation: "NONE", createdAt: iso(7), body: "That worked, but now the LED blinks" }] } }] },
		timelineComments: { totalCount: 1, nodes: [
			{ id: "DC_c5", author: user(ME), createdAt: iso(4), body: "Hold the button.", replies: { totalCount: 3, nodes: [{ author: user("hubot"), createdAt: iso(7), body: "That worked, but now the LED blinks" }] } },
		] },
	},
};

export const openTotals = { pullRequests: 1, issues: 3, discussions: 2 };
