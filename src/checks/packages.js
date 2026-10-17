// Package checks — are the packages in settings.json actually on disk, and do
// the files their manifests point at exist?
//
// This catches the failure that happens after a good install: a partial
// extraction, a manual `rm -rf` in node_modules, a git checkout that moved the
// entry file, or a package whose manifest points at a build output that was
// never committed.
import path from "node:path";
import fs from "node:fs";
import { globExists, readJson, resolvePackageDir } from "../util.js";

export const group = "Packages";

export async function run({ settings, agentDir: root, settingsFile }) {
	const results = [];

	const specs = settings?.packages ?? [];

	if (!specs.length) {
		return [
			{
				group,
				id: "installed",
				title: "installed",
				status: "skip",
				detail: "no packages in settings.json",
			},
		];
	}

	const missingDir = [];
	const brokenManifest = [];
	const missingEntry = [];
	const unverifiable = [];
	// Counted separately so a check that had nothing to look at reports skipped
	// instead of printing a green tick over zero inspected packages.
	let present = 0;
	let manifestRead = 0;
	let entryChecked = 0;

	for (const spec of specs) {
		const source = typeof spec === "string" ? spec : spec?.source;
		const dir = resolvePackageDir(source, root);
		if (!dir) {
			unverifiable.push(String(source));
			continue;
		}
		let stat;
		try {
			stat = fs.statSync(dir);
		} catch {
			missingDir.push(String(source));
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
		entryChecked++;
		const list = Array.isArray(declared) ? declared : [declared];
		const missing = list.filter((entry) => !globExists(dir, entry));
		if (missing.length) missingEntry.push(`${source} -> ${missing.join(", ")}`);
	}

	const preview = (list, n) => list.slice(0, n).join(", ") + (list.length > n ? ", ..." : "");
	/** One finding row, so the checks below stay flat and readable. */
	const row = (id, title, status, detail, extra = {}) => ({ group, id, title, status, detail, ...extra });

	// --- package directories -----------------------------------------------
	if (missingDir.length) {
		results.push(
			row("dirs", "package dirs", "fail", `${missingDir.length} missing from node_modules: ${preview(missingDir, 3)}`, {
				hint: "Run `pi install` again for the listed packages, or remove them from settings.json.",
				// Dropping the entry is the only repair a static checker can offer;
				// reinstalling needs the package manager and the network.
				fix: settingsFile ? "prune-missing-packages" : undefined,
				fixTarget: settingsFile || undefined,
			}),
		);
	} else {
		results.push(row("dirs", "package dirs", "ok", `${present} present`));
	}

	// --- manifests ---------------------------------------------------------
	if (brokenManifest.length) {
		results.push(
			row(
				"manifests",
				"manifests",
				"fail",
				`${brokenManifest.length} unreadable package.json: ${brokenManifest.slice(0, 3).join(", ")}`,
				{ hint: "Reinstall the affected packages." },
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
				`${missingEntry.length} manifest(s) point at files that do not exist: ${missingEntry.slice(0, 2).join("; ")}`,
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
				`${unverifiable.length} source(s) resolved by Pi itself, not inspectable statically: ${unverifiable.slice(0, 3).join(", ")}`,
			),
		);
	}

	return results;
}
