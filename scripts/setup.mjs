// gary setup: creates an instance under the root with config.json and state/, and the shared personal.md.
// It asks for missing values in a terminal. Elsewhere it needs them as flags.
// It also moves the layout from before instances into instances/<name>.
import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, promisify } from "node:util";
import { migrate } from "./migrate.mjs";
import {
	INSTANCE_NAME, ROOT, expandHome, explicitInstance, hasFlatLayout, instanceDir, instanceFacts, instanceNames, personalFile, rootConfigFile, rootDir, validateConfig, validateProfile,
} from "./lib/config.mjs";

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
  --instance <name>         name of the instance, default the repository name in lower case
  --port <n>                the one board server's port, in the root config.json, default 7878
  --force                   replace an existing config.json and existing links
  --no-links                do not link skills and the launcher, do not print the MCP command
  --register-mcp            run \`claude mcp add\` for a clone install
`;

const PERSONAL_HEADER = `<!--
Your own rules for the triage agents, as plain text, for every instance. Nothing here is shared with others.
The agents read this file last, so it wins over the core and profile rules. An instance can add its own personal.md.
-->
`;

const realOrSelf = (p) => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};


/** An instance name from a repository name: lower case, other characters as dashes. */
export function nameFromRepo(repo) {
	return String(repo ?? "").split("/").pop().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 40);
}

/** Moves config.json and state/ from the root into instances/<name>. Paths in the config become absolute. */
function migrateFlat(report) {
	const root = rootDir();
	const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
	const abs = (p) => (typeof p === "string" && !p.startsWith("~") && !isAbsolute(p) ? resolve(root, p) : p);
	config.profile = abs(config.profile);
	if (config.checkout) config.checkout = abs(config.checkout);
	if (config.bot?.tokenFile) config.bot.tokenFile = abs(config.bot.tokenFile);
	const profile = resolve(expandHome(config.profile ?? ""));
	const repo = JSON.parse(readFileSync(join(profile, "profile.json"), "utf8")).repo;
	const name = nameFromRepo(repo);
	if (!INSTANCE_NAME.test(name)) throw new Error(`Cannot name an instance after ${repo}. Move ${root}/config.json by hand.`);
	const dir = instanceDir(name);
	if (existsSync(dir)) throw new Error(`${dir} already exists, so the old layout in ${root} cannot move there.`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, "\t") + "\n");
	unlinkSync(join(root, "config.json"));
	if (existsSync(join(root, "state"))) renameSync(join(root, "state"), join(dir, "state"));
	report.push(`moved the old layout into ${dir}`);
	return name;
}

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

	const report = [];
	if (hasFlatLayout()) {
		const moved = migrateFlat(report);
		console.error(`Moved the old layout into instance ${moved}.`);
	}
	report.push(...(await migrate()));
	if (o.port) {
		const port = Number(o.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a port number");
		writeFileSync(rootConfigFile(), JSON.stringify({ port }, null, "\t") + "\n");
		report.push(`set the board port ${port} in ${rootConfigFile()}`);
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
			const dir = profileArg ? resolve(expandHome(profileArg)) : join(rootDir(), "profiles", basename(repo));
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

		// Instance name, and no second instance for the same repo or checkout
		const repo = created.length ? created[0][2].repo : JSON.parse(readFileSync(join(profile, "profile.json"), "utf8")).repo;
		const name = explicitInstance() ?? nameFromRepo(repo);
		if (!INSTANCE_NAME.test(name)) throw new Error(`"${name}" is not a valid instance name. Use lower case letters, digits and dashes, at most 40.`);
		const dir = instanceDir(name);
		const exists = existsSync(join(dir, "config.json"));
		if (exists && !o.force) throw new Error(`Instance ${name} already exists in ${dir}. Pass --force to replace its config.json.`);
		const others = instanceNames().filter((n) => n !== name).map(instanceFacts);
		const sameRepo = others.find((f) => f.repo && repo && f.repo.toLowerCase() === repo.toLowerCase());
		if (sameRepo) throw new Error(`Instance ${sameRepo.name} already triages ${repo}.`);
		if (checkout) {
			const mine = realOrSelf(resolve(expandHome(checkout)));
			const sameCheckout = others.find((f) => f.checkout && realOrSelf(f.checkout) === mine);
			if (sameCheckout) throw new Error(`Instance ${sameCheckout.name} already uses the checkout ${mine}.`);
		}
		const config = { kind: "maintainer", profile: collapseHome(profile), me, ...(checkout && { checkout }), bot, allowOwnTokenPushes: false, activeWindowDays: 30, activeMaxWaitDays: 14, maxFullReviewsPerRun: 10, maxAutoFixesPerRun: 2 };
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
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, "\t") + "\n");
		if (!existsSync(personalFile())) writeFileSync(personalFile(), PERSONAL_HEADER);
		console.error(`${exists ? "Updated" : "Created"} instance ${name}.`);

		report.push(`wrote ${join(dir, "config.json")}`, ...created.map(([, d]) => `created profile ${d} from profiles/template`));
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
