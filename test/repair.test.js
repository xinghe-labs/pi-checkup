// Repairs are the only code path that writes to disk, so they get their own
// tests. Everything here runs against a temp directory; no real config is read.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyDedupePackages, applyRepairs, applyRestoreConfig } from "../src/repair.js";
import { buildContext } from "../src/context.js";

function tmp() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "checkup-repair-"));
}

test("dedupe keeps the first occurrence and backs up the original", () => {
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(
		file,
		JSON.stringify({ packages: ["npm:a", "npm:b", "npm:a", "npm:c"] }, null, 2),
	);

	const result = applyDedupePackages(file);
	assert.equal(result.ok, true);
	assert.match(result.message, /removed 1 duplicate entry/);

	const after = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.deepEqual(after.packages, ["npm:a", "npm:b", "npm:c"]);

	const backups = fs.readdirSync(dir).filter((f) => f.includes("checkup-bak-"));
	assert.equal(backups.length, 1);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, backups[0]), "utf8")).packages.length, 4);

	fs.rmSync(dir, { recursive: true, force: true });
});

test("dedupe leaves a same-source entry alone when its shape differs", () => {
	// `"npm:a"` and `{"source": "npm:a", "enabled": false}` are the same source
	// with different intent. Deleting the second one changed what Pi loads, and
	// calling that a "duplicate" was wrong.
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	const original = { packages: ["npm:a", { source: "npm:a", enabled: false }] };
	fs.writeFileSync(file, JSON.stringify(original, null, 2));

	const result = applyDedupePackages(file);
	assert.equal(result.ok, true);
	assert.match(result.message, /nothing to dedupe/);
	assert.match(result.message, /differ in shape/);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
	assert.equal(fs.readdirSync(dir).filter((f) => f.includes("checkup-bak-")).length, 0);

	fs.rmSync(dir, { recursive: true, force: true });
});

test("restore refuses when the target was repaired by hand in the meantime", () => {
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(`${file}.bak-20260101-000000-000`, JSON.stringify({ packages: ["npm:old"] }));
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:hand-fixed"] }));

	const result = applyRestoreConfig(file);
	assert.equal(result.ok, false);
	assert.match(result.message, /valid JSON again/);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { packages: ["npm:hand-fixed"] });

	fs.rmSync(dir, { recursive: true, force: true });
});

test("dedupe with nothing to remove writes no backup", () => {
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:a", "npm:b"] }));

	const result = applyDedupePackages(file);
	assert.equal(result.ok, true);
	assert.equal(result.message, "nothing to dedupe");
	assert.equal(fs.readdirSync(dir).length, 1);

	fs.rmSync(dir, { recursive: true, force: true });
});

test("dedupe refuses a file that is not valid JSON", () => {
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, "{ broken");

	const result = applyDedupePackages(file);
	assert.equal(result.ok, false);
	assert.match(result.message, /not valid JSON/);

	fs.rmSync(dir, { recursive: true, force: true });
});

test("restore replaces a broken file and keeps the broken copy", () => {
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, "{ broken");
	fs.writeFileSync(`${file}.checkup-bak-2026-01-01T00-00-00`, JSON.stringify({ good: true }));

	const result = applyRestoreConfig(file);
	assert.equal(result.ok, true);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { good: true });

	const kept = fs.readdirSync(dir).filter((f) => f.includes(".broken-"));
	assert.equal(kept.length, 1);
	assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), "{ broken");

	fs.rmSync(dir, { recursive: true, force: true });
});

test("restore reports failure when there is no backup", () => {
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, "{ broken");

	const result = applyRestoreConfig(file);
	assert.equal(result.ok, false);
	assert.match(result.message, /no backup found/);

	fs.rmSync(dir, { recursive: true, force: true });
});

test("applyRepairs touches each file once and survives an unknown repair", async () => {
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:a", "npm:a"] }));

	const applied = await applyRepairs([
		{ fix: "dedupe-packages", fixTarget: file, title: "duplicate packages" },
		{ fix: "dedupe-packages", fixTarget: file, title: "duplicate packages" },
		{ fix: "no-such-repair", fixTarget: file, title: "mystery" },
	]);

	assert.equal(applied.length, 2);
	assert.equal(applied[0].ok, true);
	assert.equal(applied[1].ok, false);
	assert.match(applied[1].message, /unknown repair/);

	fs.rmSync(dir, { recursive: true, force: true });
});

test("buildContext prefers the running session over the settings file", () => {
	const fromRuntime = buildContext({ pi: { getSettings: () => ({ packages: ["npm:live"] }) } });
	assert.equal(fromRuntime.settingsSource, "runtime");
	assert.equal(fromRuntime.hasRuntime, true);
	assert.deepEqual(fromRuntime.settings.packages, ["npm:live"]);
});

test("buildContext falls back to the settings file without a session", () => {
	// A temp root, never the developer's ~/.pi/agent: a suite whose result depends
	// on the machine it runs on cannot be a gate.
	const root = tmp();
	fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ packages: ["npm:from-file"] }));
	const ctx = buildContext({ agentDir: root });
	assert.equal(ctx.hasRuntime, false);
	assert.equal(ctx.pi, null);
	assert.equal(ctx.agentDir, root);
	assert.equal(ctx.settingsSource, "file");
	assert.deepEqual(ctx.settings.packages, ["npm:from-file"]);
	// Checks read the environment through the context so a test can describe a
	// proxy without mutating process.env.
	assert.equal(ctx.env, process.env);
	assert.deepEqual(buildContext({ agentDir: root, env: { https_proxy: "x" } }).env, { https_proxy: "x" });
	// The two paths a check would otherwise rebuild itself come from the context,
	// so the agent layout lives in one place and a test can point a check at a
	// project config without touching the real tree.
	const derived = buildContext({ agentDir: root, cwd: path.join(root, "proj") });
	assert.equal(derived.projectSettingsFile, path.join(root, "proj", ".pi", "settings.json"));
	assert.equal(derived.binDir, path.join(root, "npm", "node_modules", ".bin"));
	fs.rmSync(root, { recursive: true, force: true });
});

// --- durability ----------------------------------------------------------

test("a write leaves no temp file behind and keeps the original mode", () => {
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:a", "npm:a"] }, null, 2));
	fs.chmodSync(file, 0o600);

	const result = applyDedupePackages(file);
	assert.equal(result.ok, true);

	// A models.json chmod 600 must not come back readable by everyone.
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	}
	// The temp sibling must not survive a successful rename.
	const leftovers = fs.readdirSync(dir).filter((n) => n.includes("checkup-tmp-"));
	assert.deepEqual(leftovers, []);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).packages, ["npm:a"]);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("two repairs in the same second get distinct backup names", () => {
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:a", "npm:a"] }, null, 2));

	// Both run synchronously, so they land inside the same second.
	applyDedupePackages(file);
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:b", "npm:b"] }, null, 2));
	applyDedupePackages(file);

	const backups = fs.readdirSync(dir).filter((n) => n.includes("checkup-bak-"));
	assert.equal(backups.length, 2, `expected two distinct backups, got ${backups.join(", ")}`);
	// The first backup must still hold the pre-repair content.
	const contents = backups.map((n) => fs.readFileSync(path.join(dir, n), "utf8"));
	assert.ok(contents.some((c) => c.includes("npm:a")), "the first backup was overwritten");
	assert.ok(contents.some((c) => c.includes("npm:b")), "the second backup is missing");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("restore writes the backup's bytes verbatim, formatting included", () => {
	const dir = tmp();
	const file = path.join(dir, "models.json");
	const original = '{\n\t"providers": {}\n}\n';
	fs.writeFileSync(`${file}.bak`, original);
	fs.writeFileSync(file, "{ broken");

	const result = applyRestoreConfig(file);
	assert.equal(result.ok, true);
	// Restoring must not reformat: the backup is the source of truth.
	assert.equal(fs.readFileSync(file, "utf8"), original);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("prune resolves package directories against the root it is given", async () => {
	const { applyPruneMissingPackages } = await import("../src/repair.js");
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:present", "npm:gone"] }, null, 2));
	fs.mkdirSync(path.join(dir, "npm", "node_modules", "present"), { recursive: true });

	// A wrong root would resolve every entry somewhere else and delete all of
	// them, so the root is an explicit parameter rather than dirname(target).
	const res = applyPruneMissingPackages(file, dir);
	assert.equal(res.ok, true);
	assert.match(res.message, /npm:gone/);
	assert.doesNotMatch(res.message, /npm:present/);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).packages, ["npm:present"]);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("prune keeps an entry it cannot stat for any reason other than absence", async () => {
	const { applyPruneMissingPackages } = await import("../src/repair.js");
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:locked", "npm:gone"] }));
	const locked = path.join(dir, "npm", "node_modules", "locked");
	fs.mkdirSync(locked, { recursive: true });

	const original = fs.statSync;
	fs.statSync = (target, ...rest) => {
		if (String(target) === locked) {
			const err = new Error("EACCES");
			err.code = "EACCES";
			throw err;
		}
		return original.call(fs, target, ...rest);
	};
	try {
		const res = applyPruneMissingPackages(file, dir);
		assert.match(res.message, /npm:gone/);
		// Only a path that is genuinely gone justifies deleting a settings entry;
		// a permissions problem must not be silently "repaired" away.
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).packages, ["npm:locked"]);
	} finally {
		fs.statSync = original;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("two repairs in the same millisecond never clobber each other's backup", async () => {
	const { applyDedupePackages } = await import("../src/repair.js");
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:a", "npm:a", "npm:b", "npm:b"] }));
	applyDedupePackages(file);
	// Put the duplicates back and repair again inside the same millisecond.
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:a", "npm:a"] }));
	applyDedupePackages(file);

	const backups = fs.readdirSync(dir).filter((f) => f.startsWith("settings.json.checkup-bak-"));
	// COPYFILE_EXCL turns a name collision into a retry instead of a silent loss
	// of the only recovery point the first repair created.
	assert.equal(backups.length, 2, backups.join(", "));
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a repair leaves no temp file behind", async () => {
	const { applyDedupePackages } = await import("../src/repair.js");
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:a", "npm:a"] }));
	applyDedupePackages(file);
	const leftovers = fs.readdirSync(dir).filter((f) => f.includes("checkup-tmp"));
	assert.deepEqual(leftovers, []);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a repair preserves the file mode", async () => {
	const { applyDedupePackages } = await import("../src/repair.js");
	if (process.platform === "win32") return; // POSIX modes do not apply
	const dir = tmp();
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, JSON.stringify({ packages: ["npm:a", "npm:a"] }), { mode: 0o600 });
	fs.chmodSync(file, 0o600);
	applyDedupePackages(file);
	// A 0600 models.json must not come back 0644 through the rename.
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a symlinked config is repaired in place, not replaced by a regular file", () => {
	// Dotfiles installs keep settings.json as a symlink into a repo. Renaming over
	// the link would silently detach the config from the file the user edits.
	const dir = tmp();
	const real = path.join(dir, "dotfiles-settings.json");
	const link = path.join(dir, "settings.json");
	fs.writeFileSync(real, JSON.stringify({ packages: ["npm:a", "npm:a"] }, null, 2));
	fs.symlinkSync(real, link);

	const result = applyDedupePackages(link);
	assert.equal(result.ok, true);
	assert.ok(fs.lstatSync(link).isSymbolicLink(), "the symlink was replaced by a regular file");
	assert.deepEqual(JSON.parse(fs.readFileSync(real, "utf8")).packages, ["npm:a"]);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a failed write leaves no temp file behind", () => {
	const dir = tmp();
	const missing = path.join(dir, "nope", "settings.json");
	const result = applyDedupePackages(missing);
	// The message must name the real problem: "not valid JSON" for a path that
	// does not exist sends the reader hunting for a syntax error.
	assert.equal(result.ok, false);
	assert.match(result.message, /does not exist/);
	assert.doesNotMatch(result.message, /valid JSON/);
	const leftovers = fs.readdirSync(dir).filter((n) => n.includes("checkup-tmp-"));
	assert.deepEqual(leftovers, []);
	fs.rmSync(dir, { recursive: true, force: true });
});
