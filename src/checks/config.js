// Config checks — is the configuration well-formed, backed up, and free of
// entries that silently cancel each other out?
import path from "node:path";
import fs from "node:fs";
import { agentDir, exists, newestBackup, readJson } from "../util.js";

export const group = "Config";

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function sourceOf(spec) {
	return typeof spec === "string" ? spec : spec?.source;
}

export async function run({ cwd }) {
	const results = [];
	const root = agentDir();
	const files = [
		{ label: "settings.json", file: path.join(root, "settings.json"), required: true },
		{ label: "models.json", file: path.join(root, "models.json"), required: false },
		{ label: "project settings", file: path.join(cwd, ".pi", "settings.json"), required: false },
	];

	for (const { label, file, required } of files) {
		if (!exists(file)) {
			// Optional files that are simply absent are not a finding worth a line in a
			// clean report, so they read as ok rather than skipped.
			results.push(
				required
					? {
							group,
							id: `file:${label}`,
							title: label,
							status: "fail",
							detail: `${file} not found`,
							hint: "Run `pi` once to generate it.",
						}
					: { group, id: `file:${label}`, title: label, status: "ok", detail: "none" },
			);
			continue;
		}
		const parsed = readJson(file);
		if (parsed.ok) {
			results.push({ group, id: `file:${label}`, title: label, status: "ok", detail: "valid JSON" });
			continue;
		}
		const backup = newestBackup(file);
		results.push({
			group,
			id: `file:${label}`,
			title: label,
			status: "fail",
			detail: `${file} is not valid JSON: ${parsed.error}`,
			hint: backup
				? `A backup exists at ${path.basename(backup)}. Run \`/checkup fix\` to restore it.`
				: "No backup found; fix it by hand.",
			fix: backup ? "restore-config" : undefined,
			fixTarget: backup ? file : undefined,
		});
	}

	// --- backups -----------------------------------------------------------
	const noBackup = files
		.filter(({ file }) => exists(file) && !newestBackup(file))
		.map(({ label }) => label);
	results.push(
		noBackup.length
			? {
					group,
					id: "backups",
					title: "backups",
					status: "warn",
					detail: `no backup beside: ${noBackup.join(", ")}`,
					hint: "An edit that breaks these files is unrecoverable without one.",
				}
			: { group, id: "backups", title: "backups", status: "ok", detail: "present for every config file" },
	);

	// --- duplicate package entries -----------------------------------------
	// Two identical sources do not fail loudly; the package just loads twice and
	// the second registration can shadow the first.
	const settingsFile = path.join(root, "settings.json");
	const settings = readJson(settingsFile);
	if (settings.ok && Array.isArray(settings.data?.packages)) {
		const seen = new Map();
		const duplicates = new Set();
		for (const spec of settings.data.packages) {
			const source = sourceOf(spec);
			if (typeof source !== "string") continue;
			if (seen.has(source)) duplicates.add(source);
			seen.set(source, true);
		}
		results.push(
			duplicates.size
				? {
						group,
						id: "duplicates",
						title: "duplicate packages",
						status: "warn",
						detail: `${[...duplicates].join(", ")} listed more than once`,
						hint: "Run `/checkup fix` to collapse them to one entry each.",
						fix: "dedupe-packages",
						fixTarget: settingsFile,
					}
				: { group, id: "duplicates", title: "duplicate packages", status: "ok", detail: "none" },
		);

		// --- environment references ----------------------------------------
		const missing = new Set();
		for (const [, braced, bare] of settings.raw.matchAll(ENV_REF)) {
			const name = braced ?? bare;
			if (name && !(name in process.env)) missing.add(name);
		}
		results.push(
			missing.size
				? {
						group,
						id: "env",
						title: "env references",
						status: "warn",
						detail: `referenced but unset: ${[...missing].join(", ")}`,
						hint: "Export them before starting Pi, or the provider that needs them will fail at request time.",
					}
				: { group, id: "env", title: "env references", status: "ok", detail: "all set" },
		);
	}

	return results;
}

/** Restore a broken config file from its newest sibling backup. */
export function applyRestoreConfig(target) {
	const backup = newestBackup(target);
	if (!backup) return { ok: false, message: `no backup found for ${path.basename(target)}` };
	const parsed = readJson(backup);
	if (!parsed.ok) return { ok: false, message: `backup ${path.basename(backup)} is not valid JSON either` };
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const aside = `${target}.broken-${stamp}`;
	fs.copyFileSync(target, aside);
	fs.copyFileSync(backup, target);
	return { ok: true, message: `restored ${path.basename(target)} from ${path.basename(backup)} (broken copy kept as ${path.basename(aside)})` };
}

/** Collapse duplicate `packages` entries, preserving the first occurrence. */
export function applyDedupePackages(target) {
	const settings = readJson(target);
	if (!settings.ok) return { ok: false, message: `${path.basename(target)} is not valid JSON` };
	if (!Array.isArray(settings.data?.packages)) return { ok: false, message: "no packages array to dedupe" };

	const seen = new Set();
	const kept = [];
	for (const spec of settings.data.packages) {
		const source = sourceOf(spec);
		if (typeof source !== "string") {
			kept.push(spec);
			continue;
		}
		if (seen.has(source)) continue;
		seen.add(source);
		kept.push(spec);
	}
	const removed = settings.data.packages.length - kept.length;
	if (removed === 0) return { ok: true, message: "nothing to dedupe" };

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const backup = `${target}.checkup-bak-${stamp}`;
	fs.copyFileSync(target, backup);
	settings.data.packages = kept;
	fs.writeFileSync(target, `${JSON.stringify(settings.data, null, 2)}\n`);
	return { ok: true, message: `removed ${removed} duplicate entr${removed === 1 ? "y" : "ies"} from ${path.basename(target)} (backup: ${path.basename(backup)})` };
}
