// Package checks — are the packages in settings.json actually on disk, and do
// the files their manifests point at exist?
//
// This catches the failure that happens after a good install: a partial
// extraction, a manual `rm -rf` in node_modules, a git checkout that moved the
// entry file, or a package whose manifest points at a build output that was
// never committed.
import path from "node:path";
import fs from "node:fs";
import { agentDir, globExists, readJson, resolvePackageDir } from "../util.js";

export const group = "Packages";

export async function run({ settings, cwd }) {
	const results = [];
	const root = agentDir();

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
	let inspected = 0;

	for (const spec of specs) {
		const source = typeof spec === "string" ? spec : spec?.source;
		const dir = resolvePackageDir(source, root);
		if (!dir) {
			unverifiable.push(String(source));
			continue;
		}
		inspected++;
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
		const manifest = readJson(path.join(dir, "package.json"));
		if (!manifest.ok) {
			brokenManifest.push(String(source));
			continue;
		}
		const declared = manifest.data?.pi?.extensions;
		if (!declared) continue; // convention-directory package, nothing to verify
		const list = Array.isArray(declared) ? declared : [declared];
		const missing = list.filter((entry) => !globExists(dir, entry));
		if (missing.length) missingEntry.push(`${source} -> ${missing.join(", ")}`);
	}

	const preview = (list, n) => list.slice(0, n).join(", ") + (list.length > n ? ", ..." : "");

	results.push(
		missingDir.length
			? {
					group,
					id: "dirs",
					title: "package dirs",
					status: "fail",
					detail: `${missingDir.length} missing from node_modules: ${preview(missingDir, 3)}`,
					hint: "Run `pi install` again for the listed packages, or remove them from settings.json.",
					fix: "dedupe-packages",
				}
			: { group, id: "dirs", title: "package dirs", status: "ok", detail: `${inspected} present` },
	);

	results.push(
		brokenManifest.length
			? {
					group,
					id: "manifests",
					title: "manifests",
					status: "fail",
					detail: `${brokenManifest.length} unreadable package.json: ${brokenManifest.slice(0, 3).join(", ")}`,
					hint: "Reinstall the affected packages.",
				}
			: { group, id: "manifests", title: "manifests", status: "ok", detail: "all readable" },
	);

	if (missingEntry.length) {
		results.push({
			group,
			id: "entries",
			title: "entry files",
			status: "fail",
			detail: `${missingEntry.length} manifest(s) point at files that do not exist: ${missingEntry.slice(0, 2).join("; ")}`,
			hint: "The package is installed but cannot load. Reinstall it, or check whether it needs a build step.",
		});
	} else {
		results.push({ group, id: "entries", title: "entry files", status: "ok", detail: "all present" });
	}

	if (unverifiable.length) {
		results.push({
			group,
			id: "unverifiable",
			title: "unverifiable",
			status: "skip",
			detail: `${unverifiable.length} source(s) resolved by Pi itself, not inspectable statically: ${unverifiable.slice(0, 3).join(", ")}`,
		});
	}

	return results;
}
