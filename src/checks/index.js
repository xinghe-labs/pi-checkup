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

import { scrubCredentials } from "../util.js";

export const CHECKS = [registry, packages, binaries, network, config, runtime];

// A safety net, not the primary bound: every outbound call already has its own
// timeout (fetch 8s, DNS 4s, TCP 3s, subprocess 8s). This exists so a future
// check cannot reintroduce the unbounded-wait class of bug that a synchronous
// `dns.lookup` used to be.
export const MODULE_TIMEOUT_MS = 30_000;

/**
 * Parse an ignore list: `PI_CHECKUP_IGNORE="unreachable,packages:entries"`.
 * Entries match a row's id, its `Group:id` form, or its title.
 *
 * Split on commas only: a title is a phrase (`shadowed names`), so treating
 * whitespace as a separator silently turned every multi-word title into two
 * entries that match nothing.
 */
export function parseIgnore(raw) {
	return new Set(
		String(raw ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
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
		// Lower-cased on both sides: the group in a report is "Binaries" while a
		// user types `binaries:unreachable`, and a suppression that silently does
		// nothing is worse than no suppression.
		const keys = [r.id, `${r.group}:${r.id}`, r.title].map((k) => (k ? k.toLowerCase() : k));
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
				// Deliberately not unref'd. An unref'd timer lets the event loop empty
				// while a check is still pending, so Node exits before the timeout
				// fires: no report, exit code 0. The timer only extends the process's
				// life while a check is genuinely hung, which is exactly when it must.
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
								// Scrubbed like every other error string: a check that throws
								// while handling a credentialed URL must not print it.
								detail: `check crashed: ${scrubCredentials(String(e?.message ?? e))}`,
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
	// ctx.env, not process.env: every other input a check sees goes through the
	// context seam, and reading one of them straight from the process made the
	// ignore list impossible to test without mutating the real environment.
	return applyIgnore(
		settled.flat(),
		ignore ?? parseIgnore(ctx.env?.PI_CHECKUP_IGNORE),
	);
}
