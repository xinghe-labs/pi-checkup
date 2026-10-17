// Binary checks — can you actually run what your packages ship?
//
// Two failures this catches, both invisible to `pi list`:
//   1. A dangling symlink in node_modules/.bin (postinstall blocked by npm,
//      optional native dependency skipped for this platform).
//   2. A package's command name is shadowed by an unrelated program earlier on
//      PATH, so the name resolves to something else entirely.
import path from "node:path";
import fs from "node:fs";
import { exists, isMissing, normalizePath, readJson, resolvePackageDir, sourceOf, whichAll } from "../util.js";

export const group = "Binaries";

/**
 * npm links package commands without a leading dot, so a dot-prefixed entry in
 * .bin is a leftover of npm's atomic install: it writes `.<name>-<random>` and
 * renames it into place. Seeing one means an install is running right now, or was
 * interrupted — not that a package is broken. Reporting those as broken commands
 * made a checkup run during `pi install` look like a damaged installation.
 */
function isStagingArtifact(name) {
	return name.startsWith(".") && /-[A-Za-z0-9]{6,12}$/.test(name);
}

function stagingRow(staging, danglingStaging) {
	if (!staging.length) return null;
	const broken = danglingStaging.length;
	return {
		group,
		id: "staging",
		title: "install leftovers",
		status: broken ? "warn" : "ok",
		detail: broken
			? `${broken} of ${staging.length} leftover staging link(s) do not resolve: ${staging.slice(0, 6).join(", ")}`
			: `${staging.length} leftover staging link(s), all resolve`,
		hint: broken ? "An install was interrupted. Re-run it for the affected packages, or delete these entries from node_modules/.bin." : undefined,
	};
}

function danglingRow(dangling, entryCount) {
	if (dangling.length) {
		return {
			group,
			id: "dangling",
			title: "dangling links",
			status: "fail",
			detail: `${dangling.length} broken: ${dangling.slice(0, 6).join(", ")}`,
			hint: "Usually a blocked postinstall or a skipped optional native dependency. Reinstall the owning package with install scripts approved.",
		};
	}
	// Nothing to inspect is not a pass: an empty .bin used to print a green tick
	// over zero entries.
	if (!entryCount) {
		return { group, id: "dangling", title: "dangling links", status: "skip", detail: "no entries in .bin to check" };
	}
	return { group, id: "dangling", title: "dangling links", status: "ok", detail: `${entryCount} entries all resolve` };
}

/** bin names that installed packages declare in their own manifests. */
function declaredBins(settings, root) {
	const names = new Set();
	for (const spec of settings?.packages ?? []) {
		const source = sourceOf(spec);
		if (!source) continue;
		const dir = resolvePackageDir(source, root);
		if (!dir) continue;
		const manifest = readJson(path.join(dir, "package.json"));
		if (!manifest.ok) continue;
		const bin = manifest.data?.bin;
		if (!bin) continue;
		if (typeof bin === "string") {
			const base = String(manifest.data?.name ?? "").split("/").pop();
			if (base) names.add(base);
			continue;
		}
		for (const key of Object.keys(bin)) names.add(key);
	}
	return names;
}

export async function run({ settings, agentDir: root }) {
	const binDir = path.join(root, "npm", "node_modules", ".bin");
	if (!exists(binDir)) {
		// An unreadable .bin is not an empty one. Saying "no npm packages
		// installed" for an EACCES sends the user looking in the wrong place.
		return [
			{
				group,
				id: "bin-dir",
				title: "bin dir",
				status: isMissing(binDir) ? "skip" : "warn",
				detail: isMissing(binDir) ? `${binDir} does not exist (no npm packages installed)` : `cannot read ${binDir}`,
			},
		];
	}

	let entries;
	try {
		entries = fs.readdirSync(binDir);
	} catch (e) {
		return [
			{
				group,
				id: "bin-dir",
				title: "bin dir",
				status: "warn",
				detail: `cannot read ${binDir}: ${String(e?.message ?? e)}`,
			},
		];
	}

	// --- dangling symlinks -------------------------------------------------
	const dangling = [];
	const staging = [];
	const danglingStaging = [];
	for (const entry of entries) {
		const full = path.join(binDir, entry);
		let isLink = false;
		try {
			isLink = fs.lstatSync(full).isSymbolicLink();
		} catch {
			continue;
		}
		const broken = isLink && !exists(full);
		if (isStagingArtifact(entry)) {
			staging.push(entry);
			if (broken) danglingStaging.push(entry);
			continue;
		}
		if (broken) dangling.push(entry);
	}

	// Real breakage stays a failure; a half-finished install is reported as its
	// own thing, because the fix is "let the install finish", not "reinstall".
	const stagingFindings = stagingRow(staging, danglingStaging);
	const results = [danglingRow(dangling, entries.length - staging.length), ...(stagingFindings ? [stagingFindings] : [])];

	// --- declared but never linked -----------------------------------------
	// A package can declare a `bin` and still have no shim, because npm skips
	// linking when install scripts are blocked. Driven off the manifests, not off
	// .bin, so a command that was never installed is not silently ignored.
	const ownBins = declaredBins(settings, root);
	const entryNames = new Set(entries.map((e) => e.replace(/\.(cmd|ps1|exe|bat)$/i, "")));
	const missingShims = [...ownBins].filter((name) => !entryNames.has(name)).sort();
	if (missingShims.length) {
		results.push({
			group,
			id: "missing-shims",
			title: "missing shims",
			status: "warn",
			detail: `${missingShims.length} declared command(s) never linked into .bin: ${missingShims.slice(0, 6).join(", ")}`,
			hint: "npm creates these links during install. Reinstall the owning package without --ignore-scripts.",
		});
	}

	// --- shadowing and reachability ----------------------------------------
	const shadowed = [];
	const unreachable = [];

	for (const entry of ownBins) {
		// Both findings below are about commands a Pi package advertises. A
		// transitive dev dependency that happens to be shadowed is not the user's
		// problem and reporting it made a healthy install look broken forever.
		const hits = whichAll(entry);
		if (!hits.length) {
			// A missing shim is already reported above with a better hint; listing it
			// here too would double-count the same root cause.
			if (!missingShims.includes(entry)) unreachable.push(entry);
			continue;
		}
		// realpath on both sides: a symlinked ~/.pi (or /var on macOS) is the same
		// file, and comparing raw strings called every package bin shadowed.
		if (normalizePath(hits[0]) !== normalizePath(path.join(binDir, entry))) shadowed.push({ name: entry, actual: hits[0] });
	}

	const shownShadow = shadowed
		.slice(0, 4)
		.map((s) => `${s.name} resolves to ${s.actual}`)
		.join("; ");
	const moreShadow = shadowed.length > 4 ? `; and ${shadowed.length - 4} more` : "";

	results.push(
		shadowed.length
			? {
					group,
					id: "shadowed",
					title: "shadowed names",
					status: "warn",
					detail: shownShadow + moreShadow,
					hint: "Running the bare name in a shell starts a different program. Call the package binary by full path, or reorder PATH.",
				}
			: { group, id: "shadowed", title: "shadowed names", status: "ok", detail: "none" },
	);

	if (unreachable.length) {
		results.push({
			group,
			id: "unreachable",
			title: "unreachable bins",
			status: "warn",
			detail: `${unreachable.length} package command(s) not on PATH: ${unreachable.slice(0, 6).join(", ")}`,
			hint: "Extensions that call these by full path still work; you and the agent cannot invoke them by name.",
		});
	}

	return results;
}
