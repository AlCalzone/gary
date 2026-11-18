// gary serve [--watch] [--dry-run]: runs the one board server in the foreground, for every instance.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./lib/config.mjs";

export function main(argv) {
	const child = spawn(process.execPath, [join(ROOT, "server", "server.mjs"), ...argv], { stdio: "inherit" });
	for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
	return new Promise((resolve) => child.on("exit", (code, signal) => {
		process.exitCode = code ?? (signal ? 1 : 0);
		resolve();
	}));
}
