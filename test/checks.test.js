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

test("packages: an empty list is not a malformed config", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const rows = await packages.run(buildContext({ agentDir: root }));
	// `[]` is truthy, so a truthiness test called this a broken config on every
	// fresh install.
	assert.equal(rows[0].status, "skip");
	assert.match(rows[0].detail, /no packages/);
	assert.doesNotMatch(rows[0].detail, /not a list/);
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
	// The stale note lives in the detail so the default report shows it: a hint on
	// an ok row is only rendered under --verbose, and this is the one caveat a
	// user needs before their next edit.
	assert.match(rows.backups.detail, /settings\.json/);
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

test("binaries: a leftover staging link from an interrupted install is not a broken command", async () => {
	const root = tmpRoot();
	const pkg = installPkg(root, "pi-thing", { bin: { "pi-thing": "cli.js" } }, ["cli.js"]);
	const binDir = path.join(root, "npm", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	fs.symlinkSync(path.join(pkg, "cli.js"), path.join(binDir, "pi-thing"));
	// npm writes .<name>-<random> and renames it into place, so one of these means
	// an install is in flight, not that the package is damaged.
	fs.symlinkSync(path.join(pkg, "gone.js"), path.join(binDir, ".pi-thing-BxfjvsL8"));

	const rows = byId(await binaries.run(buildContext({ agentDir: root })));
	assert.equal(rows.dangling.status, "ok", rows.dangling.detail);
	assert.equal(rows.dangling.detail, "1 entries all resolve");
	assert.equal(rows.staging.status, "warn");
	assert.match(rows.staging.detail, /leftover staging link/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("binaries: a real dangling link still fails", async () => {
	const root = tmpRoot();
	const pkg = installPkg(root, "pi-thing", { bin: { "pi-thing": "cli.js" } }, ["cli.js"]);
	const binDir = path.join(root, "npm", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	fs.symlinkSync(path.join(pkg, "gone.js"), path.join(binDir, "pi-thing"));
	const rows = byId(await binaries.run(buildContext({ agentDir: root })));
	assert.equal(rows.dangling.status, "fail");
	assert.match(rows.dangling.detail, /pi-thing/);
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

test("registry: a package declaring an empty extensions list is not silent", async () => {
	const root = tmpRoot();
	const dir = installPkg(root, "nothing", { pi: { extensions: [] } });
	const settings = { packages: ["npm:nothing"] };

	const ctx = buildContext({ agentDir: root, pi: fakePi(settings, []) });
	const rows = byId(await registry.run(ctx));
	assert.equal(rows.silent.status, "ok", rows.silent.detail);
	assert.ok(dir);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: a source path differing only in case is still the same package", { skip: process.platform === "linux" ? "case-sensitive filesystem" : false }, async () => {
	const root = tmpRoot();
	const extDir = path.join(root, "extensions", "Case-Ext");
	writeJson(path.join(extDir, "package.json"), { name: "case-ext", pi: { extensions: ["./index.js"] } });
	fs.writeFileSync(path.join(extDir, "index.js"), "");
	const settings = { packages: ["./extensions/Case-Ext"] };

	// Windows and macOS report the path with a different case than the one the
	// user typed; that must not read as "registered nothing".
	const ctx = buildContext({
		agentDir: root,
		pi: fakePi(settings, [{ name: "t", sourceInfo: { path: path.join(root, "extensions", "case-ext", "index.js") } }]),
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

/** Run the CLI against a temporary agent root, never the developer's real one. */
function runCli(root, args) {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], {
			encoding: "utf8",
			stdio: "pipe",
			env: { ...process.env, PI_CODING_AGENT_DIR: root, https_proxy: "", all_proxy: "" },
		});
		return { status: 0, stdout };
	} catch (e) {
		return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

/** A temp agent root that is as close to healthy as a temp root can be. */
function healthyRoot() {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	// A provider is needed for the network rows to exist at all: without it the
	// module reports one unreadable-models row and never reaches the probe plan.
	writeJson(path.join(root, "models.json"), { providers: { p: { baseUrl: "https://example.invalid/v1", apiKey: "x" } } });
	fs.mkdirSync(path.join(root, "bin"), { recursive: true });
	fs.writeFileSync(path.join(root, "bin", "pi"), "#!/bin/sh\n");
	fs.chmodSync(path.join(root, "bin", "pi"), 0o755);
	return root;
}

test("CLI: a bad flag exits 2 and prints the reason", () => {
	const { status, stderr } = runCli(healthyRoot(), ["--nope"]);
	assert.equal(status, 2);
	assert.match(stderr, /unknown option/);
});

test("CLI: --json --fix is a usage error rather than a silent no-op", () => {
	const { status, stderr } = runCli(healthyRoot(), ["--json", "--fix"]);
	assert.equal(status, 2);
	assert.match(stderr, /cannot be combined/);
});

test("CLI: --offline --json emits a well-formed report", () => {
	const { status, stdout } = runCli(healthyRoot(), ["--offline", "--json"]);
	assert.equal(status, 0, "a healthy temp root must not fail");
	const report = JSON.parse(stdout);
	assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
	assert.equal(report.summary.total, report.checks.length);
	// Repair metadata must not leak into the machine-readable payload.
	assert.ok(report.checks.every((c) => !("fix" in c) && !("fixTarget" in c)));
	// Offline mode must not have probed the network.
	assert.ok(report.checks.some((c) => c.id === "providers" && c.status === "skip"));
	// The dns row stays in the report so the check count does not change between
	// offline and online runs of the same install.
	assert.ok(report.checks.some((c) => c.id === "dns" && c.status === "skip"));
});

test("CLI: repairing the only failure makes the exit code 0", () => {
	const root = healthyRoot();
	const settings = path.join(root, "settings.json");
	fs.writeFileSync(settings, '{ "broken": ');
	fs.writeFileSync(`${settings}.bak`, JSON.stringify({ packages: [] }));

	// Baseline: broken config, exit 1.
	assert.equal(runCli(root, ["--offline"]).status, 1);

	// After the repair the tree is healthy, so `pi-checkup --fix -y && start-pi`
	// does what it looks like it does.
	const fixed = runCli(root, ["--offline", "--fix", "-y"]);
	assert.equal(fixed.status, 0, fixed.stdout);
	assert.match(fixed.stdout, /restored settings\.json/);
	assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")).packages, []);
	// The broken copy is kept so the repair is reversible by hand.
	assert.ok(fs.readdirSync(root).some((f) => f.startsWith("settings.json.broken-")));
});

test("CLI: --fix without --yes only lists the repairs", () => {
	const root = healthyRoot();
	const settings = path.join(root, "settings.json");
	fs.writeFileSync(settings, '{ "broken": ');
	fs.writeFileSync(`${settings}.bak`, JSON.stringify({ packages: [] }));
	const { status, stdout } = runCli(root, ["--offline", "--fix"]);
	assert.equal(status, 1, "nothing was repaired, so the failure stands");
	assert.match(stdout, /Re-run with --fix --yes/);
	assert.equal(fs.readFileSync(settings, "utf8"), '{ "broken": ');
});

test("PI_CHECKUP_IGNORE downgrades a matching row to skip and says so", async () => {
	const { parseIgnore, applyIgnore } = await import("../src/checks/index.js");
	const rows = [
		{ group: "Binaries", id: "unreachable", title: "unreachable bins", status: "warn", detail: "d", fix: "x", fixTarget: "y" },
		{ group: "Config", id: "env", title: "env references", status: "warn", detail: "d" },
	];
	const out = applyIgnore(rows, parseIgnore("unreachable, Config:env"));
	assert.equal(out[0].status, "skip");
	assert.match(out[0].detail, /ignored via PI_CHECKUP_IGNORE \(would be warn\)/);
	// A suppressed repair must not stay armed.
	assert.equal(out[0].fix, undefined);
	assert.equal(out[1].status, "skip");
	// Rows that were not named are untouched.
	const untouched = applyIgnore(rows, parseIgnore("nothing"));
	assert.deepEqual(untouched.map((r) => r.status), ["warn", "warn"]);
});

test("config: an exported but empty variable counts as unset", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { p: { apiKey: "$PI_CHECKUP_EMPTY_VAR" } } });
	const saved = process.env.PI_CHECKUP_EMPTY_VAR;
	process.env.PI_CHECKUP_EMPTY_VAR = "";
	try {
		const rows = byId(await config.run(buildContext({ agentDir: root })));
		// An empty string cannot authenticate anything, so it must not read as set.
		assert.equal(rows.env.status, "warn");
		assert.match(rows.env.detail, /PI_CHECKUP_EMPTY_VAR/);
	} finally {
		if (saved === undefined) delete process.env.PI_CHECKUP_EMPTY_VAR;
		else process.env.PI_CHECKUP_EMPTY_VAR = saved;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: no env references is skipped, not an empty green tick", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { p: { apiKey: "literal-key" } } });
	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows.env.status, "skip");
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: in-session duplicates are reported but not offered as a file repair", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["npm:a", "npm:a"] });
	// A live session supplies settings from the process, not from the file.
	const pi = { getSettings: () => ({ packages: ["npm:a", "npm:a"] }) };
	const rows = byId(await config.run(buildContext({ agentDir: root, pi })));
	// The list the check saw may have come from the running process, so rewriting
	// the file on disk would edit a copy the report never inspected.
	assert.equal(rows.duplicates.status, "warn");
	assert.equal(rows.duplicates.fix, undefined);
	assert.equal(rows["file:settings.json"].detail, "valid JSON (values read from the running session)");
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: hints name a command the caller can actually run", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["npm:a", "npm:a"] });
	const cli = byId(await config.run(buildContext({ agentDir: root, hasRuntime: false })));
	assert.match(cli.duplicates.hint, /npx pi-checkup --fix/);
	const pi = { getSettings: () => ({ packages: ["npm:a", "npm:a"] }) };
	const live = byId(await config.run(buildContext({ agentDir: root, pi })));
	assert.match(live.duplicates.hint, /\/checkup fix/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: a cleartext key is reported even in --offline mode", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { p: { baseUrl: "http://api.example.com/v1", apiKey: "sk-live-SECRET" } },
	});
	const network = await import("../src/checks/network.js");
	const rows = await network.run({ offline: true, agentDir: root, modelsFile: path.join(root, "models.json") });
	const cleartext = rows.find((r) => r.id === "cleartext");
	// Whether a key would cross the wire in the clear is a property of the config,
	// not of the probe, so offline mode must still surface it.
	assert.ok(cleartext, JSON.stringify(rows));
	assert.equal(cleartext.status, "warn");
	assert.ok(!JSON.stringify(rows).includes("sk-live-SECRET"));
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: an IPv6 loopback provider does not fail DNS", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { local: { baseUrl: "http://[::1]:11434/v1" } },
	});
	const network = await import("../src/checks/network.js");
	// Not offline: the point is the DNS phase, and the only traffic this can
	// generate is a refused connection to ::1 on this machine.
	const rows = await network.run({ offline: false, agentDir: root, modelsFile: path.join(root, "models.json") });
	// ::1 is loopback: it is deliberately not looked up, so the row must say it
	// skipped rather than claim the host resolved.
	const dns = rows.find((r) => r.id === "dns");
	assert.equal(dns.status, "skip");
	assert.match(dns.detail, /loopback/);
	assert.ok(!rows.some((r) => r.status === "fail"));
	fs.rmSync(root, { recursive: true, force: true });
});
