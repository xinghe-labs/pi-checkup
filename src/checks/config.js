// Config checks — is the configuration well-formed, backed up, and free of
// entries that silently cancel each other out?
import fs from "node:fs";
import path from "node:path";
import { exists, newestBackup, readJson } from "../util.js";

export const group = "Config";

// Pi interpolates $NAME and ${NAME} in models.json credential fields — `apiKey`
// and header values — and nowhere else. Scanning whole file text instead meant
// every literal dollar sign in a comment or note was reported as a missing
// environment variable, so the check cried wolf on healthy configs.
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function sourceOf(spec) {
	return typeof spec === "string" ? spec : spec?.source;
}

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

export async function run({ cwd, agentDir: root, settingsFile, modelsFile, settings }) {
	const results = [];
	/** One finding row, so the checks below stay flat and readable. */
	const row = (id, title, status, detail, extra = {}) => ({ group, id, title, status, detail, ...extra });

	const files = [
		{ label: "settings.json", file: settingsFile, required: true },
		{ label: "models.json", file: modelsFile, required: false },
		{ label: "project settings", file: path.join(cwd, ".pi", "settings.json"), required: false },
	];

	// --- validity ----------------------------------------------------------
	for (const { label, file, required } of files) {
		if (!exists(file)) {
			// An optional file that is simply absent is not a finding worth a line in
			// a clean report, so it reads as ok rather than skipped.
			results.push(
				required
					? row(`file:${label}`, label, "fail", `${file} not found`, {
							hint: "Run `pi` once to generate it.",
						})
					: row(`file:${label}`, label, "ok", "none"),
			);
			continue;
		}
		const parsed = readJson(file);
		if (parsed.ok) {
			results.push(row(`file:${label}`, label, "ok", "valid JSON"));
			continue;
		}
		const backup = newestBackup(file);
		results.push(
			row(`file:${label}`, label, "fail", `${file} is not valid JSON: ${parsed.error}`, {
				hint: backup
					? `A backup exists at ${path.basename(backup)}. Run \`/checkup fix\` to restore it.`
					: "No backup found; fix it by hand.",
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
		results.push(
			row("backups", "backups", "ok", `${backedUp} file(s) backed up`, {
				hint: stale.length
					? `Edited since the newest backup: ${stale.join(", ")}. That state cannot be rolled back to, so copy it somewhere safe before the next edit.`
					: undefined,
			}),
		);
	} else {
		results.push(
			row("backups", "backups", "skip", "none yet — created before the first repair", {
				hint: "`/checkup fix` writes one beside the file it changes.",
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
						hint: "Run `/checkup fix` to collapse them to one entry each.",
						fix: "dedupe-packages",
						fixTarget: settingsFile,
					})
				: row("duplicates", "duplicate packages", "ok", "none"),
		);
	}

	// --- environment references --------------------------------------------
	// Only the credential fields that Pi interpolates, never the raw file text.
	const models = readJson(modelsFile);
	if (models.ok) {
		const missing = new Set();
		for (const value of interpolatedFields(models.data)) {
			for (const [, braced, bare] of value.matchAll(ENV_REF)) {
				const name = braced ?? bare;
				if (name && !(name in process.env)) missing.add(name);
			}
		}
		results.push(
			missing.size
				? row("env", "env references", "warn", `referenced but unset: ${[...missing].join(", ")}`, {
						hint: "Export them before starting Pi, or the provider that needs them will fail at request time.",
					})
				: row("env", "env references", "ok", "all set"),
		);
	}

	return results;
}
