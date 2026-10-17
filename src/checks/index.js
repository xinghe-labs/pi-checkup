// The check registry, shared by the in-session command and the standalone CLI.
//
// A module that throws becomes a reported finding instead of taking the whole
// report down — a broken diagnostic should still tell you which part broke.
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
 */
export async function runChecks(ctx) {
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
