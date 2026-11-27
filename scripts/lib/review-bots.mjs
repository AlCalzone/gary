// The GitHub review bots of a profile and the config's choice among them. Pure functions, no GitHub calls.
// A profile entry is "copilot", { login, trigger: "request" } or { login, trigger: { comment } }.
// Code works with the normalized form { key, trigger, login?, comment? }. `trigger` is "copilot", "request" or "comment".
// A drive file stores the bots of its round in the same form without `comment`.

export const COPILOT = "copilot";
export const MAX_TRIGGER_COMMENT = 200;
// A GitHub login has letters, digits and single hyphens, no hyphen at either end, and at most 39 characters
const BOT_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const BOT_FIELDS = ["login", "trigger"];

/** The normalized bot of one profile entry, or null when the entry is not valid. */
export function normalizeBot(entry) {
	if (entry === COPILOT) return { key: COPILOT, trigger: COPILOT };
	if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.login !== "string") return null;
	const key = entry.login.toLowerCase();
	if (entry.trigger === "request") return { key, login: entry.login, trigger: "request" };
	if (entry.trigger && typeof entry.trigger === "object" && typeof entry.trigger.comment === "string") return { key, login: entry.login, trigger: "comment", comment: entry.trigger.comment };
	return null;
}

/** The profile's review bots, normalized. Invalid entries are left out. */
export function profileReviewBots(profile) {
	return (Array.isArray(profile?.reviewBots) ? profile.reviewBots : []).map(normalizeBot).filter(Boolean);
}

/**
 * The review bots Gary asks on this instance: `{ bots, missing, source }`. `review.github` in config.json is "profile" by
 * default, which takes all of the profile's bots. A list of keys takes those of the profile's bots, in the profile's
 * order, and `missing` names the keys the profile does not list.
 */
export function activeReviewBots(config, profile) {
	const all = profileReviewBots(profile);
	const pick = config?.review?.github ?? "profile";
	if (!Array.isArray(pick)) return { bots: all, missing: [], source: "profile" };
	const keys = pick.map((k) => String(k).toLowerCase());
	return { bots: all.filter((b) => keys.includes(b.key)), missing: keys.filter((k) => !all.some((b) => b.key === k)), source: "config" };
}

/** The bot as a drive file stores it: no trigger text, which only the profile holds. */
export function driveBot(bot) {
	return bot.trigger === COPILOT ? { key: COPILOT, trigger: COPILOT } : { key: bot.key, login: bot.login, trigger: bot.trigger };
}

/**
 * The bots of a drive file's round. A drive file from before several bots has `reviewBot: "copilot"`, which is read
 * as Copilot. A drive file without either has none.
 */
export function roundBots(drive) {
	if (Array.isArray(drive?.reviewBots)) return drive.reviewBots.filter((b) => b && typeof b.key === "string");
	if (typeof drive?.reviewBot === "string" && drive.reviewBot) return [normalizeBot(drive.reviewBot) ?? { key: drive.reviewBot.toLowerCase(), trigger: COPILOT }];
	return [];
}

/**
 * Whether `author` posted as `bot`. Copilot posts under logins that start with "copilot", like
 * copilot-pull-request-reviewer[bot]. Any other bot matches its login, or its login plus "[bot]", ignoring case.
 */
export function isBotAuthor(bot, author) {
	const login = String(author ?? "").toLowerCase();
	if (!login) return false;
	if (bot.trigger === COPILOT) return login.startsWith(COPILOT);
	return login === bot.key || login === `${bot.key}[bot]`;
}

/** The name the board and the messages use for a bot: "Copilot", or its login. */
export const botName = (bot) => (bot.trigger === COPILOT ? "Copilot" : bot.login ?? bot.key);

/** "Copilot", "Copilot and octobot", "Copilot, octobot and octobot2". */
export function botNames(bots) {
	const names = bots.map(botName);
	return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The trigger comments of the profile's review bots, as written. */
export function reviewTriggerComments(profile) {
	return profileReviewBots(profile).filter((b) => b.trigger === "comment").map((b) => b.comment);
}

/**
 * Every text that counts as a bot command in the profile, trimmed and in lower case: the values of `botCommands` and
 * the trigger comments of `reviewBots`. No text an agent writes may contain one.
 */
export function botCommandTexts(profile) {
	const commands = Object.values(profile?.botCommands ?? {}).filter((c) => typeof c === "string");
	return [...commands, ...reviewTriggerComments(profile)].map((c) => c.trim().toLowerCase()).filter(Boolean);
}

/** Adds the problems of a profile's `reviewBots` to `errors` and `unknown`. */
export function checkReviewBots(list, errors, unknown) {
	if (list === undefined) return;
	if (!Array.isArray(list)) {
		errors.push(`"reviewBots" must be a list of "copilot", { "login", "trigger": "request" } and { "login", "trigger": { "comment" } }`);
		return;
	}
	const seen = new Set();
	list.forEach((entry, i) => {
		const where = `reviewBots[${i}]`;
		if (typeof entry === "string") {
			if (entry !== COPILOT) errors.push(`"${where}" must be "copilot" or an object with "login" and "trigger"`);
		} else if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			errors.push(`"${where}" must be "copilot" or an object with "login" and "trigger"`);
			return;
		} else {
			for (const key of Object.keys(entry)) if (!BOT_FIELDS.includes(key)) unknown.push(`unknown field "${where}.${key}"`);
			const login = entry.login;
			if (typeof login !== "string" || !login.trim()) errors.push(`"${where}.login" must be the bot's GitHub login`);
			else if (!BOT_LOGIN.test(login)) errors.push(`"${where}.login" must be a GitHub login without "[bot]": letters, digits and single hyphens, at most 39 characters`);
			else if (login.toLowerCase() === COPILOT) errors.push(`"${where}": write Copilot as "copilot"`);
			const trigger = entry.trigger;
			if (trigger && typeof trigger === "object" && !Array.isArray(trigger)) {
				for (const key of Object.keys(trigger)) if (key !== "comment") unknown.push(`unknown field "${where}.trigger.${key}"`);
				const comment = trigger.comment;
				if (typeof comment !== "string" || !comment.trim()) errors.push(`"${where}.trigger.comment" must be the comment that asks the bot for a review`);
				else if (/[\r\n]/.test(comment)) errors.push(`"${where}.trigger.comment" must be one line`);
				else if (comment.length > MAX_TRIGGER_COMMENT) errors.push(`"${where}.trigger.comment" is longer than ${MAX_TRIGGER_COMMENT} characters`);
			} else if (trigger !== "request") errors.push(`"${where}.trigger" must be "request" or { "comment": "<the comment that asks for a review>" }`);
		}
		const bot = normalizeBot(entry);
		const key = bot?.key ?? (typeof entry?.login === "string" ? entry.login.toLowerCase() : null);
		if (key && seen.has(key)) errors.push(`"${where}" names the review bot "${key}" a second time`);
		if (key) seen.add(key);
	});
}

/** Adds the problems of config.json's `review` to `errors` and `unknown`. The profile is checked against it elsewhere. */
export function checkReviewConfig(review, errors, unknown) {
	if (review === undefined) return;
	if (!review || typeof review !== "object" || Array.isArray(review)) {
		errors.push(`"review" must be { "github": "profile" | [<review bot>, …] }`);
		return;
	}
	for (const key of Object.keys(review)) if (key !== "github") unknown.push(`unknown field "review.${key}"`);
	const github = review.github;
	if (github === undefined || github === "profile") return;
	const keys = Array.isArray(github) ? github : null;
	const ok = keys && keys.every((k) => typeof k === "string" && (k === COPILOT || BOT_LOGIN.test(k)));
	if (!ok) {
		errors.push(`"review.github" must be "profile" or a list of review bot keys from the profile's reviewBots, like ["copilot", "octobot"]`);
		return;
	}
	const lower = keys.map((k) => k.toLowerCase());
	if (new Set(lower).size !== lower.length) errors.push(`"review.github" names a review bot twice`);
}
