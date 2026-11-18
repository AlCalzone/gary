// gary doctor: checks the installation without changing anything. --json prints the checks as JSON.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ROOT, homePath, loadConfig, loadProfile, paths, profileDir } from "./lib/config.mjs";
import { readLogin } from "./lib/gh.mjs";
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

async function boardOnPort(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
		return (await res.json())?.name === "gary";
	} catch {
		return false;
	}
}

export async function main(argv) {
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

	const major = Number(process.versions.node.split(".")[0]);
	add("node", major >= 24 ? "ok" : "fail", `Node ${process.versions.node}${major >= 24 ? "" : ", needs 24 or later"}`);
	await attempt("gh", async () => ["ok", (await run("gh", ["--version"])).stdout.split("\n")[0]]);

	let config = null;
	await attempt("config", async () => {
		config = loadConfig();
		return ["ok", paths().config];
	});
	await attempt("profile", async () => {
		const profile = loadProfile();
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
		await attempt("checkout", async () => {
			if (!config.checkout) return ["warn", "no checkout in config.json, fixes need a local clone"];
			const dir = homePath(config.checkout);
			return existsSync(join(dir, ".git")) ? ["ok", dir] : ["fail", `${dir} is not a git checkout`];
		});
		await attempt("port", async () => {
			if (await portFree(config.port)) return ["ok", `${config.port} is free`];
			if (await boardOnPort(config.port)) return ["ok", `${config.port} runs the board server`];
			return ["fail", `another program uses port ${config.port}`];
		});
	}
	await attempt("required tools", async () => {
		const tools = loadProfile().requiredTools;
		return ["ok", tools.length ? `the routine checks these at the start of a run: ${tools.join(", ")}` : "none"];
	});
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

	if (argv.includes("--json")) console.log(JSON.stringify(checks, null, 2));
	else for (const c of checks) console.log(`${c.status.padEnd(4)}  ${c.name.padEnd(14)} ${c.detail}`);
	process.exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
}
