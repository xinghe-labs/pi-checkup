// The only module in this package that writes to disk.
//
// Everything under ./checks/ reads and reports; repairs live here so the write
// surface stays small, auditable, and shared by the in-session `/checkup fix`
// and the standalone CLI. Every repair backs up the file it is about to change,
// and none of them deletes a package or disables an extension.
import fs from "node:fs";
import path from "node:path";
import { isMissing, newestBackup, readJson, resolvePackageDir, sourceOf } from "./util.js";

function stamp() {
	// Milliseconds are kept: two repairs in the same second would otherwise
	// write the same backup name and the second copy would clobber the first.
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
}

/**
 * Copy `target` to a fresh timestamped sibling, never overwriting an existing one.
 *
 * Two repairs can land in the same millisecond, and two concurrent checkup
 * processes can collide on the name entirely; COPYFILE_EXCL turns that from a
 * silent loss of a recovery point into a retry.
 */
function copyBackup(target, label = "checkup-bak") {
	const base = `${target}.${label}-${stamp()}`;
	for (let i = 0; i < 50; i++) {
		const candidate = i === 0 ? base : `${base}-${i}`;
		try {
			fs.copyFileSync(target, candidate, fs.constants.COPYFILE_EXCL);
			return candidate;
		} catch (e) {
			if (e?.code !== "EEXIST") throw e;
		}
	}
	throw new Error(`could not find a free backup name for ${path.basename(target)}`);
}

/** Flush a directory entry so a rename survives a power loss. Best effort. */
function syncDir(dir) {
	let fd;
	try {
		fd = fs.openSync(dir, "r");
		fs.fsyncSync(fd);
	} catch {
		// Not supported on Windows, and not worth failing a successful repair over.
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* already gone */
			}
		}
	}
}

/**
 * Write a file without ever leaving a half-written one behind.
 *
 * `writeFileSync` truncates first, so a crash or a full disk mid-write leaves a
 * corrupt config — the exact failure this package exists to detect, caused by
 * the repair. Writing a sibling temp file and renaming over the target is
 * atomic on POSIX and on Windows (rename replaces an existing file there too).
 * The original mode is carried over, because a models.json that was chmod 600
 * must not come back 644.
 *
 * The temp file is fsynced before the rename and the directory after it, so a
 * power loss cannot leave the rename visible while the new content is not.
 */
function writeAtomic(target, content) {
	// A dotfiles-style install keeps settings.json as a symlink into a repo. A
	// plain rename over `target` would replace the symlink with a regular file and
	// silently detach the config from its repository, so the write lands on the
	// real file instead.
	let real = target;
	try {
		real = fs.realpathSync(target);
	} catch {
		// Missing or dangling: the target itself is the only path there is.
	}

	let mode;
	try {
		mode = fs.statSync(real).mode;
	} catch {
		mode = undefined;
	}

	const base = `${real}.checkup-tmp-${stamp()}`;
	let fd;
	let tmp;
	for (let i = 0; i < 50 && fd === undefined; i++) {
		const candidate = i === 0 ? base : `${base}-${i}`;
		try {
			fd = fs.openSync(candidate, "wx", mode ?? 0o600);
			tmp = candidate;
		} catch (e) {
			if (e?.code !== "EEXIST") throw e;
		}
	}
	if (fd === undefined) throw new Error(`could not create a temp file next to ${path.basename(real)}`);

	try {
		fs.writeFileSync(fd, content);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		if (mode !== undefined) fs.chmodSync(tmp, mode);
		fs.renameSync(tmp, real);
		syncDir(path.dirname(real));
	} catch (e) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* already closed */
			}
		}
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// Nothing useful to do; the rename failure below is the real error.
		}
		throw e;
	}
}

/**
 * Replace a config file that is no longer valid JSON with its newest backup.
 * The broken copy is kept beside it, so this is reversible by hand.
 */
/**
 * Why a config file could not be used, in the terms the user needs.
 *
 * "is not valid JSON" for a file that simply is not there sends the reader
 * looking for a syntax error that does not exist.
 */
function unreadable(target, parsed) {
	const name = path.basename(target);
	if (parsed.missing) return { ok: false, message: `${name} does not exist` };
	if (parsed.invalid) return { ok: false, message: `${name} is not valid JSON: ${parsed.error}` };
	return { ok: false, message: `${name} could not be read: ${parsed.error}` };
}

export function applyRestoreConfig(target) {
	// Re-read before overwriting. The decision to restore was made when the check
	// ran, and in-session the confirmation prompt can sit open indefinitely: if the
	// user repaired the file by hand in that window, writing the older backup over
	// it would undo the fix.
	const current = readJson(target);
	if (current.ok) return { ok: false, message: `${path.basename(target)} is valid JSON again — nothing to restore` };
	const backup = newestBackup(target);
	if (!backup) return { ok: false, message: `no backup found for ${path.basename(target)}` };
	const parsed = readJson(backup);
	if (!parsed.ok) return { ok: false, message: `backup ${path.basename(backup)} is not valid JSON either` };
	const aside = copyBackup(target, "broken");
	// The backup is valid JSON (checked above), so restoring its bytes verbatim
	// keeps any formatting the user had.
	writeAtomic(target, fs.readFileSync(backup, "utf8"));
	return {
		ok: true,
		message: `restored ${path.basename(target)} from ${path.basename(backup)} (broken copy kept as ${path.basename(aside)})`,
	};
}

/**
 * Collapse duplicate `packages` entries, preserving the first occurrence.
 *
 * Only an entry byte-identical to the one already kept is dropped. Two entries
 * for the same source in different shapes — `"npm:a"` next to
 * `{"source": "npm:a", "enabled": false}` — carry different intent, and deleting
 * the second one silently changed what Pi loads. The backup would have made it
 * recoverable, but a repair that needs its backup is not a repair.
 */
export function applyDedupePackages(target) {
	const settings = readJson(target);
	if (!settings.ok) return unreadable(target, settings);
	if (!Array.isArray(settings.data?.packages)) return { ok: false, message: "no packages array to dedupe" };

	const plan = dedupePlan(settings.data.packages);
	const suffix = (mixed) =>
		mixed ? ` (${mixed} entr${mixed === 1 ? "y" : "ies"} share a source but differ in shape and were left alone)` : "";
	if (!plan.removed) return { ok: true, message: `nothing to dedupe${suffix(plan.mixed)}` };

	// The read above already happened after the confirmation prompt, and every
	// step from here to writeAtomic is synchronous, so the file cannot change in
	// between — a second read would prove nothing. Backing up before the plan was
	// known left a stray `.checkup-bak-*` beside a healthy config on runs that
	// repaired nothing.
	const backup = copyBackup(target);
	settings.data.packages = plan.kept;
	writeAtomic(target, `${JSON.stringify(settings.data, null, 2)}\n`);
	return {
		ok: true,
		message: `removed ${plan.removed} duplicate entr${plan.removed === 1 ? "y" : "ies"} from ${path.basename(target)}${suffix(plan.mixed)} (backup: ${path.basename(backup)})`,
	};
}

/** Which entries a dedupe would keep, without touching the file. */
function dedupePlan(packages) {
	const seen = new Map();
	const kept = [];
	let removed = 0;
	let mixed = 0;
	for (const spec of packages) {
		const source = sourceOf(spec);
		if (typeof source !== "string") {
			kept.push(spec);
			continue;
		}
		if (!seen.has(source)) {
			seen.set(source, spec);
			kept.push(spec);
			continue;
		}
		if (JSON.stringify(seen.get(source)) === JSON.stringify(spec)) {
			removed++;
			continue;
		}
		mixed++;
		kept.push(spec);
	}
	return { kept, removed, mixed };
}

/**
 * Drop settings entries whose package directory is not on disk.
 *
 * `root` is the agent directory Pi resolves `npm:` and `./` sources against. It
 * is passed in rather than derived from the target path: guessing it from
 * `dirname(target)` would resolve every entry under the wrong root if this were
 * ever pointed at a project-level settings file.
 */
export function applyPruneMissingPackages(target, root) {
	// Not defaulted: a wrong root makes every entry look missing, and this repair
	// deletes what it cannot resolve.
	if (!root) throw new Error("applyPruneMissingPackages needs the agent directory to resolve packages against");
	const settings = readJson(target);
	if (!settings.ok) return unreadable(target, settings);
	if (!Array.isArray(settings.data?.packages)) return { ok: false, message: "no packages array to prune" };

	const plan = prunePlan(settings.data.packages, root);
	if (!plan.removed.length) return { ok: true, message: "nothing to prune" };
	// A wrong agent directory — a mistyped PI_CODING_AGENT_DIR, a second profile,
	// a Pi layout that keeps packages elsewhere — makes every entry look missing.
	// Emptying the list would leave Pi booting with no packages and no error, so
	// the repair refuses instead of trusting its own resolution blindly.
	if (plan.removed.length === settings.data.packages.length) {
		return {
			ok: false,
			message: `all ${plan.removed.length} package entr${plan.removed.length === 1 ? "y looks" : "ies look"} missing — refusing to empty the list. Check that the agent directory is the one Pi uses (PI_CODING_AGENT_DIR).`,
		};
	}

	// Same reasoning as dedupe: the read above is post-prompt, and the rest of
	// this function is synchronous.
	const backup = copyBackup(target);
	settings.data.packages = plan.kept;
	writeAtomic(target, `${JSON.stringify(settings.data, null, 2)}\n`);
	return {
		ok: true,
		message: `removed ${plan.removed.length} entr${plan.removed.length === 1 ? "y" : "ies"} with no directory on disk (${plan.removed.slice(0, 3).join(", ")}${plan.removed.length > 3 ? ", ..." : ""}); backup: ${path.basename(backup)}`,
	};
}

/** Which entries a prune would drop, without touching the file. */
function prunePlan(packages, root) {
	const kept = [];
	const removed = [];
	for (const spec of packages) {
		const source = sourceOf(spec);
		const dir = resolvePackageDir(source, root);
		// Keep anything that cannot be resolved statically: git:/https: sources are
		// legitimate and dropping them would uninstall a working package.
		if (!dir) {
			kept.push(spec);
			continue;
		}
		if (!isMissing(dir)) {
			// Present, or present-but-unreadable. Only a path that is genuinely gone
			// justifies deleting the user's settings entry.
			kept.push(spec);
			continue;
		}
		removed.push(String(source));
	}
	return { kept, removed };
}

/** Named repairs, keyed by the `fix` field a check emits. */
const REPAIRS = {
	"restore-config": (target) => applyRestoreConfig(target),
	"dedupe-packages": (target) => applyDedupePackages(target),
	"prune-missing-packages": applyPruneMissingPackages,
};


/**
 * Apply every fixable finding, at most once per (repair, file) pair.
 * A repair that throws is reported, not propagated — one failed write must not
 * stop the remaining repairs.
 *
 * `agentDir` is threaded through to the prune repair so package directories are
 * resolved against the same root the checks inspected.
 */
export async function applyRepairs(findings, { agentDir } = {}) {
	const applied = [];
	const seen = new Set();
	for (const finding of findings) {
		const key = `${finding.fix}:${finding.fixTarget}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const repair = REPAIRS[finding.fix];
		if (!repair) {
			applied.push({ ok: false, message: `${finding.title}: unknown repair "${finding.fix}"` });
			continue;
		}
		try {
			applied.push(repair(finding.fixTarget, agentDir));
		} catch (e) {
			applied.push({ ok: false, message: `${finding.title}: ${String(e?.message ?? e)}` });
		}
	}
	return applied;
}
