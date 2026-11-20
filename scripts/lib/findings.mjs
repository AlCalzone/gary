import { createHash } from "node:crypto";

// The agent's own id of a finding, like "f1"
export const FINDING_ID = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The stable key of a finding: its `id`, or for a finding without one its index plus a hash of its text.
 * A key with the index and hash changes when the agent rewrites the finding.
 */
export function findingKey(finding, index) {
	if (typeof finding?.id === "string" && FINDING_ID.test(finding.id)) return finding.id;
	const text = typeof finding?.text === "string" ? finding.text : "";
	return `#${index}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
}

/** The item's findings by key. */
export function findingsByKey(item) {
	const list = Array.isArray(item?.findings) ? item.findings : [];
	return new Map(list.map((f, i) => [findingKey(f, i), f]).filter(([, f]) => f && typeof f === "object"));
}
