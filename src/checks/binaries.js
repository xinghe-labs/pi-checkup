// Binary checks — can you actually run what your packages ship?
//
// Two failures this catches, both invisible to `pi list`:
//   1. A dangling symlink in node_modules/.bin (postinstall blocked by npm,
//      optional native dependency skipped for this platform).
//   2. A package's command name is shadowed by an unrelated program earlier on
//      PATH, so the name resolves to something else entirely.
import path from "node:path";
import fs from "node:fs";
import { exists, readJson, resolvePackageDir, whichAll, isWindows } from "../util.js";

export const group = "Binaries";

/** bin names that installed packages declare in their own manifests. */
function declaredBins(settings, root) {
	const names = new Set();
	for (const spec of settings?.packages ?? []) {
		const dir = resolvePackageDir(spec, root);
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
		return [
			{
				group,
				id: "bin-dir",
				title: "bin dir",
				status: "skip",
				detail: `${binDir} does not exist (no npm packages installed)`,
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
	for (const entry of entries) {
		const full = path.join(binDir, entry);
		let isLink = false;
		try {
			isLink = fs.lstatSync(full).isSymbolicLink();
		} catch {
			continue;
		}
		if (isLink && !exists(full)) dangling.push(entry);
	}

	const results = [
		dangling.length
			? {
					group,
					id: "dangling",
					title: "dangling links",
					status: "fail",
					detail: `${dangling.length} broken: ${dangling.slice(0, 6).join(", ")}`,
					hint: "Usually a blocked postinstall or a skipped optional native dependency. Reinstall the owning package with install scripts approved.",
				}
			: {
					group,
					id: "dangling",
					title: "dangling links",
					status: "ok",
					detail: `${entries.length} entries all resolve`,
				},
	];

	// --- shadowing and reachability ----------------------------------------
	const ownBins = declaredBins(settings, root);
	const shadowed = [];
	const unreachable = [];
	const norm = (p) => (isWindows ? normalizeWin(p) : p);

	for (const entry of entries) {
		// Both findings below are about commands a Pi package advertises. A
		// transitive dev dependency that happens to be shadowed is not the user's
		// problem and reporting it made a healthy install look broken forever.
		if (!ownBins.has(entry)) continue;
		const hits = await whichAll(entry);
		if (!hits.length) {
			unreachable.push(entry);
			continue;
		}
		if (norm(hits[0]) !== norm(path.join(binDir, entry))) shadowed.push({ name: entry, actual: hits[0] });
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

function normalizeWin(p) {
	return String(p).replace(/\\/g, "/").toLowerCase();
}
