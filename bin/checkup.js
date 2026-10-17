#!/usr/bin/env node
// Standalone CLI — for the case the in-session command cannot cover: Pi is
// installed but will not start, so there is no session to run /checkup in.
//
// The registry checks need a live process and report skipped here. Everything
// else (packages, binaries, config, runtime, and network unless --offline) runs
// exactly as it does inside Pi.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "../src/checks/index.js";
import { buildContext } from "../src/context.js";
import { renderReport, renderVerdict, toJson } from "../src/render.js";
import { applyRepairs } from "../src/repair.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A corrupt install should still produce a report, so a bad manifest degrades to
// an unknown version instead of an unhandled SyntaxError.
function readVersion() {
	try {
		return JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
}
const VERSION = readVersion();

const HELP = `pi-checkup ${VERSION} — health checks for a Pi installation

Usage
  pi-checkup [options]

Options
  -v, --verbose    show how to fix each finding
      --json       print the report as JSON
      --offline    skip every network probe
      --fix        apply the safe repairs (requires --yes)
      --yes        confirm repairs without prompting
  -h, --help       show this help
      --version    print the version

Exit codes
  0  no failed checks
  1  at least one check failed
  2  usage error

The registry section needs a running Pi session; use /checkup inside Pi to
audit loaded tools and commands.`;

function parseArgs(argv) {
	const opts = { verbose: false, json: false, offline: false, fix: false, yes: false, help: false, version: false };
	for (const arg of argv) {
		switch (arg) {
			case "-v":
			case "--verbose":
				opts.verbose = true;
				break;
			case "--json":
				opts.json = true;
				break;
			case "--offline":
				opts.offline = true;
				break;
			case "--fix":
				opts.fix = true;
				break;
			case "--yes":
			case "-y":
				opts.yes = true;
				break;
			case "-h":
			case "--help":
				opts.help = true;
				break;
			case "--version":
				opts.version = true;
				break;
			default:
				throw new Error(`unknown option: ${arg}`);
		}
	}
	return opts;
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`${e.message}\n\n${HELP}\n`);
		return 2;
	}

	if (opts.help) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	if (opts.version) {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}

	const ctx = buildContext({ cwd: process.cwd(), offline: opts.offline });
	const results = await runChecks(ctx);

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(toJson(results), null, 2)}\n`);
		return results.some((r) => r.status === "fail") ? 1 : 0;
	}

	const report = renderReport(results, {
		verbose: opts.verbose,
		hintCommand: "pi-checkup --verbose",
		// Piped output has no columns; the renderer's default keeps logs stable.
		width: process.stdout.isTTY ? process.stdout.columns || 80 : 80,
	});
	process.stdout.write(`${report}\n`);

	const fixable = results.filter((r) => r.fix && r.fixTarget);
	if (opts.fix) {
		if (!fixable.length) {
			process.stdout.write("\nNothing to repair automatically.\n");
		} else if (!opts.yes) {
			process.stdout.write(`\n${fixable.length} safe repair(s) available:\n`);
			for (const f of fixable) process.stdout.write(`  • ${f.title}: ${f.detail}\n`);
			process.stdout.write("\nRe-run with --fix --yes to apply them. Every file is backed up first.\n");
		} else {
			const applied = await applyRepairs(fixable);
			process.stdout.write("\nRepairs\n");
			for (const a of applied) process.stdout.write(`  ${a.ok ? "✓" : "✗"} ${a.message}\n`);
			process.stdout.write("\nRestart Pi so it picks up the changes.\n");
		}
	} else if (fixable.length) {
		process.stdout.write(`\n${fixable.length} finding(s) can be repaired with --fix.\n`);
	}

	// Discoverability: the CLI cannot audit the registry, and saying so is more
	// useful than letting the skipped section look like a clean bill of health.
	process.stdout.write(`\n${renderVerdict(results)}  ·  run /checkup inside Pi for registry checks\n`);
	return results.some((r) => r.status === "fail") ? 1 : 0;
}

main().then(
	(code) => process.exit(code),
	(e) => {
		process.stderr.write(`pi-checkup crashed: ${String(e?.stack ?? e)}\n`);
		process.exit(2);
	},
);
