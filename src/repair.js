// The only module in this package that writes to disk.
//
// Everything under ./checks/ reads and reports; repairs live here so the write
// surface stays small, auditable, and shared by the in-session `/checkup fix`
// and the standalone CLI. Both repairs back up the file they are about to
// change, and neither one deletes a package or disables an extension.
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

/** Collapse duplicate `packages` entries, preserving the first occurrence. */
export function applyDedupePackages(target) {
	const settings = readJson(target);
	if (!settings.ok) return unreadable(target, settings);
	if (!Array.isArray(settings.data?.packages)) return { ok: false, message: "no packages array to dedupe" };

	const seen = new Set();
	const kept = [];
	for (const spec of settings.data.packages) {
		const source = sourceOf(spec);
		if (typeof source !== "string") {
			kept.push(spec);
			continue;
		}
		if (seen.has(source)) continue;
		seen.add(source);
		kept.push(spec);
	}

	const removed = settings.data.packages.length - kept.length;
	if (removed === 0) return { ok: true, message: "nothing to dedupe" };

	const backup = copyBackup(target);
	settings.data.packages = kept;
	writeAtomic(target, `${JSON.stringify(settings.data, null, 2)}\n`);
	return {
		ok: true,
		message: `removed ${removed} duplicate entr${removed === 1 ? "y" : "ies"} from ${path.basename(target)} (backup: ${path.basename(backup)})`,
	};
}

/**
 * Drop settings entries whose package directory is not on disk.
 *
 * `root` is the agent directory Pi resolves `npm:` and `./` sources against. It
 * is passed in rather than derived from the target path: guessing it from
 * `dirname(target)` would resolve every entry under the wrong root if this were
 * ever pointed at a project-level settings file.
 */
export function applyPruneMissingPackages(target, root = path.dirname(target)) {
	const settings = readJson(target);
	if (!settings.ok) return unreadable(target, settings);
	if (!Array.isArray(settings.data?.packages)) return { ok: false, message: "no packages array to prune" };

	const kept = [];
	const removed = [];
	const unreadable = [];
	for (const spec of settings.data.packages) {
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

	if (!removed.length) return { ok: true, message: "nothing to prune" };

	const backup = copyBackup(target);
	settings.data.packages = kept;
	writeAtomic(target, `${JSON.stringify(settings.data, null, 2)}\n`);
	return {
		ok: true,
		message: `removed ${removed.length} entr${removed.length === 1 ? "y" : "ies"} with no directory on disk (${removed.slice(0, 3).join(", ")}${removed.length > 3 ? ", ..." : ""}); backup: ${path.basename(backup)}`,
	};
}

/** Named repairs, keyed by the `fix` field a check emits. */
const REPAIRS = {
	"restore-config": (target) => applyRestoreConfig(target),
	"dedupe-packages": (target) => applyDedupePackages(target),
	"prune-missing-packages": applyPruneMissingPackages,
};

export const REPAIR_NAMES = Object.keys(REPAIRS);

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
