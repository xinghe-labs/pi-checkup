// pi-checkup — health checks for a Pi installation.
//
// `/checkup` answers the question `pi list` cannot: are the things you installed
// actually loaded, reachable, and running under the names you think they are?
import * as registry from "./checks/registry.js";
import * as packages from "./checks/packages.js";
import * as binaries from "./checks/binaries.js";
import * as network from "./checks/network.js";
import * as config from "./checks/config.js";
import * as runtime from "./checks/runtime.js";
import { renderReport, renderVerdict, toJson } from "./render.js";

const CHECKS = [registry, packages, binaries, network, config, runtime];

const USAGE = [
	"/checkup            run every check",
	"/checkup verbose    run every check and show how to fix each finding",
	"/checkup json       print the report as JSON",
	"/checkup fix        apply the safe repairs (asks first)",
].join("\n");

/**
 * Run every check module. A module that throws becomes a reported finding
 * instead of taking the whole report down — a broken diagnostic should still
 * tell you which part broke.
 */
async function runChecks(ctx) {
	const settled = await Promise.all(
		CHECKS.map(async (mod) => {
			const name = mod.group ?? "Unknown";
			try {
				return await mod.run(ctx);
			} catch (e) {
				return [
					{
						group: name,
						id: `crash:${name}`,
						title: name.toLowerCase(),
						status: "warn",
						detail: `check crashed: ${String(e?.message ?? e)}`,
						hint: "This is a bug in pi-checkup, not necessarily in your setup.",
					},
				];
			}
		}),
	);
	return settled.flat();
}

export default function checkupExtension(pi) {
	pi.registerCommand("checkup", {
		description: "Health-check this Pi installation: registry, packages, binaries, network, config, runtime",
		handler: async (rawArgs, ctx) => {
			const args = (rawArgs ?? "").trim().toLowerCase();
			const words = args.split(/\s+/).filter(Boolean);

			if (words.includes("help") || words.includes("-h") || words.includes("--help")) {
				ctx.ui.notify(USAGE, "info");
				return;
			}

			const verbose = words.includes("verbose") || words.includes("-v") || words.includes("--verbose");
			const asJson = words.includes("json") || words.includes("--json");
			const wantsFix = words.includes("fix");

			const results = await runChecks({ pi, cwd: ctx.cwd, mode: ctx.mode });

			if (asJson) {
				ctx.ui.notify(JSON.stringify(toJson(results, { agentDir: undefined }), null, 2), "info");
				return;
			}

			const report = renderReport(results, { verbose });
			ctx.ui.setStatus?.("checkup", renderVerdict(results));

			if (!wantsFix) {
				const failed = results.filter((r) => r.status === "fail").length;
				ctx.ui.notify(report, failed ? "error" : "info");
				return;
			}

			// --- fix mode ---------------------------------------------------
			const fixable = results.filter((r) => r.fix && r.fixTarget);
			if (!fixable.length) {
				ctx.ui.notify(`${report}\n\nNothing to repair automatically.`, "info");
				return;
			}

			const summary = fixable.map((r) => `  • ${r.title}: ${r.detail}`).join("\n");
			const approved = await ctx.ui.confirm(
				`Apply ${fixable.length} safe repair(s)?`,
				`${summary}\n\nEvery file is backed up before it is written.`,
			);
			if (!approved) {
				ctx.ui.notify(`${report}\n\nNo changes made.`, "info");
				return;
			}

			const applied = [];
			const seen = new Set();
			for (const finding of fixable) {
				// Several findings can point at the same file; apply each file once.
				const key = `${finding.fix}:${finding.fixTarget}`;
				if (seen.has(key)) continue;
				seen.add(key);
				try {
					if (finding.fix === "restore-config") applied.push(config.applyRestoreConfig(finding.fixTarget));
					else if (finding.fix === "dedupe-packages") applied.push(config.applyDedupePackages(finding.fixTarget));
				} catch (e) {
					applied.push({ ok: false, message: `${finding.title}: ${String(e?.message ?? e)}` });
				}
			}

			const log = applied.map((a) => `  ${a.ok ? "✓" : "✗"} ${a.message}`).join("\n");
			ctx.ui.notify(`${report}\n\nRepairs\n${log || "  (nothing applied)"}\n\nRun /reload so Pi picks up the changes.`, "info");
		},
	});
}
