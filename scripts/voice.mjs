// gary voice: the data steps of the triage-voice skill. Reads GitHub with queries only and writes local files.
//   collect --from <date> --to <date> [--include <owner/name>]... [--exclude <owner/name>]...
//   batches [--size 250] [--sample <n>]   classify merge   stats   phrases <phrase>...
//   examples [--keep <login>,...]   sample --round <name> [--split dev|test] [--n 24] [--prs 3]
//   pairs --round <name>   score --round <name>   swap --file <variants.json> [--keep <login>,...]
//   apply --file <section.md> [--check]   paths
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { personalFile } from "./lib/config.mjs";
import * as voice from "./lib/voice.mjs";

function flag(argv, name, fallback) {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
}

function flags(argv, name) {
	const out = [];
	argv.forEach((a, i) => a === `--${name}` && argv[i + 1] && out.push(argv[i + 1]));
	return out;
}

const keepOf = (argv) => (flag(argv, "keep", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const print = (x) => console.log(JSON.stringify(x, null, 2));

function isoDate(value, name) {
	const t = Date.parse(value ?? "");
	if (!Number.isFinite(t)) throw new Error(`--${name} needs a date like 2022-01-01`);
	return new Date(t).toISOString();
}

function needRound(argv) {
	const round = flag(argv, "round");
	if (!round || !/^[a-z0-9-]{1,40}$/.test(round)) throw new Error("--round needs a name like r1 or test");
	return round;
}

export async function main(argv) {
	const [sub, ...rest] = argv;
	const dir = voice.dataDir();
	switch (sub) {
		case "paths":
			return print({ data: dir, style: voice.styleDir(), personal: personalFile() });
		case "collect": {
			const from = isoDate(flag(rest, "from"), "from");
			const to = isoDate(flag(rest, "to"), "to");
			if (from >= to) throw new Error("--from must be before --to");
			return print(await voice.collect({ from, to, include: flags(rest, "include"), exclude: flags(rest, "exclude"), dir, log: (l) => console.error(l) }));
		}
		case "batches":
			return print(voice.classifyBatches({ dir, size: Number(flag(rest, "size", 250)), sample: Number(flag(rest, "sample", 0)) }));
		case "classify":
			if (rest[0] !== "merge") throw new Error("Usage: gary voice classify merge");
			return print(voice.mergeClassified(dir));
		case "stats": {
			const s = voice.stats(dir);
			const file = join(dir, "stats.json");
			writeFileSync(file, JSON.stringify(s, null, "\t"));
			return print({ file, replies: s.replies, byKind: s.byKind, bySituation: Object.fromEntries(Object.entries(s.bySituation).map(([k, v]) => [k, { n: v.n, words: v.words }])) });
		}
		case "phrases": {
			const train = voice.usable(voice.readJsonl(join(dir, "replies.jsonl"))).filter((r) => r.split === "train").map((r) => r.reply);
			return print(voice.phraseShares(train, rest));
		}
		case "examples":
			return print(voice.writeExamples({ dir, keep: keepOf(rest) }));
		case "sample":
			return print(voice.sample({ dir, round: needRound(rest), split: flag(rest, "split", "dev"), n: Number(flag(rest, "n", 24)), prs: Number(flag(rest, "prs", 3)), seed: Number(flag(rest, "seed", Date.now() % 100000)) }));
		case "pairs":
			return print(voice.pairs({ dir, round: needRound(rest) }));
		case "score":
			return print(voice.score({ dir, round: needRound(rest) }));
		case "swap": {
			const file = flag(rest, "file");
			if (!file) throw new Error("--file needs the variants JSON");
			return print(voice.swap({ dir, file, keep: keepOf(rest), real: Number(flag(rest, "real", 2)) }));
		}
		case "apply": {
			const file = flag(rest, "file");
			if (!file) throw new Error("--file needs the section text");
			const result = voice.applySection(readFileSync(file, "utf8"), { check: rest.includes("--check") });
			if (result.text !== undefined) return console.log(result.text);
			return print(result);
		}
		default:
			throw new Error("Usage: gary voice paths | collect | batches | classify merge | stats | phrases | examples | sample | pairs | score | swap | apply");
	}
}
