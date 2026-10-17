// Config checks — is the configuration well-formed, backed up, and free of
// entries that silently cancel each other out?
import fs from "node:fs";
import path from "node:path";
import { exists, isMissing, makeRow, newestBackup, readJson, redactSource, sourceOf, truncateList } from "../util.js";

export const group = "Config";

// Pi interpolates $NAME and ${NAME} in models.json credential fields — `apiKey`
// and header values — and nowhere else. Scanning whole file text instead meant
// every literal dollar sign in a comment or note was reported as a missing
// environment variable, so the check cried wolf on healthy configs.
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** The models.json strings Pi will actually run through env interpolation. */
function interpolatedFields(models) {
	const out = [];
	const providers = models?.providers ?? models ?? {};
	if (!providers || typeof providers !== "object") return out;
	for (const [name, provider] of Object.entries(providers)) {
		if (!provider || typeof provider !== "object") continue;
		// The provider name travels with the value: "referenced but unset: FOO"
		// without one leaves the reader to grep models.json for the variable before
		// they can tell which provider is about to fail.
		const key = provider.apiKey ?? provider.api_key;
		if (typeof key === "string") out.push({ provider: name, value: key });
		if (provider.headers && typeof provider.headers === "object") {
			for (const value of Object.values(provider.headers)) {
				if (typeof value === "string") out.push({ provider: name, value });
			}
		}
	}
	return out;
}

export async function run({
	cwd,
	agentDir: root,
	settingsFile,
	modelsFile,
	projectSettingsFile = path.join(cwd ?? process.cwd(), ".pi", "settings.json"),
	settings,
	settingsLoaded,
	settingsSource,
	hasRuntime,
	env = process.env,
}) {
	const results = [];
	const row = makeRow(group);
	// The CLI cannot run a slash command, so a hint that names one is useless to
	// the exact reader the CLI exists for: someone whose Pi will not boot.
	const fixCommand = hasRuntime ? "/checkup fix" : "npx pi-checkup --fix --yes";

	const files = [
		{ label: "settings.json", file: settingsFile, required: true },
		{ label: "models.json", file: modelsFile, required: false },
		{ label: "project settings", file: projectSettingsFile, required: false },
	];

	// --- validity ----------------------------------------------------------
	for (const { label, file, required } of files) {
		// `isMissing`, not `exists`: a permission-denied settings.json used to be
		// reported as "not found — Pi is running on defaults", which is a claim
		// about a file nobody managed to open.
		if (isMissing(file)) {
			// `skip` is this package's word for "there was nothing to inspect", used
			// the same way in every other module. An absent optional file is that,
			// not a pass: reporting it as ok made the same absence read as `ok` here
			// and `skip` in packages.js for no reason a reader could recover.
			//
			// A missing settings.json is not a failure either. Pi boots with
			// built-in defaults and writes the file the first time you change a
			// setting, so failing here turned a fresh install — or a container
			// running `npx pi-checkup` before its first prompt — red for a state
			// that works.
			results.push(
				required
					? row(`file:${label}`, label, "skip", `${file} not found — Pi is running on defaults`, {
							hint: "Pi writes this file the first time you change a setting.",
						})
					: row(`file:${label}`, label, "skip", "none"),
			);
			continue;
		}
		const parsed = readJson(file);
		if (parsed.ok) {
			// In-session, settings come from the running process and the file on disk
			// is not what the checks actually saw. Saying so prevents the report from
			// implying it validated a file it never read.
			const fromRuntime = label === "settings.json" && settingsSource === "runtime";
			results.push(row(`file:${label}`, label, "ok", fromRuntime ? "valid JSON (values read from the running session)" : "valid JSON"));
			continue;
		}
		// A parse failure and an unreadable file are different faults, and only one
		// of them is corruption. `invalid` is set by readJson for a genuine parse
		// error; a file over the size cap is reported as unreadable rather than as
		// broken, because "not valid JSON" over a perfectly valid 5 MB file is a
		// claim the check never established — and it offered to "restore" it.
		const corrupt = parsed.invalid === true;
		const backup = newestBackup(file);
		let detail = `${file} could not be inspected: ${parsed.error}`;
		let hint = "Nothing in this file was checked. Inspect it by hand if Pi misbehaves.";
		if (corrupt) {
			detail = `${file}: ${parsed.error}`;
			// The full path, not the basename: a user reading this from another
			// directory cannot find a bare filename.
			// The parse error names a line and a column, so the hint can point at the
			// file rather than at nothing: "fix it by hand" with no location left the
			// reader to bisect a 40 KB models.json by eye.
			hint = backup
				? `A backup exists at ${backup}. Run \`${fixCommand}\` to restore it.`
				: `No backup to restore. Open ${file} at the line in the message above and fix the syntax — a trailing comma or an unquoted value is the usual cause.`;
		}
		const restorable = corrupt && Boolean(backup);
		results.push(
			row(`file:${label}`, label, corrupt ? "fail" : "warn", detail, {
				hint,
				fix: restorable ? "restore-config" : undefined,
				fixTarget: restorable ? file : undefined,
			}),
		);
	}

	// --- backups -----------------------------------------------------------
	// Having no backup is normal: one is written before the first repair, so a
	// fresh install legitimately has none. A config edited since its newest
	// backup is not a fault either — editing config is the point — so it is
	// reported as detail on a passing row, not as a warning that can never be
	// cleared. A broken file is already a failure above, and that is where the
	// question "can I recover?" actually matters.
	const stale = [];
	let backedUp = 0;
	for (const { label, file } of files) {
		if (!exists(file)) continue;
		const backup = newestBackup(file);
		if (!backup) continue;
		backedUp++;
		try {
			if (fs.statSync(file).mtimeMs > fs.statSync(backup).mtimeMs) stale.push(label);
		} catch {
			// Raced with another writer; say nothing rather than guess.
		}
	}
	if (backedUp) {
		// The caveat goes in the detail, not the hint: the default report only shows
		// hints for non-ok rows, so a load-bearing hint on an ok row was invisible
		// unless the user already knew to pass --verbose.
		results.push(
			row(
				"backups",
				"backups",
				"ok",
				stale.length
					? `${backedUp} file(s) backed up; edited since the newest backup: ${stale.join(", ")}`
					: `${backedUp} file(s) backed up`,
				{
					// The named path is the point: "copy it somewhere safe" with no `it` left
					// the reader to work out which file the paragraph was about.
					hint: stale.length
						? `The current ${stale.join(" and ")} cannot be rolled back to, because both backups are older. Copy ${stale
								.map((label) => files.find((f) => f.label === label)?.file ?? label)
								.join(" and ")} somewhere you can restore from before the next edit.`
						: undefined,
				},
			),
		);
	} else {
		results.push(
			row("backups", "backups", "skip", "none yet — created before the first repair", {
				hint: `\`${fixCommand}\` writes one beside the file it changes.`,
			}),
		);
	}

	// --- duplicate package entries -----------------------------------------
	// Two identical sources do not fail loudly; the package just loads twice and
	// the second registration can shadow the first.
	const packageList = settings?.packages;
	if (!Array.isArray(packageList)) {
		// A row that disappears reads as "fine" to anyone counting rows, so the
		// absence of something to compare is stated rather than implied.
		let why = "settings.json `packages` is not a list";
		// "not found" and "could not be read" are different states, and packages.js
		// already words them differently. One state should not get two explanations
		// in one report.
		let unreadable = false;
		if (!settingsLoaded) {
			unreadable = Boolean(settingsFile) && !isMissing(settingsFile);
			why = unreadable ? "settings.json could not be inspected" : "settings.json not found — nothing to compare";
		} else if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
			// Valid JSON, wrong shape. The row above says "valid JSON", so saying
			// "could not be inspected" here contradicted it.
			unreadable = true;
			why = "settings.json is valid JSON but not an object";
		} else if (packageList === undefined) why = "no package list in settings.json";
		// A `packages` value that is present and not a list is a fault in the
		// config, not an absence — packages.js reports the same value as `warn`,
		// and one defect with two statuses made the report contradict itself. A
		// file that exists but would not parse is the same case: packages.js calls
		// it `warn` too, so `skip` here contradicted the row two groups up.
		const faulty = unreadable || (settings !== undefined && settings !== null && packageList !== undefined);
		results.push(row("duplicates", "duplicate packages", faulty ? "warn" : "skip", why));
	} else {
		// Two entries for one source are not always the same entry twice:
		// `"npm:a"` next to `{"source": "npm:a", "enabled": false}` says something
		// the plain string does not. The repair only drops byte-identical repeats,
		// so the check has to make the same distinction or its hint names a repair
		// that then answers "nothing to dedupe".
		const seen = new Map();
		const duplicates = new Set();
		const mixedShapes = new Set();
		for (const spec of settings.packages) {
			const source = sourceOf(spec);
			if (typeof source !== "string") continue;
			if (seen.has(source)) {
				if (JSON.stringify(seen.get(source)) === JSON.stringify(spec)) duplicates.add(source);
				else mixedShapes.add(source);
			} else {
				seen.set(source, spec);
			}
		}
		// Deduping the file is only correct when the file is what the report read;
		// in-session the list may have come from the running process. The hint has
		// to follow the same rule, or it names a command that then answers
		// "Nothing to repair automatically."
		// Only a file this check read itself may be rewritten: "runtime" means the
		// session's copy is authoritative, and "runtime-unreadable" means the file
		// is a guess.
		const canDedupe = settingsSource === "file" && Boolean(settingsFile);
		const listed = [...duplicates, ...mixedShapes].map(redactSource);
		if (!listed.length) {
			// Zero entries compared is not a pass: "none" over an empty list is the
			// same vacuous green tick the rest of this file avoids. Counted by
			// comparable entries rather than by the list length, because
			// `[null, 42]` has a length and nothing to compare.
			results.push(
				seen.size
					? row("duplicates", "duplicate packages", "ok", "none")
					: row("duplicates", "duplicate packages", "skip", "no comparable package entries"),
			);
		} else {
			const parts = [];
			if (duplicates.size) parts.push(`${duplicates.size} listed twice`);
			if (mixedShapes.size) parts.push(`${mixedShapes.size} listed in two different shapes`);
			results.push(
				row("duplicates", "duplicate packages", "warn", `${listed.join(", ")}: ${parts.join(", ")}`, {
					hint:
						mixedShapes.size && !duplicates.size
							? "Dedupe leaves entries that differ alone, because they say different things. Keep the one you meant."
							: canDedupe
								? `Run \`${fixCommand}\` to collapse the identical repeats to one entry each.`
								: "Remove the repeated entries from settings.json by hand, or run `npx pi-checkup --fix --yes` with Pi stopped.",
					fix: canDedupe && duplicates.size ? "dedupe-packages" : undefined,
					fixTarget: canDedupe && duplicates.size ? settingsFile : undefined,
				}),
			);
		}
	}

	// --- environment references --------------------------------------------
	// Only the credential fields that Pi interpolates, never the raw file text.
	const models = readJson(modelsFile);
	// Three states, three sentences: missing, corrupt, unreadable.
	const modelsUnreadableDetail = (m) => {
		if (m.missing) return "models.json is missing — no credentials to inspect";
		return m.invalid ? `models.json: ${m.error}` : `models.json could not be inspected: ${m.error}`;
	};
	if (!models.ok) {
		results.push(
			row(
				"env",
				"env references",
				"skip",
				modelsUnreadableDetail(models),
			),
		);
	} else {
		const missing = new Set();
		const owners = new Set();
		let references = 0;
		for (const { provider, value } of interpolatedFields(models.data)) {
			for (const [, braced, bare] of value.matchAll(ENV_REF)) {
				const name = braced ?? bare;
				if (!name) continue;
				references++;
				// An exported-but-empty variable is not usable as a credential, so
				// `FOO=""` counts as unset rather than as set.
				// Object.hasOwn, not a truthiness read: `"${constructor}"` resolved
				// through the prototype chain and was reported as set.
				if (!Object.hasOwn(env, name) || !env[name]) {
					missing.add(name);
					owners.add(provider);
				}
			}
		}
		if (!references) {
			results.push(row("env", "env references", "skip", "no $VAR reference in models.json credentials"));
		} else {
			results.push(
				missing.size
					? row("env", "env references", "warn", `referenced but unset: ${truncateList(missing, 6)}`, {
							// Which provider, and where to put the variable: "export them before
							// starting Pi" is advice only if the reader already knows both.
							hint: `${owners.size ? `Named in ${truncateList([...owners], 3)}. ` : ""}Add it to the shell profile Pi starts from (or your .env), then start Pi again — a missing value fails at request time, not at load.`,
						})
					: row("env", "env references", "ok", `${references} reference(s) all set`),
			);
		}
	}

	return results;
}
