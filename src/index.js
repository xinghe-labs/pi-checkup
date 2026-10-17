// pi-checkup — health checks for a Pi installation.
//
// `/checkup` answers the question `pi list` cannot: are the things you installed
// actually loaded, reachable, and running under the names you think they are?
//
// This file is the in-session command only. The checks live in ./checks/ and are
// shared with the standalone CLI in ../bin/checkup.js.
import { runChecks } from "./checks/index.js";
import { buildContext } from "./context.js";
import { renderReport, renderVerdict, toJson } from "./render.js";

const USAGE = [
	"/checkup            run every check",
	"/checkup verbose    run every check and show how to fix each finding",
	"/checkup json       print the report as JSON",
	"/checkup fix        apply the safe repairs (asks first)",
	"",
	"Suppress rows you have accepted with PI_CHECKUP_IGNORE=id,Group:id,title",
].join("\n");

export default function checkupExtension(pi) {
	pi.registerCommand("checkup", {
		description: "Health-check this Pi installation: registry, packages, binaries, network, config, runtime",
		handler: async (rawArgs, ctx) => {
			const words = (rawArgs ?? "")
				.trim()
				.toLowerCase()
				.split(/\s+/)
				.filter(Boolean);

			if (words.includes("help") || words.includes("-h") || words.includes("--help")) {
				ctx.ui.notify(USAGE, "info");
				return;
			}

			const verbose = words.includes("verbose") || words.includes("-v") || words.includes("--verbose");
			const asJson = words.includes("json") || words.includes("--json");
			const wantsFix = words.includes("fix");

			// Kept, not discarded: the repair needs the agent directory, and the
			// Pi command context is not documented to carry one.
			const checkCtx = buildContext({ pi, cwd: ctx.cwd });
			const results = await runChecks(checkCtx);

			if (asJson) {
				ctx.ui.notify(JSON.stringify(toJson(results), null, 2), "info");
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

			const { applyRepairs } = await import("./repair.js");
			const applied = await applyRepairs(fixable, { agentDir: checkCtx.agentDir });

			const log = applied.map((a) => `  ${a.ok ? "✓" : "✗"} ${a.message}`).join("\n");
			// The verdict has to describe the tree after the repair, for the same
			// reason the CLI's exit code does: reporting the pre-repair findings
			// under a "repaired" message tells the user the fix did nothing.
			let verdict = renderVerdict(results);
			if (applied.some((a) => a.ok)) {
				const after = await runChecks(buildContext({ pi, cwd: ctx.cwd }));
				verdict = renderVerdict(after);
				ctx.ui.setStatus?.("checkup", verdict);
			}
			ctx.ui.notify(
				`${report}\n\nRepairs\n${log || "  (nothing applied)"}\n\n${verdict}  ·  re-checked after repair\n\nRun /reload so Pi picks up the changes.`,
				"info",
			);
		},
	});
}
