// gary setup: creates the home directory with config.json, personal.md and state/.
// It asks for missing values in a terminal. Elsewhere it needs them as flags.
import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, promisify } from "node:util";
import { ROOT, configFile, expandHome, homeDir, personalFile, stateDir, validateConfig, validateProfile } from "./lib/config.mjs";

const run = promisify(execFile);

const USAGE = `Usage: gary setup [options]

  --repo <owner/name>       repository to triage, needed for a new profile
  --me <login>              your GitHub login, defaults to your stored gh login
  --checkout <dir>          your local clone of the repository
  --profile <dir|name>      profile directory, or the name of a profile shipped in profiles/
  --name <title>            board title for a new profile, defaults to the repository name
  --bot-login <login>       bot account that acts for the board
  --bot-token-file <path>   file with the bot's GitHub token
  --no-bot                  run without a bot account
  --port <n>                board server port, default 7878
  --force                   replace an existing config.json and existing links
  --no-links                do not link skills and the launcher, do not print the MCP command
  --register-mcp            run \`claude mcp add\` for a clone install
`;

const PERSONAL_HEADER = `<!--
Your own rules for the triage agents, as plain text. Nothing here is shared.
The agents read this file last, so it wins over the core and profile rules.
-->
`;

function collapseHome(path) {
	const rel = relative(homedir(), path);
	return rel && !rel.startsWith("..") && !rel.startsWith("/") ? `~/${rel}` : path;
}

async function storedLogin() {
	const env = { ...process.env };
	for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) delete env[name];
	try {
		return (await run("gh", ["api", "user", "--jq", ".login"], { env, timeout: 30000 })).stdout.trim();
	} catch {
		return "";
	}
}

/** A plugin install lives in Claude Code's plugin cache. Anything else is a clone. */
export function isPluginInstall(root = ROOT) {
	return resolve(root).startsWith(join(homedir(), ".claude", "plugins") + "/");
}

function link(target, path, force, report) {
	let existing = null;
	try {
		existing = lstatSync(path);
	} catch {
		// Nothing there yet
	}
	if (existing) {
		if (existing.isSymbolicLink() && resolve(join(path, ".."), readlinkSync(path)) === target) {
			report.push(`kept ${path}`);
			return;
		}
		if (!existing.isSymbolicLink() || !force) {
			report.push(`skipped ${path}: it already exists${existing.isSymbolicLink() ? " and points elsewhere, use --force" : ""}`);
			return;
		}
		unlinkSync(path);
	}
	mkdirSync(join(path, ".."), { recursive: true });
	symlinkSync(target, path);
	report.push(`linked ${path} -> ${target}`);
}

export async function main(argv) {
	const { values: o } = parseArgs({
		args: argv,
		options: {
			repo: { type: "string" },
			me: { type: "string" },
			checkout: { type: "string" },
			profile: { type: "string" },
			name: { type: "string" },
			"bot-login": { type: "string" },
			"bot-token-file": { type: "string" },
			"no-bot": { type: "boolean", default: false },
			port: { type: "string" },
			force: { type: "boolean", default: false },
			"no-links": { type: "boolean", default: false },
			"register-mcp": { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (o.help) return console.log(USAGE);

	const home = homeDir();
	if (existsSync(configFile()) && !o.force) {
		throw new Error(`${configFile()} already exists. Pass --force to replace it.`);
	}

	const tty = process.stdin.isTTY && process.stdout.isTTY;
	const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null;
	const ask = async (question, fallback = "") => {
		if (!rl) return fallback;
		const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
		return answer || fallback;
	};

	try {
		const me = o.me ?? (await ask("Your GitHub login", await storedLogin())) ?? "";
		if (!me) throw new Error("Pass --me <login>, or log in with `gh auth login` first.");

		// Profile: an existing directory, a shipped profile name, or a new profile from profiles/template
		let profileArg = o.profile ?? (await ask("Profile directory or shipped profile name (empty for a new profile)"));
		let profile;
		const shipped = profileArg && !profileArg.includes("/") ? join(ROOT, "profiles", profileArg) : null;
		if (shipped && profileArg !== "template" && existsSync(join(shipped, "profile.json"))) profile = shipped;
		else if (profileArg && existsSync(join(resolve(expandHome(profileArg)), "profile.json"))) profile = resolve(expandHome(profileArg));

		const created = [];
		if (!profile) {
			const repo = o.repo ?? (await ask("Repository to triage (owner/name)"));
			if (!repo) throw new Error("A new profile needs --repo <owner/name>.");
			const dir = profileArg ? resolve(expandHome(profileArg)) : join(home, "profiles", basename(repo));
			if (existsSync(dir) && readdirSync(dir).length && !o.force) {
				throw new Error(`${dir} exists but holds no profile.json. Pass --force to fill it from the template.`);
			}
			const data = JSON.parse(readFileSync(join(ROOT, "profiles", "template", "profile.json"), "utf8"));
			Object.assign(data, { name: o.name ?? basename(repo), repo, maintainers: [me] });
			profile = dir;
			created.push(["profile", dir, data]);
		}

		const checkoutArg = o.checkout ?? (await ask("Your local clone of the repository (empty to skip)"));
		const checkout = checkoutArg ? collapseHome(resolve(expandHome(checkoutArg))) : undefined;

		let bot = null;
		if (!o["no-bot"]) {
			const login = o["bot-login"] ?? (await ask("Bot login (empty for none)"));
			if (login) {
				const tokenFile = o["bot-token-file"] ?? (await ask("File with the bot's token"));
				if (!tokenFile) throw new Error("A bot needs --bot-token-file <path>.");
				bot = { login, tokenFile: collapseHome(resolve(expandHome(tokenFile))) };
			} else if (o["bot-token-file"]) {
				throw new Error("--bot-token-file needs --bot-login.");
			}
		}

		const config = { profile: collapseHome(profile), me, ...(checkout && { checkout }), bot, allowOwnTokenPushes: false, port: o.port ? Number(o.port) : 7878, activeWindowDays: 30, activeMaxWaitDays: 14, maxFullReviewsPerRun: 10, maxAutoFixesPerRun: 2 };
		const errors = validateConfig(config);
		for (const [, , data] of created) {
			if (bot) data.botLogins = [...new Set([...(data.botLogins ?? []), bot.login])];
			errors.push(...validateProfile(data).map((e) => `profile: ${e}`));
		}
		if (errors.length) throw new Error(`The settings are invalid:\n- ${errors.join("\n- ")}`);

		for (const [, dir, data] of created) {
			cpSync(join(ROOT, "profiles", "template"), dir, { recursive: true, force: false, errorOnExist: false });
			writeFileSync(join(dir, "profile.json"), JSON.stringify(data, null, "\t") + "\n");
		}
		mkdirSync(stateDir(), { recursive: true });
		writeFileSync(configFile(), JSON.stringify(config, null, "\t") + "\n");
		if (!existsSync(personalFile())) writeFileSync(personalFile(), PERSONAL_HEADER);

		const report = [`wrote ${configFile()}`, ...created.map(([, dir]) => `created profile ${dir} from profiles/template`)];
		if (!o["no-links"] && !isPluginInstall()) {
			for (const name of readdirSync(join(ROOT, "skills"))) {
				link(join(ROOT, "skills", name), join(homedir(), ".claude", "skills", name), o.force, report);
			}
			link(join(ROOT, "bin", "gary"), join(homedir(), ".local", "bin", "gary"), o.force, report);
			const mcp = ["mcp", "add", "--scope", "user", "gary", "--", "node", join(ROOT, "mcp-server", "index.mjs")];
			if (o["register-mcp"]) {
				await run("claude", mcp, { timeout: 60000 });
				report.push("registered the gary MCP server");
			} else {
				report.push(`register the MCP server with: claude ${mcp.join(" ")}`);
			}
		}
		console.log(report.join("\n"));
	} finally {
		rl?.close();
	}
}
