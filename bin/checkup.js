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
import { packageVersion, scrubCredentials } from "../src/util.js";

const VERSION = packageVersion();

const HELP = `pi-checkup ${VERSION} — health checks for a Pi installation

Usage
  pi-checkup [options]

Options
  -v, --verbose    show how to fix each finding
      --json       print the report as JSON
      --offline    skip every network probe
      --fix        apply the safe repairs (requires --yes)
  -y, --yes        confirm repairs without prompting
  -h, --help       show this help
      --version    print the version

Exit codes
  0  no failed checks (including after a successful repair)
  1  at least one check failed
  2  usage error, or the run itself crashed

--json and --fix cannot be combined: --json is a single machine-readable
snapshot, and a repair changes what the snapshot describes.

The registry section needs a running Pi session; use /checkup inside Pi to
audit loaded tools and commands.

Environment
  PI_CODING_AGENT_DIR    agent directory to inspect (default: ~/.pi/agent)
  PI_CHECKUP_IGNORE      comma-separated rows to downgrade to skipped, by id,
                         Group:id, or title (e.g. "unreachable,Config:env")
  PI_CHECKUP_PROBE_URL   opt in to a real forwarding test through the proxy
  https_proxy, HTTPS_PROXY, http_proxy, HTTP_PROXY, all_proxy, ALL_PROXY
                         the first one set is tested for reachability; never
                         printed with credentials`;

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
	// Silently ignoring one of these two would run no repairs and say nothing.
	if (opts.json && opts.fix) throw new Error("--json cannot be combined with --fix");
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
		// Stamped: a JSON report pasted into an issue has to say what produced it,
		// and a version or a platform is the first thing anyone asks for.
		const payload = toJson(results, { version: VERSION, node: process.versions.node, platform: process.platform });
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return results.some((r) => r.status === "fail") ? 1 : 0;
	}

	const report = renderReport(results, {
		verbose: opts.verbose,
		// `pi-checkup` alone only resolves after a global install the README does
		// not require, so the hint names the form that always works.
		hintCommand: "npx pi-checkup --verbose",
		// Piped output has no columns; the renderer's default keeps logs stable.
		width: process.stdout.isTTY ? process.stdout.columns || 80 : 80,
	});
	process.stdout.write(`${report}\n`);

	const fixable = results.filter((r) => r.fix && r.fixTarget);
	let finalResults = results;
	if (opts.fix) {
		if (!fixable.length) {
			process.stdout.write("\nNothing to repair automatically.\n");
		} else if (!opts.yes) {
			process.stdout.write(`\n${fixable.length} safe repair(s) available:\n`);
			for (const f of fixable) process.stdout.write(`  • ${f.title}: ${f.detail}\n`);
			process.stdout.write("\nRe-run with --fix --yes to apply them. Every file is backed up first.\n");
		} else {
			const applied = await applyRepairs(fixable, { agentDir: ctx.agentDir });
			process.stdout.write("\nRepairs\n");
			for (const a of applied) process.stdout.write(`  ${a.ok ? "✓" : "✗"} ${a.message}\n`);
			// Only when something was actually written: a refused repair changed
			// nothing, so telling the user to restart Pi is noise.
			if (applied.some((a) => a.ok)) process.stdout.write("\nRestart Pi so it picks up the changes.\n");
			// Re-check: the exit code has to describe the tree as it is now, not as
			// it was before the repair. Exiting 1 right after fixing the only
			// failure breaks every `&&` chain that calls this.
			//
			// The context has to be rebuilt, not reused: it holds the settings it
			// parsed on construction, so re-running the checks against the old one
			// reports the entries the repair just removed. That is how a successful
			// prune still exited 1.
			if (applied.some((a) => a.ok)) {
				finalResults = await runChecks(buildContext({ cwd: process.cwd(), offline: opts.offline }));
			}
		}
	} else if (fixable.length) {
		process.stdout.write(`\n${fixable.length} finding(s) can be repaired with --fix.\n`);
	}

	// Discoverability: the CLI cannot audit the registry, and saying so is more
	// useful than letting the skipped section look like a clean bill of health.
	// Labelled, because an unlabelled verdict printed under a pre-repair report
	// reads as a contradiction: "1 failed" then "✓ 23 ok".
	const after = finalResults === results ? "" : "  ·  re-checked after repair";
	process.stdout.write(`\n${renderVerdict(finalResults)}${after}  ·  run /checkup inside Pi for registry checks\n`);
	return finalResults.some((r) => r.status === "fail") ? 1 : 0;
}

// `npx pi-checkup | head -3` closes stdout while the report is still being
// written. Node surfaces that as an unhandled EPIPE rejection, so a truncated
// pipe printed "pi-checkup crashed" with a stack for something that is not a
// failure of the check at all. A consumer that stopped reading is a normal exit.
process.stdout.on("error", (e) => {
	if (e?.code === "EPIPE") process.exit(0);
	throw e;
});
process.stderr.on("error", (e) => {
	if (e?.code !== "EPIPE") throw e;
});

// `process.exit()` can truncate a pipe that has not drained, and a --json report
// on a slow consumer is exactly the payload large enough to hit that. Setting
// exitCode lets Node flush and exit on its own.
main().then(
	(code) => {
		process.exitCode = code;
	},
	(e) => {
		// Scrubbed: an uncaught error can quote the URL or the config value it
		// choked on, and a crash report is exactly where nobody looks twice.
		process.stderr.write(`pi-checkup crashed: ${scrubCredentials(String(e?.stack ?? e))}\n`);
		process.exitCode = 2;
	},
);
