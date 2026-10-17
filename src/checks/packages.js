// Package checks — are the packages in settings.json actually on disk, and do
// the files their manifests point at exist?
//
// This catches the failure that happens after a good install: a partial
// extraction, a manual `rm -rf` in node_modules, a git checkout that moved the
// entry file, or a package whose manifest points at a build output that was
// never committed.
import path from "node:path";
import fs from "node:fs";
import {
	exists,
	globExists,
	isMissing,
	makeRow,
	pinnedVersion,
	readJson,
	redactSource,
	resolvePackageDir,
	scrubCredentials,
	sourceOf,
} from "../util.js";

export const group = "Packages";

/**
 * Describe a malformed `packages` entry without printing it.
 *
 * The entry can be any JSON value, including an object with a `token` field;
 * `redactSource` scrubs URLs, not arbitrary objects, so serialising the value
 * put whatever was in it into the report and into `--json`.
 */
function describeSpec(spec) {
	if (spec === null) return "null";
	if (spec === undefined) return "undefined";
	if (Array.isArray(spec)) return "an array";
	const kind = typeof spec;
	if (kind === "function" || kind === "symbol" || kind === "bigint") return `a ${kind}`;
	// A string here is not a source (sourceOf would have returned it), so it is a
	// value someone pasted into the wrong field: its length is enough to find it
	// and prints none of it.
	if (kind === "string") return `a ${spec.length}-character string`;
	if (kind !== "object") return `${kind} ${String(spec)}`.slice(0, 40);
	const keys = Object.keys(spec);
	return keys.length ? `an object with keys ${keys.slice(0, 4).join(", ")}` : "an empty object";
}

export async function run({ settings, settingsLoaded, agentDir: root, settingsFile, settingsSource }) {
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
		// `settings` is absent when the file could not be parsed. Saying "no
		// packages in settings.json" then asserted something the check never read,
		// and pointed the user at the wrong problem.
		// "Not loaded" and "loaded as null" are different files: a settings.json
		// containing `null` parses fine and is still not a config.
		const unreadable = !settingsLoaded;
		const notObject = settingsLoaded && (settings === null || typeof settings !== "object" || Array.isArray(settings));
		// A missing settings.json is not a fault: Pi boots on defaults and writes
		// the file the first time a setting changes. A file that exists but did not
		// parse is a fault, and Config already says so.
		const absent = Boolean(settingsFile) && isMissing(settingsFile);
		const where = settingsSource === "runtime" ? "the running session" : "settings.json";
		let detail = `no packages in ${where}`;
		// "could not be inspected", not "could not be read": an oversized file was
		// read fine, it just was not parsed.
		if (absent) detail = "settings.json not found — no package list to check";
		else if (unreadable) detail = "settings.json could not be inspected — no package list to check";
		else if (notObject) detail = "settings.json is valid JSON but not an object — no package list to check";
		else if (malformed) detail = `${where} \`packages\` is not a list`;
		return [
			{
				group,
				id: "installed",
				title: "installed",
				status: malformed || notObject || (unreadable && !absent) ? "warn" : "skip",
				detail,
				hint: unreadable && !absent ? "The Config group reports why settings.json could not be used." : undefined,
			},
		];
	}

	const missingDir = [];
	const unreadableDir = [];
	const notDir = [];
	const brokenManifest = [];
	const unreadableManifest = [];
	const badSpecs = [];
	const badExtensions = [];
	const missingEntry = [];
	const versionMismatch = [];
	const unverifiable = [];
	// Counted separately so a check that had nothing to look at reports skipped
	// instead of printing a green tick over zero inspected packages.
	let present = 0;
	let manifestRead = 0;
	let entryChecked = 0;

	for (const spec of specs) {
		const source = sourceOf(spec);
		if (source === null) {
			// A null, a number or an object without `source` is a malformed entry, not
			// a source "resolved by Pi itself": the old path pushed `null` into the
			// unverifiable list and printed "2 source(s) ... null, null".
			// Shape, not content: an entry object can carry a token field, and
			// redactSource only scrubs URLs, so serialising it echoed the secret.
			badSpecs.push(describeSpec(spec));
			continue;
		}
		const dir = resolvePackageDir(source, root);
		if (!dir) {
			unverifiable.push(redactSource(source));
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
			if (code === "ENOENT" || code === "ENOTDIR") missingDir.push(redactSource(source));
			else unreadableDir.push(`${redactSource(source)} (${code ?? "error"})`);
			continue;
		}
		if (!stat.isDirectory()) {
			// It exists. Calling a file "missing" reported a `fail` that the prune
			// repair could never clear, because prune asks isMissing() and a file is
			// not missing.
			notDir.push(redactSource(source));
			continue;
		}
		present++;
		const manifest = readJson(path.join(dir, "package.json"));
		if (!manifest.ok) {
			// A manifest that does not parse is broken. One this process could not
			// read — EACCES, a file past the size limit — is unproven, and telling
			// someone to reinstall over a permissions problem is wrong.
			if (manifest.invalid) brokenManifest.push(redactSource(source));
			else unreadableManifest.push(`${redactSource(source)} (${manifest.error ?? "unreadable"})`);
			continue;
		}
		manifestRead++;
		// A pin and a different installed version is the gap between the code that
		// was asked for and the code that runs. Only exact pins are comparable.
		const pin = pinnedVersion(source);
		const installed = manifest.data?.version;
		if (pin && typeof installed === "string" && installed !== pin) {
			versionMismatch.push(`${redactSource(source)} (installed ${scrubCredentials(installed.slice(0, 40))})`);
		}
		const declared = manifest.data?.pi?.extensions;
		if (!declared) continue; // convention-directory package, nothing to verify
		const raw = Array.isArray(declared) ? declared : [declared];
		// A hand-edited manifest can put a number, null or object here, and passing
		// that to the glob matcher threw `pattern.includes is not a function` out of
		// this module — which the runner turns into one "check crashed" row, losing
		// every other package finding.
		const list = raw.filter((entry) => typeof entry === "string");
		if (list.length !== raw.length) badExtensions.push(redactSource(source));
		if (!list.length) continue; // declared nothing verifiable
		entryChecked++;
		const missing = list.filter((entry) => !globExists(dir, entry));
		// The patterns come from a third-party package.json, so they are untrusted
		// text on their way to the terminal and `--json`, like everything else here.
		if (missing.length) missingEntry.push(`${redactSource(source)} -> ${missing.map(redactSource).join(", ")}`);
	}

	const preview = (list, n) => list.slice(0, n).join(", ") + (list.length > n ? ", ..." : "");
	const row = makeRow(group);

	// --- package directories -----------------------------------------------
	// The prune repair is only safe when settings came from the file the repair
	// would rewrite. In-session the settings may come from the running process, so
	// editing the on-disk copy could either miss the problem or hit a stale file.
	// Only a file this check read itself may be rewritten: "runtime" means the
	// session's copy is authoritative, and "runtime-unreadable" means the file is
	// a guess.
	const canPrune = Boolean(settingsFile) && settingsSource === "file";
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

	// An entry that points at a file is not a package directory, and Pi cannot
	// install from it. Reported without a `fix`: there is nothing to delete.
	if (notDir.length) {
		results.push(
			row("not-dir", "not a package", "warn", `${notDir.length} entr${notDir.length === 1 ? "y points" : "ies point"} at a file, not a package directory: ${preview(notDir, 3)}`, {
				hint: "A package entry has to be a directory containing package.json; declare a single-file extension inside a package's pi.extensions instead.",
			}),
		);
	}

	// --- manifests ---------------------------------------------------------
	if (unreadableManifest.length) {
		results.push(
			row("manifests-unreadable", "unreadable manifests", "warn", `${unreadableManifest.length} package.json could not be inspected: ${preview(unreadableManifest, 2)}`, {
				hint: "A permissions or size problem, not proof of a broken package. The entry files below are only checked for manifests that parsed.",
			}),
		);
	}
	if (brokenManifest.length) {
		results.push(
			row(
				"manifests",
				"manifests",
				"fail",
				`${brokenManifest.length} package.json not valid JSON: ${preview(brokenManifest, 3)}`,
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
		// Nothing was opened, so there is nothing to be green about. An unreadable
		// manifest is not "nothing to inspect" — the row above says one existed.
		results.push(
			row("manifests", "manifests", "skip", unreadableManifest.length ? "no manifest could be read" : "nothing to inspect"),
		);
	}

	// --- version pins ------------------------------------------------------
	if (versionMismatch.length) {
		results.push(
			row(
				"version-pin",
				"version pins",
				"warn",
				`${versionMismatch.length} pinned package(s) run a different version: ${preview(versionMismatch, 2)}`,
				{
					hint: "settings.json pins a version and the copy on disk is another one. Reinstall that package to make the disk match, or update the pin.",
				},
			),
		);
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

	if (badSpecs.length) {
		results.push(
			row(
				"entries-shape",
				"package entries",
				"warn",
				`${badSpecs.length} entr${badSpecs.length === 1 ? "y is" : "ies are"} not a package source: ${preview(badSpecs, 3)}`,
				{ hint: "Each entry has to be a string like `npm:name` or `./path`, or an object with a `source` field." },
			),
		);
	}

	if (badExtensions.length) {
		results.push(
			row(
				"manifest-shape",
				"manifest shape",
				"warn",
				`${badExtensions.length} manifest(s) declare a non-string pi.extensions entry: ${preview(badExtensions, 3)}`,
				{ hint: "Entry files have to be strings. Reinstall the package, or fix its package.json." },
			),
		);
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
