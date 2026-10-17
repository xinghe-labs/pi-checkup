// Package checks — are the packages in settings.json actually on disk, and do
// the files their manifests point at exist?
//
// This catches the failure that happens after a good install: a partial
// extraction, a manual `rm -rf` in node_modules, a git checkout that moved the
// entry file, or a package whose manifest points at a build output that was
// never committed.
import path from "node:path";
import fs from "node:fs";
import { globExists, readJson, resolvePackageDir, sourceOf } from "../util.js";

export const group = "Packages";

export async function run({ settings, agentDir: root, settingsFile, settingsSource }) {
	const results = [];

	// A hand-edited settings.json can put a string here, and iterating that would
	// walk it character by character and report seven unverifiable "sources".
	const declared = settings?.packages;
	const specs = Array.isArray(declared) ? declared : [];

	if (!specs.length) {
		// `[]` is truthy, so testing the value itself reported a fresh install with
		// an empty package list as a malformed config. The question is whether it
		// is a list, not whether it exists.
		const malformed = declared !== undefined && !Array.isArray(declared);
		return [
			{
				group,
				id: "installed",
				title: "installed",
				status: "skip",
				detail: malformed ? "settings.json `packages` is not a list" : "no packages in settings.json",
			},
		];
	}

	const missingDir = [];
	const unreadableDir = [];
	const brokenManifest = [];
	const missingEntry = [];
	const unverifiable = [];
	// Counted separately so a check that had nothing to look at reports skipped
	// instead of printing a green tick over zero inspected packages.
	let present = 0;
	let manifestRead = 0;
	let entryChecked = 0;

	for (const spec of specs) {
		const source = sourceOf(spec);
		const dir = resolvePackageDir(source, root);
		if (!dir) {
			unverifiable.push(String(source));
			continue;
		}
		let stat;
		try {
			stat = fs.statSync(dir);
		} catch (e) {
			// Only "it is not there" justifies offering to delete the settings entry.
			// EACCES/EPERM/ELOOP mean the package may be perfectly fine and this
			// process simply cannot see it; treating those as missing turned a
			// permission problem into a destructive repair.
			const code = e?.code;
			if (code === "ENOENT" || code === "ENOTDIR") missingDir.push(String(source));
			else unreadableDir.push(`${source} (${code ?? "error"})`);
			continue;
		}
		if (!stat.isDirectory()) {
			missingDir.push(String(source));
			continue;
		}
		present++;
		const manifest = readJson(path.join(dir, "package.json"));
		if (!manifest.ok) {
			brokenManifest.push(String(source));
			continue;
		}
		manifestRead++;
		const declared = manifest.data?.pi?.extensions;
		if (!declared) continue; // convention-directory package, nothing to verify
		const list = Array.isArray(declared) ? declared : [declared];
		if (!list.length) continue; // declared nothing, so there is nothing to verify
		entryChecked++;
		const missing = list.filter((entry) => !globExists(dir, entry));
		if (missing.length) missingEntry.push(`${source} -> ${missing.join(", ")}`);
	}

	const preview = (list, n) => list.slice(0, n).join(", ") + (list.length > n ? ", ..." : "");
	/** One finding row, so the checks below stay flat and readable. */
	const row = (id, title, status, detail, extra = {}) => ({ group, id, title, status, detail, ...extra });

	// --- package directories -----------------------------------------------
	// The prune repair is only safe when settings came from the file the repair
	// would rewrite. In-session the settings may come from the running process, so
	// editing the on-disk copy could either miss the problem or hit a stale file.
	const canPrune = Boolean(settingsFile) && settingsSource !== "runtime";
	if (missingDir.length) {
		results.push(
			row("dirs", "package dirs", "fail", `${missingDir.length} missing from node_modules: ${preview(missingDir, 3)}`, {
				hint: "Run `pi install` again for the listed packages, or remove them from settings.json.",
				// Dropping the entry is the only repair a static checker can offer;
				// reinstalling needs the package manager and the network.
				fix: canPrune ? "prune-missing-packages" : undefined,
				fixTarget: canPrune ? settingsFile : undefined,
			}),
		);
	} else if (present) {
		results.push(row("dirs", "package dirs", "ok", `${present} present`));
	} else if (unreadableDir.length) {
		results.push(row("dirs", "package dirs", "skip", "no package directory could be opened"));
	} else {
		// Every entry was resolved by Pi itself, so no directory was ever opened.
		results.push(row("dirs", "package dirs", "skip", "no package directory could be inspected"));
	}

	// Reported separately and deliberately without a `fix`: the package is
	// probably fine, so deleting its settings entry would be the wrong repair.
	if (unreadableDir.length) {
		results.push(
			row("unreadable", "unreadable dirs", "warn", `${unreadableDir.length} package dir(s) could not be opened: ${preview(unreadableDir, 3)}`, {
				hint: "A permissions or filesystem problem, not a missing package. Check ownership of the agent directory.",
			}),
		);
	}

	// --- manifests ---------------------------------------------------------
	if (brokenManifest.length) {
		results.push(
			row(
				"manifests",
				"manifests",
				"fail",
				`${brokenManifest.length} unreadable package.json: ${preview(brokenManifest, 3)}`,
				{
					// A run that overlaps an install sees a manifest mid-rename. Saying so
					// is the difference between "reinstall everything" and "wait 30 seconds".
					hint: "Reinstall the affected packages. If an install or update is running right now, re-run once it finishes.",
				},
			),
		);
	} else if (manifestRead) {
		results.push(row("manifests", "manifests", "ok", `${manifestRead} readable`));
	} else {
		// Nothing was opened, so there is nothing to be green about.
		results.push(row("manifests", "manifests", "skip", "nothing to inspect"));
	}

	// --- entry files -------------------------------------------------------
	if (missingEntry.length) {
		results.push(
			row(
				"entries",
				"entry files",
				"fail",
				`${missingEntry.length} manifest(s) point at files that do not exist: ${preview(missingEntry, 2)}`,
				{ hint: "The package is installed but cannot load. Reinstall it, or check whether it needs a build step." },
			),
		);
	} else if (entryChecked) {
		results.push(row("entries", "entry files", "ok", `${entryChecked} manifest(s) resolve`));
	} else {
		results.push(row("entries", "entry files", "skip", "no package declares an entry file"));
	}

	if (unverifiable.length) {
		results.push(
			row(
				"unverifiable",
				"unverifiable",
				"skip",
				`${unverifiable.length} source(s) resolved by Pi itself, not inspectable statically: ${preview(unverifiable, 3)}`,
			),
		);
	}

	return results;
}
