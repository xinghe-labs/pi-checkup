// The only module in this package that writes to disk.
//
// Everything under ./checks/ reads and reports; repairs live here so the write
// surface stays small, auditable, and shared by the in-session `/checkup fix`
// and the standalone CLI. Both repairs back up the file they are about to
// change, and neither one deletes a package or disables an extension.
import fs from "node:fs";
import path from "node:path";
import { newestBackup, readJson, resolvePackageDir } from "./util.js";

function sourceOf(spec) {
	return typeof spec === "string" ? spec : spec?.source;
}

function stamp() {
	// Milliseconds are kept: two repairs in the same second would otherwise
	// write the same backup name and the second copy would clobber the first.
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
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
 */
function writeAtomic(target, content) {
	const tmp = `${target}.checkup-tmp-${stamp()}`;
	let mode;
	try {
		mode = fs.statSync(target).mode;
	} catch {
		mode = undefined;
	}
	try {
		fs.writeFileSync(tmp, content, { mode: mode ?? 0o600 });
		if (mode !== undefined) fs.chmodSync(tmp, mode);
		fs.renameSync(tmp, target);
	} catch (e) {
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
export function applyRestoreConfig(target) {
	const backup = newestBackup(target);
	if (!backup) return { ok: false, message: `no backup found for ${path.basename(target)}` };
	const parsed = readJson(backup);
	if (!parsed.ok) return { ok: false, message: `backup ${path.basename(backup)} is not valid JSON either` };
	const aside = `${target}.broken-${stamp()}`;
	fs.copyFileSync(target, aside);
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
	if (!settings.ok) return { ok: false, message: `${path.basename(target)} is not valid JSON` };
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

	const backup = `${target}.checkup-bak-${stamp()}`;
	fs.copyFileSync(target, backup);
	settings.data.packages = kept;
	writeAtomic(target, `${JSON.stringify(settings.data, null, 2)}\n`);
	return {
		ok: true,
		message: `removed ${removed} duplicate entr${removed === 1 ? "y" : "ies"} from ${path.basename(target)} (backup: ${path.basename(backup)})`,
	};
}

/** Drop settings entries whose package directory is not on disk. */
export function applyPruneMissingPackages(target) {
	const settings = readJson(target);
	if (!settings.ok) return { ok: false, message: `${path.basename(target)} is not valid JSON` };
	if (!Array.isArray(settings.data?.packages)) return { ok: false, message: "no packages array to prune" };

	// settings.json lives directly in the agent directory, which is the root
	// resolvePackageDir() resolves npm: specs against.
	const root = path.dirname(target);
	const kept = [];
	const removed = [];
	for (const spec of settings.data.packages) {
		const source = sourceOf(spec);
		const dir = resolvePackageDir(source, root);
		// Keep anything that cannot be resolved statically: git:/https: sources are
		// legitimate and dropping them would uninstall a working package.
		if (!dir) {
			kept.push(spec);
			continue;
		}
		let present = false;
		try {
			present = fs.statSync(dir).isDirectory();
		} catch {
			present = false;
		}
		if (present) kept.push(spec);
		else removed.push(String(source));
	}

	if (!removed.length) return { ok: true, message: "nothing to prune" };

	const backup = `${target}.checkup-bak-${stamp()}`;
	fs.copyFileSync(target, backup);
	settings.data.packages = kept;
	writeAtomic(target, `${JSON.stringify(settings.data, null, 2)}\n`);
	return {
		ok: true,
		message: `removed ${removed.length} entr${removed.length === 1 ? "y" : "ies"} with no directory on disk (${removed.slice(0, 3).join(", ")}${removed.length > 3 ? ", ..." : ""}); backup: ${path.basename(backup)}`,
	};
}

/** Named repairs, keyed by the `fix` field a check emits. */
const REPAIRS = {
	"restore-config": applyRestoreConfig,
	"dedupe-packages": applyDedupePackages,
	"prune-missing-packages": applyPruneMissingPackages,
};

export const REPAIR_NAMES = Object.keys(REPAIRS);

/**
 * Apply every fixable finding, at most once per (repair, file) pair.
 * A repair that throws is reported, not propagated — one failed write must not
 * stop the remaining repairs.
 */
export async function applyRepairs(findings) {
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
			applied.push(repair(finding.fixTarget));
		} catch (e) {
			applied.push({ ok: false, message: `${finding.title}: ${String(e?.message ?? e)}` });
		}
	}
	return applied;
}
