// Binary checks — can you actually run what your packages ship?
//
// Two failures this catches, both invisible to `pi list`:
//   1. A dangling symlink in node_modules/.bin (postinstall blocked by npm,
//      optional native dependency skipped for this platform).
//   2. A package's command name is shadowed by an unrelated program earlier on
//      PATH, so the name resolves to something else entirely.
import path from "node:path";
import fs from "node:fs";
import {
	describeFsError,
	exists,
	isMissing,
	isWindows,
	readJson,
	resolvePackageDir,
	sameCommand,
	sourceOf,
	truncateList,
	whichAll,
} from "../util.js";

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

function stagingRow(staging, danglingStaging, unreadableStaging = []) {
	if (!staging.length) return null;
	// `!exists()` is not `isMissing()`: a link this process cannot follow is not
	// proof that it is gone, and it is not proof that it resolves either.
	const broken = danglingStaging.length;
	const unclear = unreadableStaging.length;
	return {
		group,
		id: "staging",
		title: "install leftovers",
		status: broken || unclear ? "warn" : "ok",
		detail: broken
			? `${broken} of ${staging.length} leftover staging link(s) do not resolve: ${names(staging, 6)}`
			: unclear
				? `${staging.length} leftover staging link(s), ${unclear} of them could not be followed`
				: `${staging.length} leftover staging link(s), all resolve`,
		hint: broken ? "An install was interrupted. Re-run it for the affected packages, or delete these entries from node_modules/.bin." : undefined,
	};
}

function danglingRow(dangling, linkCount, entryCount, unreadable = 0) {
	if (dangling.length) {
		return {
			group,
			id: "dangling",
			title: "dangling links",
			status: "fail",
			detail: `${dangling.length} broken: ${names(dangling, 6)}`,
			// Deliberately-declined install scripts are a legitimate state, but the
			// row stays a failure — the command it names is genuinely broken — so the
			// way out is named instead of a status downgrade.
			hint: "Usually a blocked postinstall or a skipped optional native dependency. Reinstall the owning package with install scripts approved, or, if you declined them on purpose, silence the row with PI_CHECKUP_IGNORE=dangling.",
		};
	}
	// Nothing to inspect is not a pass: an empty .bin used to print a green tick
	// over zero entries.
	if (!entryCount) {
		return { group, id: "dangling", title: "dangling links", status: "skip", detail: "no command links in .bin to check" };
	}
	// npm writes shims as plain files on Windows, so a populated .bin can contain
	// zero symlinks. Counting entries instead of links printed "19 entries all
	// resolve" having inspected nothing.
	if (!linkCount) {
		return {
			group,
			id: "dangling",
			title: "dangling links",
			status: "skip",
			detail: `${entryCount} entries in .bin, none of them links${isWindows ? " (Windows shims are plain files)" : ""}`,
		};
	}
	// A link this process could not follow is not a link that resolved. Saying
	// "N links all resolve" here while the row below warns about the same links
	// was a green tick contradicting a warning in the same report.
	const resolved = linkCount - unreadable;
	if (resolved !== linkCount) {
		return {
			group,
			id: "dangling",
			title: "dangling links",
			status: "warn",
			detail: `${resolved} of ${linkCount} links resolve — ${unreadable} could not be followed`,
		};
	}
	const noun = linkCount === 1 ? "link" : "links";
	return { group, id: "dangling", title: "dangling links", status: "ok", detail: `${linkCount} ${noun} all resolve` };
}

/** bin names that installed packages declare in their own manifests. */
function declaredBins(settings, root) {
	const names = new Set();
	// Guard the type: `"packages": {"a": "npm:x"}` is not iterable, and the throw
	// replaced the whole Binaries group with a crash row that blamed pi-checkup
	// for a hand-edited settings file.
	const specs = Array.isArray(settings?.packages) ? settings.packages : [];
	for (const spec of specs) {
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

/**
 * A list cut to six names without a marker reads as the whole list, and the count
 * in front of it then contradicts what the reader can see.
 */
function names(list, max) {
	// One truncation helper for the whole package: the marker has to look the same
	// in every row, and it has to say how much was left out.
	return truncateList(list, max);
}

export async function run({ settings, settingsLoaded = true, agentDir: root, binDir = path.join(root, "npm", "node_modules", ".bin"), env = process.env }) {
	// Computed before the early returns: a package whose bins were never linked is
	// exactly the state where .bin is missing or thin, and the old early return
	// reported "no npm packages installed" without ever reading settings.
	const ownBins = declaredBins(settings, root);

	if (!exists(binDir)) {
		// An unreadable .bin is not an empty one. Saying "no npm packages
		// installed" for an EACCES sends the user looking in the wrong place.
		const missing = isMissing(binDir);
		const declared = ownBins.size;
		const rows = [
			{
				group,
				id: "bin-dir",
				title: "bin dir",
				status: missing ? "skip" : "warn",
				detail: missing
					? `${binDir} does not exist${declared ? ` (${declared} declared command(s) therefore have no shim)` : ""}`
					: `cannot read ${binDir}`,
				hint: missing
					? declared
						? "npm creates these links during install. Reinstall the owning package without --ignore-scripts."
						: "Nothing is missing yet: no package in settings.json declares a command, and the directory appears with the first `pi install`."
					: "A permissions or filesystem problem, not a missing install. Check ownership of the agent directory.",
			},
		];
		if (declared) {
			rows.push({
				group,
				id: "missing-shims",
				title: "missing shims",
				status: "warn",
				detail: `${declared} declared command(s) never linked into .bin: ${names([...ownBins].sort(), 6)}`,
				hint: "npm creates these links during install. Reinstall the owning package without --ignore-scripts.",
			});
		}
		return rows;
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
				// Not Node's message: it carries the errno and the raw syscall.
				detail: `cannot read ${binDir}: ${describeFsError(e)}`,
				hint: "Nothing below this point was checked. Fix the permissions on that directory and re-run.",
			},
		];
	}

	// --- dangling symlinks -------------------------------------------------
	const dangling = [];
	const unreadableLinks = [];
	let linkCount = 0;
	const staging = [];
	const danglingStaging = [];
	const unreadableStaging = [];
	for (const entry of entries) {
		const full = path.join(binDir, entry);
		let isLink = false;
		try {
			isLink = fs.lstatSync(full).isSymbolicLink();
		} catch {
			continue;
		}
		if (!isLink) continue;
		// ENOENT proves the target is gone. EACCES or ELOOP proves only that this
		// process could not follow it, and reporting those as "broken: reinstall the
		// package" blamed the package for a permissions problem.
		const broken = isMissing(full);
		const unreadable = !broken && !exists(full);
		if (isStagingArtifact(entry)) {
			staging.push(entry);
			if (broken) danglingStaging.push(entry);
			else if (unreadable) unreadableStaging.push(entry);
			continue;
		}
		// Counted after the staging branch: a half-written npm temp link is not a
		// command anyone can run, so it cannot be part of "N links all resolve".
		linkCount++;
		if (broken) dangling.push(entry);
		else if (unreadable) unreadableLinks.push(entry);
	}

	// Real breakage stays a failure; a half-finished install is reported as its
	// own thing, because the fix is "let the install finish", not "reinstall".
	const stagingFindings = stagingRow(staging, danglingStaging, unreadableStaging);
	const results = [
		danglingRow(dangling, linkCount, entries.length - staging.length, unreadableLinks.length),
		...(stagingFindings ? [stagingFindings] : []),
	];
	if (unreadableLinks.length) {
		results.push({
			group,
			id: "unreadable-links",
			title: "unreadable links",
			status: "warn",
			detail: `${unreadableLinks.length} link(s) could not be resolved: ${names(unreadableLinks, 6)}`,
			hint: "Not proven broken — the target may exist but be unreadable for this user. Check ownership of the package directory.",
		});
	}

	// --- declared but never linked -----------------------------------------
	// A package can declare a `bin` and still have no shim, because npm skips
	// linking when install scripts are blocked. Driven off the manifests, not off
	// .bin, so a command that was never installed is not silently ignored.
	const entryNames = new Set(entries.map((e) => e.replace(/\.(cmd|ps1|exe|bat)$/i, "")));
	const missingShims = [...ownBins].filter((name) => !entryNames.has(name)).sort();
	if (missingShims.length) {
		results.push({
			group,
			id: "missing-shims",
			title: "missing shims",
			status: "warn",
			detail: `${missingShims.length} declared command(s) never linked into .bin: ${names(missingShims, 6)}`,
			hint: "npm creates these links during install. Reinstall the owning package without --ignore-scripts.",
		});
	}

	// --- shadowing and reachability ----------------------------------------
	const shadowed = [];
	const unreachable = [];

	// How many of the declared commands actually resolved on PATH. Shadowing is a
	// question that can only be answered for a command PATH found, and `ownBins`
	// being non-empty is not the same thing: a package whose shim is missing or
	// whose directory never made it into PATH leaves zero commands to compare.
	let resolved = 0;
	for (const entry of ownBins) {
		// Both findings below are about commands a Pi package advertises. A
		// transitive dev dependency that happens to be shadowed is not the user's
		// problem and reporting it made a healthy install look broken forever.
		const hits = whichAll(entry, env);
		if (!hits.length) {
			// A missing shim is already reported above with a better hint; listing it
			// here too would double-count the same root cause.
			if (!missingShims.includes(entry)) unreachable.push(entry);
			continue;
		}
		// realpath on both sides: a symlinked ~/.pi (or /var on macOS) is the same
		// file, and comparing raw strings called every package bin shadowed.
		// sameCommand also folds the Windows shim extension, where PATH resolution
		// answers `foo.CMD` for a link named `foo`.
		resolved++;
		if (!sameCommand(hits[0], path.join(binDir, entry))) shadowed.push({ name: entry, actual: hits[0] });
	}

	const shownShadow = shadowed
		.slice(0, 4)
		.map((s) => `${s.name} resolves to ${s.actual}`)
		.join("; ");
	const moreShadow = shadowed.length > 4 ? `; and ${shadowed.length - 4} more` : "";

	// A green tick over zero inspected commands is the same hole the dangling row
	// closes: an extension-only install declares no bin, so nothing was resolved.
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
			: ownBins.size === 0
				? {
						group,
						id: "shadowed",
						title: "shadowed names",
						status: "skip",
						// settings.json that does not parse also arrives here as an empty set.
						// Saying "no package command declared" asserted a fact about the
						// config two groups below a row saying the file could not be read.
						detail: settingsLoaded ? "no package command declared" : "settings.json could not be inspected — no package command list to check",
					}
				: resolved === 0
					? // Nothing resolved, so nothing was compared. "none" here was a green
						// tick over zero inspected commands, next to a row saying the
						// commands could not be found — the same vacuous pass the
						// `dangling` row closes.
						{ group, id: "shadowed", title: "shadowed names", status: "skip", detail: "no package command resolved on PATH" }
					: { group, id: "shadowed", title: "shadowed names", status: "ok", detail: "none" },
	);

	if (unreachable.length) {
		results.push({
			group,
			id: "unreachable",
			title: "unreachable bins",
			status: "warn",
			detail: `${unreachable.length} package command(s) not on PATH: ${names(unreachable, 6)}`,
			// The file exists — it is just not on PATH — so the fix is the directory,
			// not a reinstall. Without this the row reads as "something is broken"
			// with no way to tell what to do about it.
			// The file exists — it is just not on PATH — so the fix is the directory,
			// not a reinstall. Without this the row reads as "something is broken"
			// with no way to tell what to do about it. The suppression is named here
			// because this is the one row a healthy install carries for good.
			hint: `Pi installs package commands into ${binDir} without adding it to PATH. Extensions that call them by full path still work; to use them by name, add that directory to PATH or run them with npx. If this is the state you want, silence the row with PI_CHECKUP_IGNORE=unreachable.`,
		});
	}

	return results;
}
