// Config checks — is the configuration well-formed, backed up, and free of
// entries that silently cancel each other out?
import fs from "node:fs";
import path from "node:path";
import { exists, newestBackup, readJson, sourceOf } from "../util.js";

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
	for (const provider of Object.values(providers)) {
		if (!provider || typeof provider !== "object") continue;
		const key = provider.apiKey ?? provider.api_key;
		if (typeof key === "string") out.push(key);
		if (provider.headers && typeof provider.headers === "object") {
			for (const value of Object.values(provider.headers)) {
				if (typeof value === "string") out.push(value);
			}
		}
	}
	return out;
}

export async function run({ cwd, agentDir: root, settingsFile, modelsFile, settings, settingsSource, hasRuntime, env = process.env }) {
	const results = [];
	/** One finding row, so the checks below stay flat and readable. */
	const row = (id, title, status, detail, extra = {}) => ({ group, id, title, status, detail, ...extra });
	// The CLI cannot run a slash command, so a hint that names one is useless to
	// the exact reader the CLI exists for: someone whose Pi will not boot.
	const fixCommand = hasRuntime ? "/checkup fix" : "npx pi-checkup --fix --yes";

	const files = [
		{ label: "settings.json", file: settingsFile, required: true },
		{ label: "models.json", file: modelsFile, required: false },
		{ label: "project settings", file: path.join(cwd, ".pi", "settings.json"), required: false },
	];

	// --- validity ----------------------------------------------------------
	for (const { label, file, required } of files) {
		if (!exists(file)) {
			// `skip` is this package's word for "there was nothing to inspect", used
			// the same way in every other module. An absent optional file is that,
			// not a pass: reporting it as ok made the same absence read as `ok` here
			// and `skip` in packages.js for no reason a reader could recover.
			if (required) {
				results.push(row(`file:${label}`, label, "fail", `${file} not found`, { hint: "Run `pi` once to generate it." }));
			} else {
				results.push(row(`file:${label}`, label, "skip", "none"));
			}
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
		const backup = newestBackup(file);
		results.push(
			row(`file:${label}`, label, "fail", `${file} is not valid JSON: ${parsed.error}`, {
				hint: backup ? `A backup exists at ${path.basename(backup)}. Run \`${fixCommand}\` to restore it.` : "No backup found; fix it by hand.",
				fix: backup ? "restore-config" : undefined,
				fixTarget: backup ? file : undefined,
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
					hint: stale.length
						? "That state cannot be rolled back to, so copy it somewhere safe before the next edit."
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
	if (Array.isArray(settings?.packages)) {
		const seen = new Set();
		const duplicates = new Set();
		for (const spec of settings.packages) {
			const source = sourceOf(spec);
			if (typeof source !== "string") continue;
			if (seen.has(source)) duplicates.add(source);
			seen.add(source);
		}
		results.push(
			duplicates.size
				? row("duplicates", "duplicate packages", "warn", `${[...duplicates].join(", ")} listed more than once`, {
						hint: `Run \`${fixCommand}\` to collapse them to one entry each.`,
						// Deduping the file is only correct when the file is what the report
						// read; in-session the list may have come from the running process.
						fix: settingsSource === "runtime" ? undefined : "dedupe-packages",
						fixTarget: settingsSource === "runtime" ? undefined : settingsFile,
					})
				: row("duplicates", "duplicate packages", "ok", "none"),
		);
	}

	// --- environment references --------------------------------------------
	// Only the credential fields that Pi interpolates, never the raw file text.
	const models = readJson(modelsFile);
	if (models.ok) {
		const missing = new Set();
		let references = 0;
		for (const value of interpolatedFields(models.data)) {
			for (const [, braced, bare] of value.matchAll(ENV_REF)) {
				const name = braced ?? bare;
				if (!name) continue;
				references++;
				// An exported-but-empty variable is not usable as a credential, so
				// `FOO=""` counts as unset rather than as set.
				if (!env[name]) missing.add(name);
			}
		}
		if (!references) {
			results.push(row("env", "env references", "skip", "no $VAR reference in models.json credentials"));
		} else {
			results.push(
				missing.size
					? row("env", "env references", "warn", `referenced but unset: ${[...missing].join(", ")}`, {
							hint: "Export them before starting Pi, or the provider that needs them will fail at request time.",
						})
					: row("env", "env references", "ok", `${references} reference(s) all set`),
			);
		}
	}

	return results;
}
