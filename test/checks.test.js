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
import * as network from "../src/checks/network.js";
import * as runtime from "../src/checks/runtime.js";
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

/** Proxied probes shell out to curl, so tests that need one must skip without it. */
function hasCurl() {
	try {
		execFileSync("curl", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

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
	// A survivor in the list is what makes the repair meaningful: prune keeps the
	// git source and drops the entry whose directory is gone.
	writeJson(path.join(root, "settings.json"), { packages: ["npm:gone", "git:https://github.com/me/ext"] });

	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows.dirs.fix, "prune-missing-packages");
	assert.equal(rows.dirs.fixTarget, path.join(root, "settings.json"));
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: no repair is offered when pruning would empty the list", async () => {
	// Every entry is gone, which is also the signature of a mistyped
	// PI_CODING_AGENT_DIR. The repair would refuse, so advertising it means
	// offering the user a command that answers "no" — and the hint has to carry
	// the reason instead.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["npm:gone"] });

	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows.dirs.status, "fail");
	assert.equal(rows.dirs.fix, undefined);
	assert.equal(rows.dirs.fixTarget, undefined);
	assert.match(rows.dirs.hint, /PI_CODING_AGENT_DIR/);
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
	// warn, not skip: a non-list value is a fault in the config, and `skip` is
	// reserved for "there was nothing to inspect".
	assert.equal(rows[0].status, "warn");
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
	const env = { ...process.env, CHECKUP_DEFINITELY_SET: "1" };
	try {
		const rows = byId(await config.run(buildContext({ agentDir: root, env })));
		assert.equal(rows.env.status, "ok");
	} finally {
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

test("packages: unparseable settings.json is reported as unreadable, not as empty", async () => {
	const root = tmpRoot();
	fs.writeFileSync(path.join(root, "settings.json"), "{ broken");
	const rows = await packages.run(buildContext({ agentDir: root }));
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, "warn");
	assert.match(rows[0].detail, /could not be inspected/);
	// The old copy claimed there were no packages in a file it failed to parse.
	assert.doesNotMatch(rows[0].detail, /no packages/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: an entry that is not a package source is reported as such", async () => {
	// These used to land in `unverifiable` and print as "2 source(s) ... null,
	// null", which describes nothing the user can act on.
	const root = tmpRoot();
	installPkg(root, "ok", { pi: { extensions: ["./i.js"] } }, ["i.js"]);
	writeJson(path.join(root, "settings.json"), {
		packages: [null, 42, "npm:ok", { token: "ghp_do_not_echo_me" }],
	});
	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows["entries-shape"].status, "warn");
	assert.match(rows["entries-shape"].detail, /null, number 42/);
	// The entry is described by shape, not by value: an object entry can carry a
	// token, and printing it put the secret in the report and in `--json`.
	assert.match(rows["entries-shape"].detail, /an object with keys token/);
	assert.doesNotMatch(rows["entries-shape"].detail, /ghp_do_not_echo_me/);
	assert.equal(rows.unverifiable, undefined);
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: a non-string pi.extensions entry does not crash the module", async () => {
	// `pattern.includes is not a function` escaped this module and the runner
	// replaced every package finding with a single "check crashed" row.
	const root = tmpRoot();
	installPkg(root, "bad", { pi: { extensions: [null, { file: "index.js" }] } });
	writeJson(path.join(root, "settings.json"), { packages: ["npm:bad"] });
	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows["manifest-shape"]?.status, "warn");
	assert.match(rows["manifest-shape"].detail, /non-string/);
	// The rest of the module still reports: one bad manifest does not blind it.
	assert.equal(rows.dirs.status, "ok");
	fs.rmSync(root, { recursive: true, force: true });
});

// --- binaries ------------------------------------------------------------

test("binaries: shadowing is only reported for commands a package advertises", async () => {
	const root = tmpRoot();
	const binDir = path.join(root, "npm", "node_modules", ".bin");
	const shadowDir = path.join(root, "shadow");
	// whichAll appends PATHEXT on Windows, so an extension-less fixture is a file
	// no lookup can ever find there.
	const exe = process.platform === "win32" ? ".exe" : "";
	for (const dir of [binDir, shadowDir]) {
		fs.mkdirSync(dir, { recursive: true });
		for (const name of ["checkup-owntool", "checkup-othertool"]) {
			const file = path.join(dir, name + exe);
			fs.writeFileSync(file, "#!/bin/sh\n");
			fs.chmodSync(file, 0o755);
		}
	}
	installPkg(root, "owner", { bin: { "checkup-owntool": "./cli.js" }, pi: { extensions: ["./i.js"] } });
	writeJson(path.join(root, "settings.json"), { packages: ["npm:owner"] });

	// The PATH the check sees comes from the context, so this test describes a
	// shadowed command without changing the PATH of the suite running it.
	const env = { ...process.env, PATH: [shadowDir, binDir, process.env.PATH].filter(Boolean).join(path.delimiter) };
	try {
		const rows = byId(await binaries.run(buildContext({ agentDir: root, env })));
		assert.equal(rows.shadowed.status, "warn");
		assert.match(rows.shadowed.detail, /checkup-owntool/);
		// Not declared by any package, so it is not the user's problem.
		assert.doesNotMatch(rows.shadowed.detail, /checkup-othertool/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("binaries: a correctly linked package command is not shadowed", async () => {
	// The negative case: the PATH hit *is* the link npm created. Nothing asserted
	// this, so a regression that flagged every declared command as shadowed would
	// have passed the suite.
	const root = tmpRoot();
	const binDir = path.join(root, "npm", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	// npm writes a `foo.cmd` shim next to the extensionless one on Windows, and
	// `whichAll` resolves commands through PATHEXT there. Creating only the
	// extensionless file made this a skip on Windows instead of the assertion it
	// is meant to be.
	const link = path.join(binDir, process.platform === "win32" ? "checkup-owntool.cmd" : "checkup-owntool");
	fs.writeFileSync(link, "#!/bin/sh\n");
	fs.chmodSync(link, 0o755);
	installPkg(root, "owner", { bin: { "checkup-owntool": "./cli.js" }, pi: { extensions: ["./i.js"] } });
	writeJson(path.join(root, "settings.json"), { packages: ["npm:owner"] });

	const env = { ...process.env, PATH: binDir };
	try {
		const rows = byId(await binaries.run(buildContext({ agentDir: root, env })));
		assert.equal(rows.shadowed.status, "ok");
		assert.equal(rows.shadowed.detail, "none");
		assert.equal(rows.unreachable, undefined, "a command on PATH must not be called unreachable");
	} finally {
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

test("binaries: a leftover staging link from an interrupted install is not a broken command", async (t) => {
	const root = tmpRoot();
	const pkg = installPkg(root, "pi-thing", { bin: { "pi-thing": "cli.js" } }, ["cli.js"]);
	const binDir = path.join(root, "npm", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	linkOrSkip(t, path.join(pkg, "cli.js"), path.join(binDir, "pi-thing"));
	// npm writes .<name>-<random> and renames it into place, so one of these means
	// an install is in flight, not that the package is damaged.
	linkOrSkip(t, path.join(pkg, "gone.js"), path.join(binDir, ".pi-thing-BxfjvsL8"));

	const rows = byId(await binaries.run(buildContext({ agentDir: root })));
	assert.equal(rows.dangling.status, "ok", rows.dangling.detail);
	assert.equal(rows.dangling.detail, "1 link all resolve");
	assert.equal(rows.staging.status, "warn");
	assert.match(rows.staging.detail, /leftover staging link/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("binaries: a real dangling link still fails", async (t) => {
	const root = tmpRoot();
	const pkg = installPkg(root, "pi-thing", { bin: { "pi-thing": "cli.js" } }, ["cli.js"]);
	const binDir = path.join(root, "npm", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	linkOrSkip(t, path.join(pkg, "gone.js"), path.join(binDir, "pi-thing"));
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

test("runtime: an agent dir that is a file cannot be opened", async () => {
	// `exists()` is `access(F_OK)`: a regular file passed it, so a typo in
	// PI_CODING_AGENT_DIR produced no agent-dir row at all while every other
	// check read from a path that is not a directory.
	const root = tmpRoot();
	const file = path.join(root, "not-a-dir");
	fs.writeFileSync(file, "");
	const rows = byId(await runtime.run(buildContext({ agentDir: file, env: {} })));
	assert.equal(rows["agent-dir"].status, "warn");
	assert.match(rows["agent-dir"].detail, /could not be opened/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("runtime: a missing agent directory is a warning, not a clean sweep", async () => {
	// Every check skips when there is no install to inspect, and a report of
	// "2 ok, 12 skipped" with a green verdict reads as a healthy install.
	const root = path.join(os.tmpdir(), `checkup-absent-${process.pid}-${Math.floor(performance.now())}`);
	const rows = byId(await runtime.run({ agentDir: root, offline: true, env: {} }));
	assert.equal(rows["agent-dir"].status, "warn");
	assert.match(rows["agent-dir"].detail, /does not exist/);
});

test("registry: an unreadable tool registry does not report zero collisions", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const pi = {
		getSettings: () => ({ packages: [] }),
		getAllTools: () => {
			throw new Error("getAllTools is not a function");
		},
		getCommands: () => [],
		getMcpServers: () => [],
	};
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi })));
	assert.equal(rows.tools.status, "warn");
	assert.equal(rows["tool-collisions"].status, "skip");
	assert.match(rows["tool-collisions"].detail, /could not be read/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: two unattributed registrations of one name are a collision", async () => {
	// Both resolve to owner "unknown"; de-duplicating by label hid the collision.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const pi = fakePi({ packages: [] }, [{ name: "dup" }, { name: "dup" }]);
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi })));
	assert.equal(rows["tool-collisions"].status, "fail");
	assert.match(rows["tool-collisions"].detail, /dup claimed by/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: a package declaring an empty extensions list is not silent", async () => {
	const root = tmpRoot();
	installPkg(root, "nothing", { pi: { extensions: [] } });
	const settings = { packages: ["npm:nothing"] };

	const ctx = buildContext({ agentDir: root, pi: fakePi(settings, []) });
	const rows = byId(await registry.run(ctx));
	// Nothing declared an extension to load, so nothing was compared: skip, not a
	// green tick over zero inspected packages.
	assert.equal(rows.silent.status, "skip", rows.silent.detail);
	assert.match(rows.silent.detail, /no inspectable package declares an extension/);
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

test("runChecks: a module that never settles becomes a timeout failure", async () => {
	// The timeout branch had no coverage at all: the crash test only exercises a
	// throw, which is the easy half.
	const rows = await runChecks(
		buildContext({ agentDir: tmpRoot() }),
		[{ group: "Broken", run: () => new Promise(() => {}) }],
		{ timeoutMs: 20 },
	);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].id, "timeout:Broken");
	assert.equal(rows[0].status, "fail");
	assert.match(rows[0].detail, /did not finish within/);
});

test("network: a credentialed baseUrl is probed without printing the credential", async () => {
	// fetch() refuses a URL that carries credentials, so this provider used to
	// fail with an error message that quoted the password into the report.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { gw: { baseUrl: "https://user:sekrit@127.0.0.1:9/v1", apiKey: "sk-live-nope" } },
	});
	const rows = await network.run(buildContext({ agentDir: root }));
	const text = JSON.stringify(rows);
	assert.doesNotMatch(text, /sekrit/);
	assert.doesNotMatch(text, /sk-live-nope/);
	// The host is still reported, so the row is actionable.
	assert.match(text, /127\.0\.0\.1/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: an unparseable baseUrl is reported without its query string", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { pasted: { baseUrl: "api.example.com/v1?key=sk-live-pasted" } } });
	const rows = await network.run(buildContext({ agentDir: root }));
	const text = JSON.stringify(rows);
	assert.doesNotMatch(text, /sk-live-pasted/);
	assert.match(text, /invalid baseUrl/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: a baseUrl with no scheme is invalid, not an invented DNS failure", async () => {
	// `localhost:11434/v1` parses as scheme `localhost:` with an opaque path, so
	// the probe printed "null unreachable" and the DNS check reported that the
	// empty string does not resolve.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { ollama: { baseUrl: "localhost:11434/v1" } } });
	const rows = byId(await network.run(buildContext({ agentDir: root })));
	const text = JSON.stringify(rows);
	assert.match(text, /invalid baseUrl/);
	assert.doesNotMatch(text, /null unreachable/);
	// The host was never parsed, so there is no host to look up.
	assert.equal(rows.dns.status, "skip");
	assert.match(rows.dns.detail, /no provider host to resolve/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: a literal percent in userinfo does not crash the whole group", async () => {
	// decodeURIComponent throws on `p%ss`, and the throw escaped run(): the whole
	// Network group became one crash row blaming pi-checkup for a config typo.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { gw: { baseUrl: "https://me:p%ss@127.0.0.1:9/v1" } } });
	const rows = await network.run(buildContext({ agentDir: root }));
	const text = JSON.stringify(rows);
	assert.doesNotMatch(text, /crash:/);
	assert.doesNotMatch(text, /p%ss/);
	assert.match(text, /not valid percent-encoding/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: a non-string baseUrl is reported instead of denied", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { broken: { baseUrl: 1234 }, ok: { baseUrl: "http://127.0.0.1:9/v1" } } });
	const rows = byId(await network.run(buildContext({ agentDir: root })));
	assert.equal(rows["baseUrl-shape"].status, "warn");
	assert.match(rows["baseUrl-shape"].detail, /broken \(number\)/);
	assert.doesNotMatch(rows.providers.detail, /no provider with a baseUrl/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: a configured proxy is used, and its password is not printed", { skip: hasCurl() ? false : "curl is not installed" }, async () => {
	// Node's fetch ignores https_proxy entirely, so the probe has to go through
	// curl. The two ports differ on purpose: the proxy's port appearing in the
	// row is what proves the proxy was used, and the password must not appear
	// even though curl's own error text mentions the proxy.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { gw: { baseUrl: "http://127.0.0.1:9/v1" } } });
	const ctx = buildContext({ agentDir: root, env: { ...process.env, https_proxy: "http://alice:sekrit@127.0.0.1:1", all_proxy: "" } });
	const rows = byId(await network.run(ctx));
	const text = JSON.stringify(rows.providers);
	assert.doesNotMatch(text, /sekrit/);
	assert.doesNotMatch(text, /alice/);
	assert.match(text, /127\.0\.0\.1:1/, "the proxy address is reported, so the row is actionable");
	assert.notEqual(rows.providers.status, "ok", "a dead proxy cannot make an endpoint look healthy");
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: a source carrying a token is not printed", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["git:https://ghp_sekrit@github.com/me/private"] });
	const rows = await packages.run(buildContext({ agentDir: root }));
	const text = JSON.stringify(rows);
	assert.doesNotMatch(text, /ghp_sekrit/);
	assert.match(text, /github\.com/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("binaries: a non-array packages value does not take the group down", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: { a: "npm:x" } });
	const rows = await binaries.run(buildContext({ agentDir: root }));
	assert.ok(rows.length > 0);
	assert.ok(rows.every((r) => !String(r.id).startsWith("crash:")));
	fs.rmSync(root, { recursive: true, force: true });
});

test("binaries: no declared command is a skip, not a green tick", async () => {
	const root = tmpRoot();
	installPkg(root, "ext-only", { pi: { extensions: ["./i.js"] } }, ["i.js"]);
	writeJson(path.join(root, "settings.json"), { packages: ["npm:ext-only"] });
	// A .bin directory has to exist for the shadowing pass to run at all.
	fs.mkdirSync(path.join(root, "npm", "node_modules", ".bin"), { recursive: true });
	const rows = byId(await binaries.run(buildContext({ agentDir: root })));
	assert.equal(rows.shadowed.status, "skip");
	assert.match(rows.shadowed.detail, /no package command declared/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: the same source in two shapes is reported without offering dedupe", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["npm:a", { source: "npm:a", enabled: false }] });
	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows.duplicates.status, "warn");
	assert.match(rows.duplicates.detail, /two different shapes/);
	assert.equal(rows.duplicates.fix, undefined, "dedupe refuses these, so the hint must not offer it");
	fs.rmSync(root, { recursive: true, force: true });
});

// --- CLI -----------------------------------------------------------------

/**
 * Create a symlink, or skip the test where that needs a privilege the runner
 * does not have. On Windows `fs.symlinkSync` needs Developer Mode or an elevated
 * shell, so an unguarded call failed the binaries tests on windows-latest for a
 * reason that has nothing to do with the check.
 */
function linkOrSkip(t, target, linkPath) {
	try {
		fs.symlinkSync(target, linkPath);
	} catch (e) {
		t.skip(`symlinks unavailable here (${e.code ?? e.message})`);
	}
}

/** Run the CLI against a temporary agent root, never the developer's real one. */
function runCli(root, args) {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], {
			encoding: "utf8",
			stdio: "pipe",
			// Every variable proxyFromEnv honours is cleared: on the corporate
			// machine this tool targets, an inherited HTTPS_PROXY made these tests
			// probe a real proxy and "a healthy temp root must not fail" could fail.
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: root,
				https_proxy: "",
				HTTPS_PROXY: "",
				http_proxy: "",
				HTTP_PROXY: "",
				all_proxy: "",
				ALL_PROXY: "",
			},
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

test("packages: a pinned spec is resolved to the directory it installs into", async () => {
	// `npm:pi-spend-guard@0.9.1` was looked up as a directory literally named
	// "pi-spend-guard@0.9.1", so an installed package was reported missing and the
	// repair offered to delete the entry from settings.json.
	const root = tmpRoot();
	installPkg(root, "pinned", { version: "0.9.1", pi: { extensions: ["./index.js"] } }, ["index.js"]);
	installPkg(root, "@scope/thing", { version: "2.0.0", pi: { extensions: ["./index.js"] } }, ["index.js"]);
	writeJson(path.join(root, "settings.json"), { packages: ["npm:pinned@0.9.1", "npm:@scope/thing@^2"] });
	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows.dirs.status, "ok");
	assert.match(rows.dirs.detail, /2 present/);
	assert.equal(rows.dirs.fix, undefined);
	// The pin and the disk agree, so there is nothing to say about versions.
	assert.equal(rows["version-pin"], undefined);
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: a pin that does not match the disk is a warning", async () => {
	// The point of a pin is that the code that runs is the code that was asked
	// for; a different version on disk breaks that quietly.
	const root = tmpRoot();
	installPkg(root, "stale", { version: "0.9.2", pi: { extensions: ["./index.js"] } }, ["index.js"]);
	writeJson(path.join(root, "settings.json"), { packages: ["npm:stale@0.9.1"] });
	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows["version-pin"].status, "warn");
	assert.match(rows["version-pin"].detail, /installed 0\.9\.2/);
	assert.match(rows["version-pin"].detail, /npm:stale@0\.9\.1/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: a corrupt file with no backup says where to look", async () => {
	// "No backup found; fix it by hand." is advice without a location. The parse
	// error now carries a line and a column, so the hint can name the file those
	// numbers refer to.
	const root = tmpRoot();
	fs.writeFileSync(path.join(root, "models.json"), '{\n  "providers": {\n    "me": {"apiKey": "x",},\n  },\n}\n');
	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows["file:models.json"].status, "fail");
	assert.match(rows["file:models.json"].detail, /line \d+, column \d+/);
	assert.match(rows["file:models.json"].hint, /models\.json/);
	assert.match(rows["file:models.json"].hint, /line in the message/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: an unset env reference names the provider that needs it", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: {
			work: { baseUrl: "https://api.example.com/v1", apiKey: "${WORK_KEY}" },
			home: { baseUrl: "https://x.example.com/v1", apiKey: "${HOME_KEY}" },
		},
	});
	const rows = byId(await config.run(buildContext({ agentDir: root, env: {} })));
	assert.equal(rows.env.status, "warn");
	assert.match(rows.env.detail, /WORK_KEY/);
	assert.match(rows.env.hint, /work/);
	assert.match(rows.env.hint, /\.env|shell profile/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: a version string is scrubbed before it is cut, not after", async () => {
	// The detail truncates the installed version at 40 characters. Cutting first
	// put the `@` of a `https://user:pass@host` version past the cut, so
	// scrubCredentials had no userinfo left to recognise and the password prefix
	// went straight into the report, the TUI notification and the --json payload.
	const root = tmpRoot();
	installPkg(root, "leaky", { version: "1.0.0+https://alice:supersecret@registry.corp/x", pi: { extensions: ["./index.js"] } }, [
		"index.js",
	]);
	writeJson(path.join(root, "settings.json"), { packages: ["npm:leaky@0.9.1"] });
	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows["version-pin"].status, "warn");
	assert.doesNotMatch(rows["version-pin"].detail, /supersecret/);
	assert.match(rows["version-pin"].detail, /\*\*\*@registry\.corp/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: a package directory with no manifest is not a permissions problem", async () => {
	// An empty or half-extracted directory is a broken install. Reporting it under
	// "unreadable manifests" sent the reader to check ownership of a directory
	// whose permissions were fine.
	const root = tmpRoot();
	fs.mkdirSync(path.join(root, "npm", "node_modules", "hollow"), { recursive: true });
	writeJson(path.join(root, "settings.json"), { packages: ["npm:hollow"] });

	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows["manifests-missing"].status, "warn");
	assert.match(rows["manifests-missing"].detail, /hollow/);
	assert.match(rows["manifests-missing"].hint, /Reinstall/);
	assert.equal(rows["manifests-unreadable"], undefined);
	fs.rmSync(root, { recursive: true, force: true });
});

test("binaries: no command resolved on PATH is not a clean shadowing result", async () => {
	// `shadowed` compared the PATH hit against the shim. With nothing on PATH
	// there is no comparison, and a green tick over zero inspected commands sat
	// next to a row saying the commands were missing.
	const root = tmpRoot();
	installPkg(root, "hidden", { bin: { hidden: "./bin/hidden.js" }, pi: { extensions: ["./index.js"] } }, ["index.js"]);
	writeJson(path.join(root, "settings.json"), { packages: ["npm:hidden"] });
	// The shim exists, so nothing is missing — but PATH is empty of it, which is
	// the state a shell without the .bin directory in PATH produces.
	const binDir = path.join(root, "npm", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(path.join(binDir, "hidden"), "#!/bin/sh\n");

	const rows = byId(await binaries.run(buildContext({ agentDir: root, env: { PATH: "/nonexistent" } })));
	assert.equal(rows.shadowed.status, "skip");
	assert.match(rows.shadowed.detail, /no package command resolved/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("binaries: an unreadable settings file is not reported as \"no command declared\"", async () => {
	// settings.json that does not parse reaches declaredBins() as null, and the
	// old wording asserted the config declared nothing — two groups below a row
	// saying the file could not be read.
	const root = tmpRoot();
	fs.mkdirSync(path.join(root, "npm", "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(path.join(root, "npm", "node_modules", ".bin", "x"), "#!/bin/sh\n");
	const rows = byId(await binaries.run(buildContext({ agentDir: root }))); // no settings file written
	assert.equal(rows.shadowed.status, "skip");
	assert.match(rows.shadowed.detail, /could not be inspected/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("binaries: a truncated list says how many names it left out", async () => {
	// Six names printed under "8 package command(s)" reads as a contradiction.
	const root = tmpRoot();
	const bins = {};
	for (let i = 0; i < 8; i++) bins[`cmd${i}`] = `./bin/cmd${i}.js`;
	installPkg(root, "many", { bin: bins, pi: { extensions: ["./index.js"] } }, ["index.js"]);
	writeJson(path.join(root, "settings.json"), { packages: ["npm:many"] });
	const rows = byId(await binaries.run(buildContext({ agentDir: root, env: { PATH: "" } })));
	const detail = rows["missing-shims"].detail;
	assert.match(detail, /8 declared command\(s\)/);
	assert.match(detail, /\.\.\. 2 more/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("runtime: a machine with no Pi at all is not told another install exists", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const rows = byId(await runtime.run(buildContext({ agentDir: root, env: { PATH: "/nonexistent" } })));
	assert.equal(rows["pi-bin"].status, "warn");
	assert.match(rows["pi-bin"].detail, /no launcher/);
	assert.match(rows["pi-bin"].hint, /No Pi launcher was found/);
	assert.doesNotMatch(rows["pi-bin"].hint, /different install/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("CLI: a missing agent directory is a report, not a crash", async () => {
	// The first `npx pi-checkup` on a machine without Pi: every row has to say
	// "could not inspect", and the verdict must not read as a clean bill.
	const root = path.join(tmpRoot(), "does-not-exist");
	const { status, stdout } = runCli(root, []);
	assert.equal(status, 0);
	assert.doesNotMatch(stdout, /crashed/);
	assert.match(stdout, /checks:/);
	assert.doesNotMatch(stdout, /all clear/);
	fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

test("CLI: a closed pipe keeps the exit code the report implies", async () => {
	// `pi-checkup | head -1` used to exit 0 over a failing run, which turns every
	// `&&` chain that pipes this tool into a green build.
	const { spawn } = await import("node:child_process");
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["npm:gone"] });
	const child = spawn(process.execPath, [CLI, "--offline"], {
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: root,
			https_proxy: "",
			HTTPS_PROXY: "",
			http_proxy: "",
			HTTP_PROXY: "",
			all_proxy: "",
			ALL_PROXY: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Closed before the child has even loaded its modules, so its first write to
	// stdout is an EPIPE rather than a buffered success.
	child.stdout.destroy();
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(code, 1, stderr);
	assert.doesNotMatch(stderr, /crashed/);
	fs.rmSync(root, { recursive: true, force: true });
});

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

test("CLI: a successful prune repair exits 0, not 1", () => {
	// The repair rewrites settings.json, but the checks ran against a context that
	// still held the pre-repair package list, so the re-check reported the entry
	// the repair had just removed and the exit code stayed 1. The restore repair
	// hid this because it re-reads the file on every run.
	const root = healthyRoot();
	const settings = path.join(root, "settings.json");
	// One live package stays behind: a prune that would empty the list is refused
	// on purpose (see the next test), so this case needs something to keep.
	installPkg(root, "keep", { pi: { extensions: ["./i.js"] } }, ["i.js"]);
	fs.writeFileSync(settings, JSON.stringify({ packages: ["npm:gone", "npm:keep"] }));

	assert.equal(runCli(root, ["--offline"]).status, 1);

	const fixed = runCli(root, ["--offline", "--fix", "-y"]);
	assert.match(fixed.stdout, /removed 1 entry/);
	assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")).packages, ["npm:keep"]);
	assert.equal(fixed.status, 0, fixed.stdout);
	assert.doesNotMatch(fixed.stdout.split("Repairs")[1] ?? "", /✗ \d+ failed/, "the post-repair verdict still reports the repaired failure");
});

test("CLI: a package list in which everything is missing is never emptied", () => {
	// A wrong agent directory — a mistyped PI_CODING_AGENT_DIR, a second profile —
	// makes every entry look missing. Deleting them all leaves Pi booting with no
	// packages and no error, so this tool does not offer that repair at all, and
	// the two lines of defence are checked here: the check does not emit the fix,
	// and the repair behind it refuses if it is ever asked.
	const root = healthyRoot();
	const settings = path.join(root, "settings.json");
	fs.writeFileSync(settings, JSON.stringify({ packages: ["npm:gone", "npm:alsogone"] }));

	const fixed = runCli(root, ["--offline", "--fix", "-y", "--verbose"]);
	assert.doesNotMatch(fixed.stdout, /safe repair\(s\) available/);
	assert.match(fixed.stdout, /PI_CODING_AGENT_DIR/);
	assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")).packages, ["npm:gone", "npm:alsogone"]);
	// Nothing was written, so no backup was left behind either.
	assert.equal(fs.readdirSync(root).filter((f) => f.includes("checkup-bak")).length, 0);
});

test("CLI: a successful dedupe clears the duplicate warning", () => {
	// The package directory has to exist, or the prune repair fires first and
	// removes both entries, which would test the wrong repair.
	const root = healthyRoot();
	installPkg(root, "a", { pi: { extensions: ["./i.js"] } }, ["i.js"]);
	fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ packages: ["npm:a", "npm:a"] }));

	const before = runCli(root, ["--offline"]);
	assert.equal(before.status, 0, before.stdout);
	assert.match(before.stdout, /duplicate packages/);

	const fixed = runCli(root, ["--offline", "--fix", "-y"]);
	assert.match(fixed.stdout, /removed 1 duplicate entry/);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")).packages, ["npm:a"]);
	// The re-check has to see the deduplicated list, not the one the context
	// parsed before the repair. The CLI prints only the verdict after a repair, so
	// the verdict is what has to be clean — the old assertion looked for a report
	// body that is never printed and could not fail.
	const after = fixed.stdout.split("Repairs")[1] ?? "";
	assert.match(after, /✓/);
	assert.doesNotMatch(after, /[✗!]/, `post-repair verdict still reports a finding: ${after.trim()}`);
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

test("PI_CHECKUP_IGNORE is case-insensitive and keeps multi-word titles whole", async () => {
	const { parseIgnore, applyIgnore } = await import("../src/checks/index.js");
	const rows = [
		{ group: "Binaries", id: "shadowed", title: "shadowed names", status: "warn", detail: "d" },
		{ group: "Binaries", id: "unreachable", title: "unreachable bins", status: "warn", detail: "d" },
	];
	// The group is "Binaries" in the report and `binaries:` is what a user types.
	assert.equal(applyIgnore(rows, parseIgnore("binaries:shadowed"))[0].status, "skip");
	// A title with a space in it used to be split into two entries that matched
	// nothing, so the row the README documents suppressing stayed a warning.
	assert.equal(applyIgnore(rows, parseIgnore("shadowed names"))[0].status, "skip");
	assert.equal(applyIgnore(rows, parseIgnore("Shadowed Names"))[0].status, "skip");
	assert.deepEqual(parseIgnore(" shadowed names , "), new Set(["shadowed names"]));
});

test("config: an exported but empty variable counts as unset", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { p: { apiKey: "$PI_CHECKUP_EMPTY_VAR" } } });
	// Exported but empty: the variable exists in the environment and still cannot
	// authenticate anything.
	const env = { ...process.env, PI_CHECKUP_EMPTY_VAR: "" };
	const rows = byId(await config.run(buildContext({ agentDir: root, env })));
	assert.equal(rows.env.status, "warn");
	assert.match(rows.env.detail, /PI_CHECKUP_EMPTY_VAR/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: an inherited property name is not a set variable", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { p: { apiKey: "${constructor}" } } });
	const rows = byId(await config.run(buildContext({ agentDir: root, env: {} })));
	assert.equal(rows.env.status, "warn");
	assert.match(rows.env.detail, /constructor/);
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

test("config: a file over the size cap is uninspected, not corrupt", async () => {
	// A perfectly valid 5 MB settings.json was reported as "is not valid JSON"
	// and offered a restore from backup — two claims the check never established.
	const root = tmpRoot();
	fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ packages: [], pad: "x".repeat(5 * 1024 * 1024) }));
	fs.writeFileSync(path.join(root, "settings.json.bak"), JSON.stringify({ packages: [] }));

	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows["file:settings.json"].status, "warn");
	assert.match(rows["file:settings.json"].detail, /could not be inspected/);
	assert.doesNotMatch(rows["file:settings.json"].detail, /not valid JSON/);
	assert.equal(rows["file:settings.json"].fix, undefined, "an oversized file is not a repair candidate");
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: genuinely broken JSON still fails and offers the restore", async () => {
	const root = tmpRoot();
	fs.writeFileSync(path.join(root, "settings.json"), "{ broken");
	fs.writeFileSync(path.join(root, "settings.json.bak"), JSON.stringify({ packages: [] }));
	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows["file:settings.json"].status, "fail");
	assert.match(rows["file:settings.json"].detail, /not valid JSON/);
	assert.equal(rows["file:settings.json"].fix, "restore-config");
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
	// In-session the repair is withheld, so naming `/checkup fix` here would point
	// the user at a command that answers "Nothing to repair automatically."
	assert.doesNotMatch(live.duplicates.hint, /\/checkup fix/);
	assert.match(live.duplicates.hint, /npx pi-checkup --fix --yes/);
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
	// The probe itself may fail — a refused connection to ::1 is a real answer,
	// and since the refused-connection fix it is reported as one — but the DNS
	// row must not join it: inventing a resolution failure for a host that was
	// never looked up was the bug this test closes.
	assert.ok(!rows.some((r) => r.id === "dns" && r.status === "fail"));
	fs.rmSync(root, { recursive: true, force: true });
});

// --- regressions found in review -----------------------------------------

test("packages: an entry that points at a file is not a missing package", async () => {
	// It exists, so "1 missing from node_modules" was a false failure — and the
	// prune repair it armed answers "nothing to prune", because prune asks
	// isMissing() and a file is not missing.
	const root = tmpRoot();
	fs.mkdirSync(path.join(root, "ext"), { recursive: true });
	fs.writeFileSync(path.join(root, "ext", "single.js"), "");
	writeJson(path.join(root, "settings.json"), { packages: ["./ext/single.js"] });
	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.notEqual(rows.dirs?.status, "fail");
	assert.equal(rows["not-dir"].status, "warn");
	assert.match(rows["not-dir"].detail, /single\.js/);
	assert.equal(rows["not-dir"].fix, undefined, "there is nothing to delete, so no repair may be offered");
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: a manifest that cannot be read is unproven, not broken", async () => {
	// A directory where package.json should be is EISDIR, not a parse failure.
	// Telling the user to reinstall over a filesystem problem is the same mistake
	// the config group already avoids.
	const root = tmpRoot();
	const dir = path.join(root, "npm", "node_modules", "weird");
	fs.mkdirSync(path.join(dir, "package.json"), { recursive: true });
	writeJson(path.join(root, "settings.json"), { packages: ["npm:weird"] });
	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows["manifests-unreadable"].status, "warn");
	assert.equal(rows.manifests.status, "skip");
	assert.doesNotMatch(rows["manifests-unreadable"].detail, /Reinstall/);
	// In words, not in errno: the row that explains a problem should not be the
	// least readable line in the report.
	assert.match(rows["manifests-unreadable"].detail, /it is a directory, not a file/);
	assert.doesNotMatch(rows["manifests-unreadable"].detail, /EISDIR|illegal operation/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: an absolute pi.extensions entry is resolved where it points", async () => {
	// path.join(dir, "/abs/file.js") re-roots the pattern under the package, so a
	// manifest that loads fine at runtime was reported as a missing entry.
	const root = tmpRoot();
	const outside = path.join(root, "outside.js");
	fs.writeFileSync(outside, "");
	installPkg(root, "abs", { pi: { extensions: [outside] } });
	writeJson(path.join(root, "settings.json"), { packages: ["npm:abs"] });
	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(rows.entries.status, "ok", rows.entries.detail);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: userinfo on a cleartext endpoint is neither sent nor hidden", async () => {
	// The apiKey branch withheld the credential over http; a password embedded in
	// the URL went out as a Basic header with no row saying so.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { gw: { baseUrl: "http://user:sekrit@example.invalid/v1" } } });
	const rows = byId(await network.run(buildContext({ agentDir: root, offline: true })));
	assert.equal(rows.cleartext.status, "warn");
	assert.match(rows.cleartext.detail, /gw/);
	assert.doesNotMatch(JSON.stringify(rows), /sekrit/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: offline mode still reports a baseUrl that is not a string", async () => {
	// Whether a config value is even a string is a property of the config, not of
	// the probe, so skipping the network must not skip the finding.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { gw: { baseUrl: 42 } } });
	const rows = byId(await network.run(buildContext({ agentDir: root, offline: true })));
	assert.equal(rows["baseUrl-shape"].status, "warn");
	assert.equal(rows.providers.status, "skip");
	// The skip used to say "no provider with a baseUrl", which the check had just
	// disproved.
	assert.match(rows.providers.detail, /gw/);
	assert.match(rows.providers.detail, /not a string/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("binaries: a missing .bin still reports declared commands with no shim", async () => {
	// The early return claimed "no npm packages installed" without reading
	// settings, and never emitted the missing-shims row — the exact failure the
	// module documents.
	const root = tmpRoot();
	installPkg(root, "pi-thing", { bin: { "pi-thing": "cli.js" } }, ["cli.js"]);
	writeJson(path.join(root, "settings.json"), { packages: ["npm:pi-thing"] });
	const rows = byId(await binaries.run(buildContext({ agentDir: root })));
	assert.equal(rows["bin-dir"].status, "skip");
	assert.match(rows["bin-dir"].detail, /1 declared command/);
	assert.equal(rows["missing-shims"].status, "warn");
	assert.match(rows["missing-shims"].detail, /pi-thing/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("binaries: a .bin of plain files inspects no links and says so", async () => {
	// npm writes shims as regular files on Windows. Counting entries instead of
	// links printed "N entries all resolve" having inspected nothing.
	const root = tmpRoot();
	const binDir = path.join(root, "npm", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(path.join(binDir, "pi-thing"), "#!/bin/sh\n");
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const rows = byId(await binaries.run(buildContext({ agentDir: root })));
	assert.equal(rows.dangling.status, "skip");
	assert.match(rows.dangling.detail, /none of them links/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("runtime: a scheme-less proxy with credentials still has a host and port", async () => {
	// `user:pass@proxy.corp:8080` is a shape curl accepts. The textual fallback
	// rejected the userinfo, so the row warned forever while network.js probed
	// happily through the same value.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const env = { ...process.env, https_proxy: "alice:s3cr3t@127.0.0.1:9" };
	const rows = byId(await runtime.run(buildContext({ agentDir: root, env })));
	assert.doesNotMatch(rows.proxy.detail, /without a usable host and port/);
	assert.doesNotMatch(JSON.stringify(rows), /s3cr3t/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: an empty command registry is a skip, like the tools row", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi: fakePi({ packages: [] }, []) })));
	assert.equal(rows.commands.status, "skip");
	assert.equal(rows.tools.status, "skip");
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: pi.extensions null declares no extension", async () => {
	// It used to count as one, so the package was reported "declared an extension
	// but registered no tool or command" for a manifest that declared none.
	const root = tmpRoot();
	installPkg(root, "nul", { pi: { extensions: null } });
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi: fakePi({ packages: ["npm:nul"] }, []) })));
	assert.equal(rows.silent.status, "skip");
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: an empty registry is not a collision-free pass", async () => {
	// "none" over zero compared objects is the same vacuous green tick the tools
	// and commands rows were changed to skip for.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi: fakePi({ packages: [] }, []) })));
	assert.equal(rows["tool-collisions"].status, "skip");
	assert.equal(rows["command-collisions"].status, "skip");
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: /models is appended to the path, not to a query string", async () => {
	// `…/v1?api-version=2024` used to become `…/v1?api-version=2024/models`, so the
	// probe asked a different question than the config posed.
	const http = await import("node:http");
	const seen = [];
	const server = http.createServer((req, res) => {
		seen.push(req.url);
		res.writeHead(401);
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { az: { baseUrl: `http://127.0.0.1:${port}/v1?api-version=2024` } },
	});
	try {
		await network.run(buildContext({ agentDir: root, env: {} }));
	} finally {
		server.close();
	}
	assert.deepEqual(seen, ["/v1/models?api-version=2024"]);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: a query string on a cleartext endpoint is neither sent nor printed", async () => {
	// `?key=…` gateways are a real shape. A query string cannot be inspected for
	// secrets, so on plain http to another machine it is withheld, and the row
	// says so instead of probing a URL nobody configured.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { gw: { baseUrl: "http://example.com/v1?key=sk-live-query-secret" } },
	});
	const rows = byId(await network.run(buildContext({ agentDir: root, env: {}, offline: true })));
	assert.equal(rows.cleartext.status, "warn");
	assert.match(rows.cleartext.detail, /query string on gw withheld/);
	assert.doesNotMatch(JSON.stringify(rows), /sk-live-query-secret/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: a provider whose value is not an object is named, not dropped", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { str: "http://x/v1", nil: null, arr: ["http://y/v1"] },
	});
	const rows = byId(await network.run(buildContext({ agentDir: root, env: {}, offline: true })));
	assert.equal(rows["baseUrl-shape"].status, "warn");
	assert.match(rows["baseUrl-shape"].detail, /str \(string\) is not a provider object/);
	assert.match(rows["baseUrl-shape"].detail, /nil \(null\) is not a provider object/);
	assert.match(rows["baseUrl-shape"].detail, /arr \(array\) is not a provider object/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: an empty package list is a skip for duplicates, not a pass", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows.duplicates.status, "skip");
	assert.match(rows.duplicates.detail, /no comparable package entries/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("runtime: a proxy password containing @ still yields a host and port", async () => {
	// curl accepts `user:p@ss@host:port`; cutting at the first `@` left the row
	// claiming a working proxy had no usable host and port.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const rows = byId(
		await runtime.run(buildContext({ agentDir: root, env: { all_proxy: "http://alice:p@ss@127.0.0.1:1" }, offline: true })),
	);
	assert.doesNotMatch(rows.proxy.detail, /without a usable host and port/);
	assert.match(rows.proxy.detail, /127\.0\.0\.1:1/);
	assert.doesNotMatch(rows.proxy.detail, /p@ss/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: a token pasted into the packages list is not printed", async () => {
	// `redactSource` scrubs URLs, and this is not one: with no scheme and no path
	// the whole string is the secret, so the report describes it instead.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["sk-ant-api03-AbC123", null, 42] });
	const rows = byId(await packages.run(buildContext({ agentDir: root })));
	assert.doesNotMatch(JSON.stringify(rows), /sk-ant-api03-AbC123/);
	assert.match(rows["entries-shape"].detail, /null, number 42/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: a list with nothing comparable in it is a skip, not a pass", async () => {
	// The row keyed on the list length, so `[null, 42]` printed "none" over zero
	// compared entries while packages.js warned about the same list.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [null, 42] });
	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows.duplicates.status, "skip");
	assert.match(rows.duplicates.detail, /no comparable package entries/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("runner: an empty row from a module is named, not dropped", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const good = { group: "X", id: "x", title: "x", status: "ok", detail: "fine" };
	const rows = await runChecks(buildContext({ agentDir: root }), [{ name: "Half", run: async () => [good, undefined, null] }]);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].id, "x");
	assert.equal(rows[1].status, "fail");
	assert.match(rows[1].detail, /2 empty row\(s\)/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("runner: a module that returns a non-array becomes one crash row", async () => {
	// The value used to reach the renderer and throw out of the whole report, so a
	// single bad module produced "crashed" and no findings at all.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const rows = await runChecks(buildContext({ agentDir: root }), [{ name: "Bad", run: async () => "nope" }]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, "fail");
	assert.match(rows[0].detail, /returned string instead of a list of rows/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: a parse error never quotes the file it failed on", async () => {
	// V8 puts a window of the input in some of its messages, and models.json is
	// where the keys live: `Unexpected token 's', ..."\"apiKey\": sk-live-9f8e}"`.
	// The position is enough to find the mistake.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	fs.writeFileSync(path.join(root, "models.json"), '{"providers":{"p":{"apiKey": sk-live-9f8e}}}');
	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.doesNotMatch(JSON.stringify(rows), /sk-live-9f8e/);
	// V8 only gives a position for the messages that carry no snippet, so both
	// forms are acceptable; quoting the file is not.
	assert.match(rows.env.detail, /^models\.json: not valid JSON/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("context: a session whose settings could not be read offers no file repair", async () => {
	// getSettings() throwing used to fall back to the file and mark it "file",
	// which re-armed prune and dedupe against a file the running Pi may disagree
	// with — the one case the guards exist for.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: ["npm:gone"] });
	const pi = {
		getSettings: () => {
			throw new Error("nope");
		},
	};
	const ctx = buildContext({ agentDir: root, pi });
	const rows = byId(await packages.run(ctx));
	assert.equal(rows.dirs.status, "fail");
	assert.equal(rows.dirs.fix, undefined, "a guessed settings file must not be rewritten");
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: an unreadable settings.json warns in both groups", async () => {
	// One state, one status: `packages.js` already calls a settings.json it could
	// not parse a warning, so a `skip` here read as "nothing to report" two groups
	// away from a warning about the same file.
	const root = tmpRoot();
	fs.writeFileSync(path.join(root, "settings.json"), "{ not json");
	const ctx = buildContext({ agentDir: root });
	const cfg = byId(await config.run(ctx));
	const pkg = byId(await packages.run(ctx));
	assert.equal(cfg.duplicates.status, "warn", cfg.duplicates.detail);
	assert.match(cfg.duplicates.detail, /could not be inspected/);
	assert.equal(pkg.installed.status, "warn", pkg.installed.detail);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: a packages value that is not a list is a warning, like packages.js says", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: { a: "npm:x" } });
	const rows = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(rows.duplicates.status, "warn");
	assert.match(rows.duplicates.detail, /not a list/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: a registry of nameless entries is not a collision-free pass", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const pi = fakePi({ packages: [] }, [{ sourceInfo: { path: "/x/i.js" } }, {}]);
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi })));
	assert.equal(rows["tool-collisions"].status, "skip");
	assert.match(rows["tool-collisions"].detail, /no registered entry carries a name to compare/);
	// The tools row above counted the same two entries, so "nothing registered"
	// here would contradict it.
	assert.match(rows.tools.detail, /2 registered/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: offline mode still names a baseUrl that is not a URL", async () => {
	// Parsing a baseUrl needs no network, so --offline has no reason to stay
	// quiet about `localhost:11434/v1` — the routine hand-paste that Pi then
	// reports as a failed request with no hint about why.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: { ollama: { baseUrl: "localhost:11434/v1" } } });
	const rows = byId(await network.run(buildContext({ agentDir: root, env: {}, offline: true })));
	assert.equal(rows.providers.status, "skip");
	assert.match(rows.providers.detail, /ollama: baseUrl is not a URL/);
	assert.equal(rows["baseUrl-shape"].status, "warn");
	assert.match(rows["baseUrl-shape"].detail, /ollama: baseUrl is not a URL/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: a rejected header value is not quoted back", async () => {
	// undici's message embeds the value it rejected — and here that value is the
	// apiKey. scrubCredentials now masks bare tokens too, but the row must still
	// not echo the message: the value is only known to be a key in this branch.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { gw: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-live-bad\nvalue" } },
	});
	const rows = byId(await network.run(buildContext({ agentDir: root, env: {} })));
	// A warning, not a skip: the config is broken, and nothing was sent — the row
	// has to say both, or a bad apiKey reads as "the server is down".
	assert.equal(rows.providers.status, "warn");
	assert.match(rows.providers.detail, /1 of 1 unhealthy: gw/);
	assert.doesNotMatch(rows.providers.hint, /sk-live-bad/);
	assert.match(rows.providers.hint, /gw: not probed: a configured header value cannot be sent/);
	assert.match(rows.providers.hint, /models\.json/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: a header value outside Latin-1 is refused, not blamed on the endpoint", async () => {
	// undici answers this one with "fetch failed" and a ByteString TypeError on
	// `cause`, so the classifier never saw a header problem and the endpoint was
	// reported unreachable. It also has to be refused before curl runs: curl
	// sends the UTF-8 bytes, and a 401 for a mutated key says nothing.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { gw: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-live-k€y" } },
	});
	const rows = byId(await network.run(buildContext({ agentDir: root, env: {} })));
	assert.equal(rows.providers.status, "warn");
	assert.doesNotMatch(JSON.stringify(rows), /sk-live|k€y/);
	assert.doesNotMatch(rows.providers.hint, /unreachable/);
	assert.match(rows.providers.hint, /cannot be sent as an HTTP header/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: a refused connection is a failure, not a warning", async () => {
	// Port 1 on loopback is reserved and refuses immediately. The endpoint was
	// asked and answered "no" — a warning there exited 0, so CI and
	// `npx pi-checkup && start-pi` sailed past the one row that said unhealthy.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { down: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" } },
	});
	const rows = byId(await network.run(buildContext({ agentDir: root, env: {} })));
	assert.equal(rows.providers.status, "fail");
	assert.match(rows.providers.detail, /1 of 1 unhealthy: down/);
	fs.rmSync(root, { recursive: true, force: true });
});

// --- regressions found in review -----------------------------------------

test("registry: an error that quotes a token is scrubbed before it is printed", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const pi = {
		getSettings: () => ({ packages: [] }),
		getAllTools: () => {
			throw new Error("cannot load git:https://ghp_sekrit@github.com/me/x");
		},
		getCommands: () => [],
		getMcpServers: () => [],
	};
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi })));
	assert.equal(rows.tools.status, "warn");
	assert.doesNotMatch(JSON.stringify(rows), /ghp_sekrit/);
	assert.match(rows.tools.detail, /could not read the tool registry/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: a numeric sourceInfo.path does not take the group down", async () => {
	// `(path ?? "").startsWith` threw on a number, and one bad registry entry
	// replaced every Registry row with a single crash line.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const pi = {
		getSettings: () => ({ packages: [] }),
		getAllTools: () => [
			{ name: "bad", sourceInfo: { path: 42 } },
			{ name: "good", sourceInfo: { path: path.join(root, "npm", "node_modules", "pi-lens", "dist", "index.js") } },
		],
		getCommands: () => [],
		getMcpServers: () => [],
	};
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi })));
	assert.equal(rows.tools.status, "ok");
	assert.match(rows.attribution.detail, /pi-lens \(1\)/);
	assert.match(rows.attribution.detail, /unknown \(1\)/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: a nameless entry is not counted as an owner's tool", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const pkgPath = path.join(root, "npm", "node_modules", "pi-lens", "dist", "index.js");
	const pi = {
		getSettings: () => ({ packages: [] }),
		getAllTools: () => [{ sourceInfo: { path: pkgPath } }, { name: "named", sourceInfo: { path: pkgPath } }],
		getCommands: () => [],
		getMcpServers: () => [],
	};
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi })));
	// "(2)" would promise two names and print one.
	assert.match(rows.attribution.detail, /pi-lens \(1\)/);
	assert.match(rows.attribution.detail, /1 tool\(s\)/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: an error is scrubbed before it is shortened", async () => {
	// Slicing first can cut `//user:pass@` in half, and then there is no userinfo
	// left for scrubCredentials to recognise.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const pi = {
		getSettings: () => ({ packages: [] }),
		getAllTools: () => {
			throw new Error(`${"x".repeat(130)} https://alice:sekrit@host/v1`);
		},
		getCommands: () => [],
		getMcpServers: () => [],
	};
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi })));
	assert.equal(rows.tools.status, "warn");
	assert.doesNotMatch(JSON.stringify(rows), /alice:sekrit/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: the attribution row counts the owners it did not name", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const tools = [];
	for (const name of ["a", "b", "c", "d", "e", "f"]) {
		tools.push({ name, sourceInfo: { path: path.join(root, "npm", "node_modules", `pkg-${name}`, "index.js") } });
	}
	const pi = { getSettings: () => ({ packages: [] }), getAllTools: () => tools, getCommands: () => [], getMcpServers: () => [] };
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi })));
	assert.match(rows.attribution.detail, /\.\.\. 2 more/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("packages: an empty list from the session is not blamed on a missing file", async () => {
	const root = tmpRoot();
	const pi = { getSettings: () => ({ packages: [] }), getAllTools: () => [], getCommands: () => [], getMcpServers: () => [] };
	const rows = byId(await packages.run(buildContext({ agentDir: root, pi })));
	assert.equal(rows.installed.status, "skip");
	assert.match(rows.installed.detail, /no packages in the running session/);
	assert.doesNotMatch(rows.installed.detail, /not found/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("registry: a silent package is named, not redacted to a placeholder", async () => {
	// The label used to be built after stripping `npm:`, so redactSource saw a
	// bare word and returned "(unparsable value)" — the one row this command
	// exists for never said which package was quiet.
	const root = tmpRoot();
	installPkg(root, "quiet", { pi: { extensions: ["./index.js"] } }, ["index.js"]);
	writeJson(path.join(root, "settings.json"), { packages: ["npm:quiet"] });
	const rows = byId(await registry.run(buildContext({ agentDir: root, pi: fakePi({ packages: ["npm:quiet"] }, []) })));
	assert.equal(rows.silent.status, "warn");
	assert.match(rows.silent.detail, /^quiet declared an extension/);
	assert.doesNotMatch(rows.silent.detail, /unparsable/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: a settings.json that is valid JSON but not an object is named as that", async () => {
	// `null` parses. Reporting it as "could not be inspected" contradicted the
	// "valid JSON" row directly above it.
	const root = tmpRoot();
	fs.writeFileSync(path.join(root, "settings.json"), "null");
	const cfg = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(cfg["file:settings.json"].status, "ok");
	assert.equal(cfg.duplicates.status, "warn");
	assert.match(cfg.duplicates.detail, /valid JSON but not an object/);
	const pkg = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(pkg.installed.status, "warn");
	assert.match(pkg.installed.detail, /valid JSON but not an object/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("config: a settings.json that cannot be opened is not reported as missing", async () => {
	// A directory in the file's place is the portable way to make readFileSync
	// fail without depending on the test user's permissions (root ignores them).
	const root = tmpRoot();
	fs.mkdirSync(path.join(root, "settings.json"));
	const cfg = byId(await config.run(buildContext({ agentDir: root })));
	assert.equal(cfg["file:settings.json"].status, "warn");
	assert.doesNotMatch(cfg["file:settings.json"].detail, /not found/);
	assert.match(cfg["file:settings.json"].detail, /could not be inspected/);
	const pkg = byId(await packages.run(buildContext({ agentDir: root })));
	assert.equal(pkg.installed.status, "warn");
	assert.doesNotMatch(pkg.installed.detail, /not found/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: a cleartext endpoint with a query string is not contacted at all", async (t) => {
	// Offline mode proves the row, not the wire. This one proves nothing was sent,
	// and the endpoint has to be reachable-but-non-loopback for the claim to mean
	// anything: the server listens on this machine's own LAN address, so a probe
	// that was sent would arrive.
	const lan = Object.values(os.networkInterfaces())
		.flat()
		.find((iface) => iface && iface.family === "IPv4" && !iface.internal);
	// Reported as a skip rather than a quiet return: a test that passes with zero
	// assertions is indistinguishable from one that proved something.
	if (!lan) return t.skip("no non-loopback IPv4 address to act as the other machine");
	const http = await import("node:http");
	let hits = 0;
	const server = http.createServer((_req, res) => {
		hits += 1;
		res.writeHead(200);
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
	const { port } = server.address();
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), {
		providers: { gw: { baseUrl: `http://${lan.address}:${port}/v1?key=sk-live-query` } },
	});
	try {
		const rows = byId(await network.run(buildContext({ agentDir: root, env: {} })));
		assert.equal(rows.providers.status, "skip");
		assert.match(rows.providers.detail, /not probed/);
		assert.equal(hits, 0, "the withheld query string must not reach the endpoint");
	} finally {
		server.close();
	}
	fs.rmSync(root, { recursive: true, force: true });
});

test("runtime: a proxy password containing @ is parsed without the offline shortcut", async () => {
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const rows = byId(
		await runtime.run(buildContext({ agentDir: root, env: { all_proxy: "alice:p@ss@127.0.0.1:1", https_proxy: "" } })),
	);
	assert.doesNotMatch(rows.proxy.detail, /without a usable host and port/);
	assert.match(rows.proxy.detail, /127\.0\.0\.1:1/);
	assert.equal(rows.proxy.status, "fail", rows.proxy.detail);
	fs.rmSync(root, { recursive: true, force: true });
});

test("runtime: a proxy that answers 407 did not forward the request", { skip: hasCurl() ? false : "curl is not installed" }, async () => {
	// 407 is the proxy demanding its own credentials: the target was never
	// contacted, so "forwarded a request" would be a claim this check cannot make.
	const http = await import("node:http");
	const server = http.createServer((_req, res) => {
		res.writeHead(407);
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const env = {
		all_proxy: "",
		https_proxy: `http://127.0.0.1:${port}`,
		PI_CHECKUP_PROBE_URL: "http://example.invalid/v1/models",
	};
	try {
		const rows = byId(await runtime.run(buildContext({ agentDir: root, env })));
		assert.equal(rows.proxy.status, "warn", rows.proxy.detail);
		assert.match(rows.proxy.detail, /not forwarded/);
	} finally {
		server.close();
	}
	fs.rmSync(root, { recursive: true, force: true });
});

test("network: an HTTP error status is a failure, not just a refused socket", async () => {
	// 503 is an answer from the endpoint itself. Folding it into the warning
	// branch exited 0 for a provider that said "no" in plain HTTP — the same
	// false confidence a refused connection was fixed to remove.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	const http = await import("node:http");
	const server = http.createServer((_req, res) => {
		res.writeHead(503);
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		writeJson(path.join(root, "models.json"), {
			providers: { p: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "k" } },
		});
		const rows = byId(await network.run(buildContext({ agentDir: root, env: {} })));
		assert.equal(rows.providers.status, "fail");
	} finally {
		server.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("network: a non-object providers value is named, not silently dropped", async () => {
	// `"providers": 5` used to fall through to "no provider with a baseUrl" — a
	// claim about a config whose providers key is a number.
	const root = tmpRoot();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: 5 });
	const rows = byId(await network.run(buildContext({ agentDir: root, env: {} })));
	const detail = JSON.stringify(rows);
	assert.match(detail, /not a provider object/);
	assert.doesNotMatch(detail, /no provider with a baseUrl/);
	fs.rmSync(root, { recursive: true, force: true });
});

test("binaries: a .bin directory off PATH is skipped, not warned", async () => {
	// Pi never adds .bin to PATH and calls package commands by full path, so the
	// old permanent warning put an amber row on every healthy install and taught
	// the reader to skip the group that is supposed to mean something.
	const root = tmpRoot();
	const binDir = path.join(root, "npm", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const shim = path.join(binDir, "checkup-tool");
	fs.writeFileSync(shim, "#!/bin/sh\n");
	fs.chmodSync(shim, 0o755);
	installPkg(root, "owner", { bin: { "checkup-tool": "./cli.js" }, pi: { extensions: ["./i.js"] } });
	writeJson(path.join(root, "settings.json"), { packages: ["npm:owner"] });
	try {
		const env = { ...process.env, PATH: path.join(root, "not-on-path") };
		const rows = byId(await binaries.run(buildContext({ agentDir: root, env })));
		assert.equal(rows.unreachable.status, "skip", rows.unreachable.detail);
		assert.match(rows.unreachable.detail, /which is not on PATH/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("config: the stale-backup hint names what is actually stale", async () => {
	// "because both backups are older" was hardcoded. It was wrong as soon as one
	// file was stale and the other was not, and a file may have any number of
	// backups — so the count is no longer claimed at all.
	const root = tmpRoot();
	const old = new Date(Date.now() - 86400000);
	const fresh = new Date();
	writeJson(path.join(root, "settings.json"), { packages: [] });
	writeJson(path.join(root, "models.json"), { providers: {} });
	// settings.json was edited after its backup; models.json was not.
	fs.utimesSync(path.join(root, "settings.json"), fresh, fresh);
	fs.writeFileSync(path.join(root, "settings.json.bak"), "{}");
	fs.utimesSync(path.join(root, "settings.json.bak"), old, old);
	fs.utimesSync(path.join(root, "models.json"), old, old);
	fs.writeFileSync(path.join(root, "models.json.bak"), "{}");
	fs.utimesSync(path.join(root, "models.json.bak"), fresh, fresh);
	try {
		const rows = byId(await config.run(buildContext({ agentDir: root })));
		assert.equal(rows.backups.status, "ok");
		assert.doesNotMatch(rows.backups.hint, /both backups/);
		assert.match(rows.backups.hint, /newest backup of settings\.json predates the current file, /);
		assert.doesNotMatch(rows.backups.hint, /models\.json predates/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("packages: a manifest that parses to a non-object is a failure, not 'readable'", async () => {
	// `null`, `"nope"` and `[]` are valid JSON, so the row counted them as
	// readable and put a green tick on a package that cannot load — next to an
	// `entry files` row that skipped because the manifest declared nothing.
	for (const body of ["null", '"nope"', "[]", "5"]) {
		const root = tmpRoot();
		const dir = path.join(root, "npm", "node_modules", "p");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), body);
		writeJson(path.join(root, "settings.json"), { packages: ["npm:p"] });
		try {
			const rows = byId(await packages.run(buildContext({ agentDir: root })));
			assert.equal(rows.manifests.status, "fail", `body ${body}: ${rows.manifests.detail}`);
			assert.match(rows.manifests.detail, /not a JSON object/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
	// An empty object is still a valid (if useless) manifest.
	const root = tmpRoot();
	const dir = path.join(root, "npm", "node_modules", "p");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), "{}");
	writeJson(path.join(root, "settings.json"), { packages: ["npm:p"] });
	try {
		const rows = byId(await packages.run(buildContext({ agentDir: root })));
		assert.equal(rows.manifests.status, "ok");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
