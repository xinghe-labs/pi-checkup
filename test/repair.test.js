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
		JSON.stringify({ packages: ["npm:a", "npm:b", { source: "npm:a" }, "npm:c"] }, null, 2),
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
	const ctx = buildContext({});
	assert.equal(ctx.hasRuntime, false);
	assert.equal(ctx.pi, null);
	// Whatever the file holds, the source must not claim to be the runtime.
	assert.notEqual(ctx.settingsSource, "runtime");
});
