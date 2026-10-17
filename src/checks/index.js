// The check registry, shared by the in-session command and the standalone CLI.
//
// A module that throws becomes a reported finding instead of taking the whole
// report down — a broken diagnostic should still tell you which part broke.
// It is reported as a failure, not a warning: a check that could not run is a
// broken tool, and the CLI exit code has to reflect that or CI stays green over
// a package that reports nothing.
import * as registry from "./registry.js";
import * as packages from "./packages.js";
import * as binaries from "./binaries.js";
import * as network from "./network.js";
import * as config from "./config.js";
import * as runtime from "./runtime.js";

export const CHECKS = [registry, packages, binaries, network, config, runtime];

/**
 * Run every check module against a context built by buildContext().
 * @param {object} ctx
 * @param {Array<{group?: string, run: Function}>} [modules] overridable so tests can inject a crashing module
 */
export async function runChecks(ctx, modules = CHECKS) {
	const settled = await Promise.all(
		modules.map(async (mod) => {
			const name = mod.group ?? "Unknown";
			try {
				return await mod.run(ctx);
			} catch (e) {
				return [
					{
						group: name,
						id: `crash:${name}`,
						title: name.toLowerCase(),
						status: "fail",
						detail: `check crashed: ${String(e?.message ?? e)}`,
						hint: "This is a bug in pi-checkup, not necessarily in your setup. Please report it with the message above.",
					},
				];
			}
		}),
	);
	return settled.flat();
}
