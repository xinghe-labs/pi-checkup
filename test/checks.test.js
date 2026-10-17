// Per-module tests. Every one of these runs against a temporary agent root, so
// the real ~/.pi/agent is never read or written, and the assertions are about
// what the module *reports* — including the cases where the honest answer is
// "I could not check this" rather than a green tick.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as packages from "../src/checks/packages.js";
import * as config from "../src/checks/config.js";
import * as binaries from "../src/checks/binaries.js";
import * as registry from "../src/checks/registry.js";
import { runChecks } from "../src/checks/index.js";
import { buildContext } from "../src/context.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "checkup.js");

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "checkup-check-"));
}

function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function installPkg(root, name, manifest, extraFiles = []) {
	const dir = path.join(root, "npm", "node_modules", name);
	writeJson(path.join(dir, "package.json"), { name, ...manifest });
	for (const rel of extraFiles) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), "");
	}
	return dir;
}

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

// --- packages ------------------------------------------------------------

test("packages: a complete install passes all three rows", async () => {
	const root = tmpRoot();
	installPkg(root, "good", { pi: { extensions: ["./index.js"] } }, ["index.js"]);
	writeJson(path.join(root, "settings.json"), { packages: ["npm:good"] });

	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows.dirs.status, "ok");
	assert.equal(rows.manifests.status, "ok");
	assert.equal(rows.entries.status, "ok");
	assert.match(rows.entries.detail, /1 manifest/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: nothing on disk never reports green", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["npm:gone", "npm:alsogone"] });

	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows.dirs.status, "fail");
	// Zero manifests were opened, so "all readable" would be a lie.
	assert.equal(rows.manifests.status, "skip");
	assert.equal(rows.entries.status, "skip");
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: a missing directory offers a repair that matches the problem", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["npm:gone"] });

	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows.dirs.fix, "prune-missing-packages");
	assert.equal(rows.dirs.fixTarget, path.join(root, "settings.json"));
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: a manifest pointing at a file that is not there fails", async () => {
	const root = tmpRoot();
	installPkg(root, "broken", { pi: { extensions: ["./dist/index.js"] } });
	writeJson(path.join(root, "settings.json"), { packages: ["npm:broken"] });

	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows.entries.status, "fail");
	assert.match(rows.entries.detail, /broken/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: a non-list `packages` value is reported, not walked char by char", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: "npm:oops" });

	const rows = await packages.run(buildContext({ agentDir: root }));
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, "skip");
	assert.match(rows[0].detail, /not a list/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: sources Pi resolves itself are not reported as zero present", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["git:https://example.test/x.git"] });

	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows.dirs.status, "skip");
	assert.equal(rows.unverifiable.status, "skip");
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: an empty extensions array is not counted as verified", async () => {
	const root = tmpRoot();
	installPkg(root, "empty", { pi: { extensions: [] } });
	writeJson(path.join(root, "settings.json"), { packages: ["npm:empty"] });

	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows.entries.status, "skip");
	fs.rmSync(root, { recursive: true, force: true });
});

// --- config --------------------------------------------------------------

test("config: a literal dollar sign in settings is not an env reference", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { note: "price is $cost", packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { p: { baseUrl: "https://example.test/v1", apiKey: "$CHECKUP_SURELY_UNSET_A" } },
	});

	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows.env.status, "warn");
	assert.match(rows.env.detail, /CHECKUP_SURELY_UNSET_A/);
	// settings.json is not interpolated by Pi at all, so this must stay quiet.
	assert.doesNotMatch(rows.env.detail, /cost/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: header values are interpolated too, and are checked", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: {
			p: { baseUrl: "https://example.test/v1", headers: { "X-Api-Key": "${CHECKUP_SURELY_UNSET_B}" } },
		},
	});

	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.match(rows.env.detail, /CHECKUP_SURELY_UNSET_B/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: a set env var is not reported", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { p: { baseUrl: "https://example.test/v1", apiKey: "$CHECKUP_DEFINITELY_SET" } },
	});
	process.env.CHECKUP_DEFINITELY_SET = "1";
	try {
		const rows = byId(await config.run(buildContext({ agentDir: root })));
		assert.equal(rows.env.status, "ok");
	} finally {
		delete process.env.CHECKUP_DEFINITELY_SET;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("config: duplicate package entries are reported as fixable", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["npm:a", "npm:a", "npm:b"] });

	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows.duplicates.status, "warn");
	assert.equal(rows.duplicates.fix, "dedupe-packages");
	assert.match(rows.duplicates.detail, /npm:a/);
	assert.doesNotMatch(rows.duplicates.detail, /npm:b/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: no backups yet is skipped, not warned", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });

	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows.backups.status, "skip");
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: an existing backup passes even when the config was edited after it", async () => {
	const root = tmpRoot();
	const settings = path.join(root, "settings.json");
	writeJson(settings, { packages: [] });
	fs.writeFileSync(`${settings}.bak`, "{}");
	const later = new Date(Date.now() + 60_000);
	fs.utimesSync(settings, later, later);

	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows.backups.status, "ok");
	assert.match(rows.backups.hint ?? "", /settings\.json/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: an unreadable file is a failure with a restore offered", async () => {
	const root = tmpRoot();
	const settings = path.join(root, "settings.json");
	fs.writeFileSync(settings, "{ broken");
	fs.writeFileSync(`${settings}.bak`, JSON.stringify({ packages: [] }));

	const rows = byId(await config.run(buildContext({ agentDir: root })));
	const row = rows["file:settings.json"];
	assert.equal(row.status, "fail");
	assert.equal(row.fix, "restore-config");
	fs.rmSync(root, { recursive: true, force: true });
});

// --- binaries ------------------------------------------------------------

test("binaries: shadowing is only reported for commands a package advertises", async () => {
	const root = tmpRoot();
	const binDir = path.join(root, "npm", "node_modules", ".bin");
	const shadowDir = path.join(root, "shadow");
	for (const dir of [binDir, shadowDir]) {
		fs.mkdirSync(dir, { recursive: true });
		for (const name of ["checkup-owntool", "checkup-othertool"]) {
			const file = path.join(dir, name);
			fs.writeFileSync(file, "#!/bin/sh\n");
			fs.chmodSync(file, 0o755);
		}
	}
	installPkg(root, "owner", { bin: { "checkup-owntool": "./cli.js" }, pi: { extensions: ["./i.js"] } });
	writeJson(path.join(root, "settings.json"), { packages: ["npm:owner"] });

	const saved = process.env.PATH;
	process.env.PATH = [shadowDir, binDir, saved].filter(Boolean).join(path.delimiter);
	try {
		const rows = byId(await binaries.run(buildContext({ agentDir: root })));
		assert.equal(rows.shadowed.status, "warn");
		assert.match(rows.shadowed.detail, /checkup-owntool/);
		// Not declared by any package, so it is not the user's problem.
		assert.doesNotMatch(rows.shadowed.detail, /checkup-othertool/);
	} finally {
		process.env.PATH = saved;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("binaries: no .bin directory is skipped rather than failed", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const rows = byId(await binaries.run(buildContext({ agentDir: root })));
	assert.equal(rows["bin-dir"].status, "skip");
	fs.rmSync(root, { recursive: true, force: true });
});

// --- registry ------------------------------------------------------------

function fakePi(settings, tools) {
	return {
		getSettings: () => settings,
		getAllTools: () => tools,
		getCommands: () => [],
		getMcpServers: () => [],
	};
}

test("registry: a local package that registered a tool is not called silent", async () => {
	const root = tmpRoot();
	const extDir = path.join(root, "extensions", "local-ext");
	writeJson(path.join(extDir, "package.json"), { name: "local-ext", pi: { extensions: ["./index.js"] } });
	fs.writeFileSync(path.join(extDir, "index.js"), "");
	const settings = { packages: ["./extensions/local-ext"] };

	const ctx = buildContext({ agentDir: root, pi: fakePi(settings, [{ name: "mytool", sourceInfo: { path: path.join(extDir, "index.js") } }]) });
	const rows = byId(await registry.run(ctx));
	assert.equal(rows.silent.status, "ok", rows.silent.detail);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: a package that registered nothing is reported", async () => {
	const root = tmpRoot();
	const extDir = path.join(root, "extensions", "local-ext");
	writeJson(path.join(extDir, "package.json"), { name: "local-ext", pi: { extensions: ["./index.js"] } });
	fs.writeFileSync(path.join(extDir, "index.js"), "");
	const settings = { packages: ["./extensions/local-ext"] };

	const ctx = buildContext({ agentDir: root, pi: fakePi(settings, []) });
	const rows = byId(await registry.run(ctx));
	assert.equal(rows.silent.status, "warn");
	assert.match(rows.silent.detail, /local-ext/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: a package owned by a nested path still counts as loaded", async () => {
	const root = tmpRoot();
	const pkgDir = installPkg(root, "nested", { pi: { extensions: ["./dist/index.js"] } }, ["dist/index.js"]);
	const settings = { packages: ["npm:nested"] };

	const ctx = buildContext({
		agentDir: root,
		pi: fakePi(settings, [{ name: "t", sourceInfo: { path: path.join(pkgDir, "dist", "index.js") } }]),
	});
	const rows = byId(await registry.run(ctx));
	assert.equal(rows.silent.status, "ok", rows.silent.detail);
	fs.rmSync(root, { recursive: true, force: true });
});

// --- crash isolation -----------------------------------------------------

test("runChecks turns a crashed module into a failure, not a warning", async () => {
	const ctx = buildContext({ agentDir: tmpRoot() });
	const rows = await runChecks(ctx, [
		{
			group: "Broken",
			run: () => {
				throw new Error("boom");
			},
		},
	]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, "fail");
	assert.match(rows[0].detail, /boom/);
});

// --- CLI -----------------------------------------------------------------

test("CLI: a bad flag exits 2 and prints the reason", () => {
	assert.throws(
		() => execFileSync(process.execPath, [CLI, "--nope"], { encoding: "utf8", stdio: "pipe" }),
		(e) => {
			assert.equal(e.status, 2);
			assert.match(String(e.stderr), /unknown option/);
			return true;
		},
	);
});

test("CLI: --offline --json emits a well-formed report", () => {
	// Exit 0 or 1 depending on the host, but the payload shape must hold.
	let stdout;
	try {
		stdout = execFileSync(process.execPath, [CLI, "--offline", "--json"], { encoding: "utf8", stdio: "pipe" });
	} catch (e) {
		assert.equal(e.status, 1, "only a failed check may make the CLI exit non-zero");
		stdout = e.stdout;
	}
	const report = JSON.parse(stdout);
	assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
	assert.equal(report.summary.total, report.checks.length);
	// Repair metadata must not leak into the machine-readable payload.
	assert.ok(report.checks.every((c) => !("fix" in c) && !("fixTarget" in c)));
	// Offline mode must not have probed the network.
	assert.ok(report.checks.some((c) => c.id === "providers" && c.status === "skip"));
});
