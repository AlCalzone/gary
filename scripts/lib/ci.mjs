// A PR's `ci` from the latest run of each check, counting only the required checks as failing
import { repoParts } from "./config.mjs";

export const CI_STATES = {
	SUCCESS: "passing",
	FAILURE: "failing",
	ERROR: "failing",
	PENDING: "pending",
	EXPECTED: "pending",
};

const MAX_OPTIONAL_FAILING = 5;
const CONTEXT_PAGE = 100;
const MAX_CONTEXT_PAGES = 10;
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATUSES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATUSES = new Set(["PENDING", "EXPECTED"]);

// `isRequired` needs the PR's number, so the bulk PR queries cannot ask for it
const CHECKS_QUERY = `query PrChecks($owner: String!, $name: String!, $number: Int!, $after: String) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			commits(last: 1) { nodes { commit { statusCheckRollup { state
				contexts(first: ${CONTEXT_PAGE}, after: $after) {
					pageInfo { hasNextPage endCursor }
					nodes {
						__typename
						... on CheckRun { name status conclusion startedAt completedAt isRequired(pullRequestNumber: $number) checkSuite { app { slug } workflowRun { workflow { name } } } }
						... on StatusContext { context state createdAt isRequired(pullRequestNumber: $number) }
					}
				}
			} } } }
		}
	}
}`;

const rollupOf = (node) => node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;

/** A check run or status as `{ key, name, at, state, required }`, or null for another node. */
function toCheck(c) {
	if (c?.__typename === "CheckRun") {
		const suite = c.checkSuite?.workflowRun?.workflow?.name ?? c.checkSuite?.app?.slug ?? "";
		const state = c.status !== "COMPLETED" ? "pending" : FAILED_CONCLUSIONS.has(c.conclusion) ? "failing" : "passing";
		return { key: `run:${suite}/${c.name}`, name: String(c.name ?? ""), at: c.startedAt ?? c.completedAt, state, required: c.isRequired === true };
	}
	if (c?.__typename === "StatusContext") {
		const state = FAILED_STATUSES.has(c.state) ? "failing" : PENDING_STATUSES.has(c.state) ? "pending" : "passing";
		return { key: `status:${c.context}`, name: String(c.context ?? ""), at: c.createdAt, state, required: c.isRequired === true };
	}
	return null;
}

/**
 * The CI state from a PR's rollup contexts: `{ ci, optionalFailing }`, or null without any check.
 * Only the newest run per check counts. Only required checks count, unless none of the PR's checks is required.
 * `optionalFailing` names the failing latest checks that are not required, at most 5.
 */
export function ciFromContexts(contexts) {
	const latest = new Map();
	for (const check of (contexts ?? []).map(toCheck).filter(Boolean)) {
		const prev = latest.get(check.key);
		if (!prev || (Date.parse(check.at) || 0) >= (Date.parse(prev.at) || 0)) latest.set(check.key, check);
	}
	const checks = [...latest.values()];
	if (!checks.length) return null;
	const required = checks.filter((c) => c.required);
	const counted = required.length ? required : checks;
	const ci = counted.some((c) => c.state === "failing") ? "failing" : counted.some((c) => c.state === "pending") ? "pending" : "passing";
	const optional = required.length ? checks.filter((c) => !c.required && c.state === "failing").map((c) => c.name) : [];
	return { ci, optionalFailing: [...new Set(optional)].slice(0, MAX_OPTIONAL_FAILING) };
}

/** Every rollup context of the PR's head, up to 10 pages. */
async function readContexts(repo, number, read) {
	const { owner, name } = repoParts(repo);
	const nodes = [];
	let after = null;
	for (let page = 0; page < MAX_CONTEXT_PAGES; page++) {
		const data = await read(CHECKS_QUERY, { owner, name, number, after });
		const contexts = data.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
		nodes.push(...(contexts?.nodes ?? []));
		if (!contexts?.pageInfo?.hasNextPage) break;
		after = contexts.pageInfo.endCursor;
	}
	return nodes;
}

/**
 * Reads the checks of each PR node whose rollup is FAILURE or ERROR and stores the result as `node.ciChecks`.
 * `repoOf(node)` names the node's repo. `read(query, variables)` runs one GraphQL read.
 * A failed read only warns, and the node keeps the rollup's state.
 */
export async function attachChecks(nodes, { repoOf, read }) {
	await Promise.all(nodes.filter((n) => ["FAILURE", "ERROR"].includes(rollupOf(n))).map(async (node) => {
		try {
			const checks = ciFromContexts(await readContexts(repoOf(node), node.number, read));
			if (checks) node.ciChecks = checks;
		} catch (e) {
			console.error(`gary snapshot: could not read the checks of PR #${node.number}: ${e.message}`);
		}
	}));
}

/** The `ci` of a PR node: from `attachChecks` when it read the checks, otherwise from the rollup. */
export const ciOf = (node) => node?.ciChecks?.ci ?? CI_STATES[rollupOf(node)] ?? "none";

/** The entry fields for a PR node's failing optional checks: `{ ciOptionalFailing }`, or nothing without any. */
export const optionalFailingOf = (node) => (node?.ciChecks?.optionalFailing?.length ? { ciOptionalFailing: node.ciChecks.optionalFailing } : {});
