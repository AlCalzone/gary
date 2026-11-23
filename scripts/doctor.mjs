// gary doctor: checks the installation without changing anything. --json prints the checks as JSON.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ROOT, autoReviewOf, escalationOf, fixReviewOf, homePath, instanceName, instanceNames, isContributions, loadConfig, loadProfile, maintainerRepos, modelsOf, paths, profileDir, resolveInstance, rootConfig, rootDir, setInstance, settingsWarningsFor } from "./lib/config.mjs";
import { isPaused } from "./lib/control.mjs";
import { canReadProjects, readLogin, storedScopes } from "./lib/gh.mjs";
import { isPluginInstall } from "./setup.mjs";

const run = promisify(execFile);
const RULES = ["classification.md", "voice.md", "review.md", "issues.md"];

function portFree(port) {
	return new Promise((resolve) => {
		const s = createServer();
		s.once("error", () => resolve(false));
		s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
	});
}

/** The instances the board server on the port serves, or null when no board server answers there. */
async function boardOnPort(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
		const body = await res.json();
		return body?.name === "gary" ? (Array.isArray(body.instances) ? body.instances : []) : null;
	} catch {
		return null;
	}
}

/** The checks of the install that every instance shares: the skill links and the launcher. */
async function checkInstall(attempt) {
	await attempt("skills", async () => {
		if (isPluginInstall()) return ["ok", "plugin install, Claude Code loads the skills"];
		const missing = readdirSync(join(ROOT, "skills")).filter((name) => {
			try {
				return realpathSync(join(homedir(), ".claude", "skills", name)) !== realpathSync(join(ROOT, "skills", name));
			} catch {
				return true;
			}
		});
		return [missing.length ? "warn" : "ok", missing.length ? `not linked into ~/.claude/skills: ${missing.join(", ")}. Run \`gary setup\`` : "linked into ~/.claude/skills"];
	});
	await attempt("launcher", async () => {
		try {
			const found = (await run("sh", ["-c", "command -v gary"])).stdout.trim();
			return ["ok", found];
		} catch {
			return ["warn", "gary is not on PATH"];
		}
	});

}

async function checkInstance() {
	const checks = [];
	const add = (name, status, detail) => checks.push({ name, status, detail });
	const attempt = async (name, fn) => {
		try {
			const [status, detail] = await fn();
			add(name, status, detail);
		} catch (e) {
			add(name, "fail", e.message);
		}
	};

	await attempt("instance", async () => {
		const { name, via } = resolveInstance();
		return ["ok", `${name}, from ${via === "directory" ? "the working directory" : via}`];
	});
	const major = Number(process.versions.node.split(".")[0]);
	add("node", major >= 24 ? "ok" : "fail", `Node ${process.versions.node}${major >= 24 ? "" : ", needs 24 or later"}`);
	await attempt("gh", async () => ["ok", (await run("gh", ["--version"])).stdout.split("\n")[0]]);

	let config = null;
	await attempt("config", async () => {
		config = loadConfig();
		return ["ok", paths().config];
	});
	if (config && isContributions(config)) {
		await checkContributions(config, attempt, add);
		await checkInstall(attempt);
		return checks;
	}
	await attempt("profile", async () => {
		const profile = loadProfile();
		// The run time only warns about unknown fields. Here they fail, so typos get caught
		const unknown = settingsWarningsFor(instanceName());
		if (unknown.length) return ["fail", `unknown fields: ${unknown.join("; ")}`];
		const missing = RULES.filter((f) => !existsSync(join(profileDir(), "rules", f)));
		return [missing.length ? "warn" : "ok", `${profile.name} (${profile.repo}) in ${profileDir()}${missing.length ? `, no rules/${missing.join(", rules/")}` : ""}`];
	});

	if (config) {
		await attempt("gh login", async () => {
			const login = await readLogin("stored");
			const same = login.toLowerCase() === config.me.toLowerCase();
			return [same ? "ok" : "fail", same ? login : `stored gh login is "${login}", config.json names "${config.me}"`];
		});
		if (config.bot) {
			await attempt("bot", async () => {
				const file = homePath(config.bot.tokenFile);
				readFileSync(file, "utf8");
				const login = await readLogin("bot");
				const same = login.toLowerCase() === config.bot.login.toLowerCase();
				return [same ? "ok" : "fail", same ? `${login}, token in ${file}` : `the token in ${file} belongs to "${login}", config.json names "${config.bot.login}"`];
			});
		} else {
			add("bot", "ok", `no bot, ${config.allowOwnTokenPushes ? "bot routes run under your own gh login" : "bot routes become text you post yourself"}`);
		}
		await attempt("due dates", async () => {
			const fields = loadProfile().dueDateFields;
			const access = await canReadProjects();
			if (access.ok) return ["ok", `from milestones and from the project fields ${fields.map((f) => `"${f}"`).join(", ")}`];
			return ["warn", `from milestones only. Project dates are skipped: ${access.reason}. \`gh auth refresh -s read:project\` adds it${config.bot ? " for your login. The bot's token needs it too" : ""}`];
		});
		add("fast tier", "ok", { off: "off, every item gets the standard tier", shadow: "shadow, both tiers run and `gary shadow report` compares them", on: "on, simple items get the fast tier" }[config.fastTier]);
		await attempt("models", async () => {
			const { models, fallback } = modelsOf(config);
			const retry = fallback ? `a review stopped by the safety filter is retried on ${fallback.model}` : "no retry after a safety-filter stop, because review and standard are the same model";
			return ["ok", `worker ${models.worker}, review ${models.review}, standard ${models.standard}, fast ${models.fast}, ${retry}. master ${models.master}, not checked: the host sets the master session's model`];
		});
		add("fix limit", "ok", config.maxPendingAutoFixes === 0 ? "maxPendingAutoFixes is 0, the routine starts no fix on its own" : `at most ${config.maxPendingAutoFixes} automatic fix PRs pending at a time, ${config.maxAutoFixesPerRun} new per run`);
		await attempt("fix review", async () => {
			const fr = fixReviewOf(config, loadProfile());
			// A warning only when config.json asks for the rounds and they cannot run
			const asked = config.fixReview !== undefined && config.fixReview.reviewer !== "off";
			if (fr.reviewer === "off") return [asked ? "warn" : "ok", `off${fr.reason ? `: ${fr.reason}` : ""}. A fix PR stays a draft until you look at it`];
			return ["ok", `a fix PR gets up to ${fr.maxRounds} ${fr.reviewer} review round${fr.maxRounds === 1 ? "" : "s"}, requested as ${fr.requestAs === "bot" ? "the bot" : "you"}${fr.markReady ? ", then it is marked ready" : ", and stays a draft"}`];
		});
		await attempt("auto review", async () => {
			const ar = autoReviewOf(config, loadProfile());
			// A warning only when config.json asks for it and it cannot run
			if (!ar.enabled) return [config.autoReview?.enabled === true ? "warn" : "ok", `off${ar.reason ? `: ${ar.reason}` : ""}. No review reaches a contributor without your click`];
			return ["ok", `on for ${ar.kinds.join(", ")} PRs by outside contributors, at most ${ar.maxPerRun} per run. One review per PR goes out without your click`];
		});
		await attempt("escalate", async () => {
			const command = loadProfile().botCommands?.escalate;
			if (config.escalateAs !== "me") return ["ok", command ? "prefill: the board copies the escalate command and you post it on GitHub" : "the profile has no escalate command"];
			// A warning only when config.json asks for the post and it cannot run
			if (!command) return ["warn", 'escalateAs is "me", but the profile has no botCommands.escalate, so the board has nothing to post'];
			return ["ok", `me: a click on the escalate button posts "${command}" on the discussion under your own gh login. Nothing else posts a bot command`];
		});
		await attempt("escalate link", async () => {
			const link = escalationOf(config, loadProfile());
			// Warn only when profile.json asks for the link and it cannot run
			if (!link.enabled) return [link.pattern ? "warn" : "ok", `off: ${link.reason}. A fix PR of an escalated discussion is not linked to its issue`];
			return ["ok", `a comment by ${link.bot} that matches ${link.pattern} names the issue an escalated discussion became. Its fix PRs get "fixes #<issue>"`];
		});
		add("pause", isPaused() ? "warn" : "ok", isPaused() ? "paused: nothing goes to GitHub and queued agent requests wait. `gary resume` ends it" : "not paused");
		await attempt("checkout", async () => {
			if (!config.checkout) return ["warn", "no checkout in config.json, fixes need a local clone"];
			const dir = homePath(config.checkout);
			return existsSync(join(dir, ".git")) ? ["ok", dir] : ["fail", `${dir} is not a git checkout`];
		});
		await attempt("port", async () => {
			const { port } = rootConfig();
			if (await portFree(port)) return ["ok", `${port} is free, \`gary serve\` or board_start starts the board there`];
			const served = await boardOnPort(port);
			if (served?.includes(instanceName())) return ["ok", `${port} runs the board server, and it serves this instance`];
			if (served !== null) return ["warn", `${port} runs the board server, but it does not list this instance yet`];
			return ["fail", `another program uses port ${port}`];
		});
	}
	await attempt("required tools", async () => {
		const tools = loadProfile().requiredTools;
		return ["ok", tools.length ? `the routine checks these at the start of a run: ${tools.join(", ")}` : "none"];
	});
	await checkInstall(attempt);

	return checks;
}

/**
 * The checks of a contributions instance: the login and its scopes, the repos it leaves out, the caps and the parts it
 * shares with every instance. It has no profile, bot or checkout to check.
 */
async function checkContributions(config, attempt, add) {
	add("kind", "ok", "contributions: your own threads outside the maintainer instances. Gary writes nothing to GitHub for it, every reply is text you post yourself");
	await attempt("unknown fields", async () => {
		const unknown = settingsWarningsFor(instanceName());
		return unknown.length ? ["fail", unknown.join("; ")] : ["ok", "none"];
	});
	await attempt("gh login", async () => {
		const login = await readLogin("stored");
		const same = login.toLowerCase() === config.me.toLowerCase();
		return [same ? "ok" : "fail", same ? `${login}. The searches run as this login, so they find what it can see` : `stored gh login is "${login}", config.json names "${config.me}"`];
	});
	await attempt("token scopes", async () => {
		const scopes = await storedScopes();
		if (scopes === null) return ["warn", "GitHub names no scopes for this token, like for a fine-grained token. It needs read access to issues, pull requests and discussions of the repos you take part in"];
		if (scopes.includes("repo")) return ["ok", `${scopes.join(", ")}. "repo" lets the searches see private repos too`];
		if (scopes.includes("public_repo")) return ["warn", `${scopes.join(", ")}. Without "repo" the searches miss threads in private repos. \`gh auth refresh -s repo\` adds it`];
		return ["warn", `${scopes.join(", ") || "no scopes"}. The searches see only public threads. \`gh auth refresh -s repo\` adds private repos`];
	});
	await attempt("left out", async () => {
		const blocked = [...maintainerRepos(instanceNames().filter((n) => n !== instanceName()))];
		const parts = [blocked.length ? `the repos of your maintainer instances: ${blocked.join(", ")}` : "no maintainer instance on this machine"];
		if (config.exclude.length) parts.push(`exclude: ${config.exclude.join(", ")}`);
		parts.push(config.include.length ? `only include: ${config.include.join(", ")}` : "Every other repo counts");
		return ["ok", parts.join(". ")];
	});
	add("caps", "ok", `at most ${config.maxItems} threads per snapshot, with activity in the last ${config.activeWindowDays} days. Your own open PRs and review requests count at any age. The snapshot says when the cap cuts`);
	await attempt("models", async () => {
		const { models } = modelsOf(config);
		return ["ok", `worker ${models.worker}, standard ${models.standard} for the classification. master ${models.master}, not checked: the host sets the master session's model`];
	});
	add("pause", isPaused() ? "warn" : "ok", isPaused() ? "paused: the board stays up and queued analyses wait. `gary resume` ends it" : "not paused");
	await attempt("port", async () => {
		const { port } = rootConfig();
		if (await portFree(port)) return ["ok", `${port} is free, \`gary serve\` or board_start starts the board there`];
		const served = await boardOnPort(port);
		if (served?.includes(instanceName())) return ["ok", `${port} runs the board server, and it serves this instance`];
		if (served !== null) return ["warn", `${port} runs the board server, but it does not list this instance yet`];
		return ["fail", `another program uses port ${port}`];
	});
}

const print = (checks) => {
	for (const c of checks) console.log(`${c.status.padEnd(4)}  ${c.name.padEnd(14)} ${c.detail}`);
};

export async function main(argv) {
	const json = argv.includes("--json");
	if (!argv.includes("--all")) {
		const checks = await checkInstance();
		if (json) console.log(JSON.stringify(checks, null, 2));
		else print(checks);
		process.exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
		return;
	}
	const names = instanceNames();
	if (!names.length) throw new Error(`There is no instance in ${rootDir()}. Run \`gary setup\` first.`);
	const all = {};
	for (const name of names) {
		setInstance(name);
		all[name] = await checkInstance();
		if (!json) {
			console.log(`== ${name}`);
			print(all[name]);
		}
	}
	if (json) console.log(JSON.stringify(all, null, 2));
	process.exitCode = Object.values(all).some((checks) => checks.some((c) => c.status === "fail")) ? 1 : 0;
}
