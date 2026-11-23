// The board's categories: the kind of move the maintainer makes on an item.
// Items written before categories carry `section`. normalizeCategory maps it, so those items stay on the board until the routine writes them again.

export const CATEGORIES = ["act", "unblock", "land", "decide"];
// A contributions instance adds `fyi`: news for him on a thread he follows, and nothing to do
export const FYI = "fyi";

/** The categories an item of an instance of `kind` may carry. */
export const categoriesFor = (kind) => (kind === "contributions" ? [...CATEGORIES, FYI] : CATEGORIES);
export const OLD_SECTIONS = ["active", "easy", "almost", "review", "deferred", "hardware"];

const FROM_SECTION = { active: "unblock", easy: "land", almost: "land", deferred: "decide", hardware: "decide" };

/** The category for an old `section`, or null for an unknown one. `review` depends on who wrote the item. */
export function categoryFromSection(section, item = {}) {
	if (section === "review") return item.authorType === "contributor" ? "unblock" : "land";
	return FROM_SECTION[section] ?? null;
}

/**
 * Returns the item in the current form: `category` in place of `section`, `needsHardware` for the old `hardware`,
 * and a discussion's GitHub category in `discussionCategory`. It returns a copy and leaves `item` as it is.
 * An item whose `section` is unknown keeps it, so the validator can name it.
 */
export function normalizeCategory(item) {
	if (!item || typeof item !== "object" || Array.isArray(item)) return item;
	const hasCategory = CATEGORIES.includes(item.category) || item.category === FYI;
	const out = { ...item };
	// Before categories, `category` held only a discussion's category name on GitHub
	if (!hasCategory && typeof item.category === "string" && item.kind === "discussion") {
		if (out.discussionCategory === undefined) out.discussionCategory = item.category;
		delete out.category;
	}
	if (item.section === undefined) return out;
	const mapped = categoryFromSection(item.section, item);
	if (!mapped) return out;
	if (!hasCategory) out.category = mapped;
	if (item.section === "hardware" && out.needsHardware === undefined) out.needsHardware = true;
	delete out.section;
	return out;
}
