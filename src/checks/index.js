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

// A safety net, not the primary bound: every outbound call already has its own
// timeout (fetch 8s, DNS 4s, TCP 3s, subprocess 8s). This exists so a future
// check cannot reintroduce the unbounded-wait class of bug that a synchronous
// `dns.lookup` used to be.
export const MODULE_TIMEOUT_MS = 30_000;

/**
 * Parse an ignore list: `PI_CHECKUP_IGNORE="unreachable,packages:entries"`.
 * Entries match a row's id, its `Group:id` form, or its title.
 */
export function parseIgnore(raw) {
	return new Set(
		String(raw ?? "")
			.split(/[,\s]+/)
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

/**
 * Downgrade matching rows to `skip`, keeping the original status visible.
 *
 * Without this a single benign finding — an event-only package that registers no
 * tool, a launcher deliberately not on PATH — makes every future report
 * permanently non-clean, and a health check you learn to ignore is worse than no
 * health check. The suppression is never silent: the row keeps its detail and
 * says which status it replaced.
 */
export function applyIgnore(rows, ignore) {
	if (!ignore?.size) return rows;
	return rows.map((r) => {
		const keys = [r.id, `${r.group}:${r.id}`, r.title];
		if (!keys.some((k) => k && ignore.has(k))) return r;
		const { fix, fixTarget, ...rest } = r;
		return {
			...rest,
			status: "skip",
			detail: `ignored via PI_CHECKUP_IGNORE (would be ${r.status}): ${r.detail}`,
			hint: undefined,
		};
	});
}

/**
 * Run every check module against a context built by buildContext().
 * @param {object} ctx
 * @param {Array<{group?: string, run: Function}>} [modules] overridable so tests can inject a crashing module
 * @param {{ timeoutMs?: number, ignore?: Set<string> }} [options]
 */
export async function runChecks(ctx, modules = CHECKS, { timeoutMs = MODULE_TIMEOUT_MS, ignore } = {}) {
	const settled = await Promise.all(
		modules.map(async (mod) => {
			const name = mod.group ?? "Unknown";
			let timer;
			const timeout = new Promise((resolve) => {
				timer = setTimeout(() => {
					resolve([
						{
							group: name,
							id: `timeout:${name}`,
							title: name.toLowerCase(),
							status: "fail",
							detail: `check did not finish within ${Math.round(timeoutMs / 1000)}s`,
							hint: "Usually a blocked network call. Try --offline, or report this with the check name above.",
						},
					]);
				}, timeoutMs);
				// Do not hold the process open just to fire a timeout nobody needs.
				timer.unref?.();
			});
			try {
				const run = (async () => {
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
				})();
				return await Promise.race([run, timeout]);
			} finally {
				clearTimeout(timer);
			}
		}),
	);
	return applyIgnore(
		settled.flat(),
		ignore ?? parseIgnore(process.env.PI_CHECKUP_IGNORE),
	);
}
