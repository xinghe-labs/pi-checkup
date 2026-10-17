// Unit tests for the pure helpers and the renderer. The check modules have their
// own file: test/checks.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bareHost, globExists, humanBytes, isLoopbackHost, newestBackup, ownerOf, resolvePackageDir, sourceOf } from "../src/util.js";
import { renderReport, renderVerdict, summarize, toJson } from "../src/render.js";
import checkupExtension from "../src/index.js";

test("ownerOf attributes package paths", () => {
	assert.equal(ownerOf("/home/u/.pi/agent/npm/node_modules/pi-lens/dist/index.js"), "pi-lens");
	assert.equal(ownerOf("/home/u/.pi/agent/npm/node_modules/@scope/pkg/dist/index.js"), "@scope/pkg");
	assert.equal(ownerOf("C:\\Users\\u\\.pi\\agent\\npm\\node_modules\\pi-lens\\dist\\index.js"), "pi-lens");
	assert.equal(ownerOf("builtin:read"), "builtin");
	assert.equal(ownerOf("/home/u/.pi/agent/extensions/doctor.js"), "local:doctor.js");
	assert.equal(ownerOf(undefined), "unknown");
});

test("resolvePackageDir maps npm specs into node_modules", () => {
	const root = path.join("/tmp", "agent");
	assert.equal(resolvePackageDir("npm:pi-lens", root), path.join(root, "npm", "node_modules", "pi-lens"));
	assert.equal(resolvePackageDir("npm:@scope/pkg", root), path.join(root, "npm", "node_modules", "@scope/pkg"));
	assert.equal(resolvePackageDir("./local-ext", root), path.resolve(root, "./local-ext"));
	// Sources Pi resolves itself are deliberately not guessed at.
	assert.equal(resolvePackageDir("git:https://example.com/x.git", root), null);
	assert.equal(resolvePackageDir(undefined, root), null);
});

test("globExists handles literal and starred segments", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkup-glob-"));
	fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
	fs.writeFileSync(path.join(dir, "extensions", "main.js"), "");
	assert.equal(globExists(dir, "extensions/main.js"), true);
	assert.equal(globExists(dir, "extensions/*.js"), true);
	assert.equal(globExists(dir, "extensions/*.ts"), false);
	assert.equal(globExists(dir, "missing/main.js"), false);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("newestBackup picks the latest sibling backup", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkup-bak-"));
	const target = path.join(dir, "settings.json");
	fs.writeFileSync(target, "{}");
	assert.equal(newestBackup(target), null);

	const older = `${target}.checkup-bak-2026-01-02T03-04-05`;
	const newer = `${target}.bak`;
	fs.writeFileSync(older, "{}");
	fs.writeFileSync(newer, "{}");
	// Ordering is by mtime, not by name: a repair backup carries a timestamp that
	// always sorts after a plain .bak, so a name sort would pin the choice to the
	// repair backup forever and never surface the newer one. Setting the mtimes
	// explicitly is the only way to prove which rule is actually in force.
	const later = new Date(Date.now() + 60_000);
	fs.utimesSync(newer, later, later);
	const earlier = new Date(Date.now() - 60_000);
	fs.utimesSync(older, earlier, earlier);
	assert.equal(newestBackup(target), newer);

	// A file that merely shares the prefix must not be mistaken for a backup.
	fs.writeFileSync(`${target}.broken`, "{}");
	assert.equal(newestBackup(target), newer);

	fs.rmSync(dir, { recursive: true, force: true });
});

test("humanBytes rounds to one decimal above a kilobyte", () => {
	assert.equal(humanBytes(512), "512 B");
	assert.equal(humanBytes(1536), "1.5 KB");
	assert.equal(humanBytes(1024 ** 3), "1.0 GB");
});

test("summarize counts every status", () => {
	const s = summarize([
		{ status: "ok" },
		{ status: "ok" },
		{ status: "warn" },
		{ status: "fail" },
		{ status: "skip" },
	]);
	assert.deepEqual(s, { total: 5, ok: 2, warn: 1, fail: 1, skip: 1 });
});

test("renderReport orders groups and marks each line", () => {
	const report = renderReport([
		{ group: "Runtime", title: "node", status: "ok", detail: "v22" },
		{ group: "Registry", title: "tools", status: "fail", detail: "collision", hint: "rename one" },
	]);
	const lines = report.split("\n");
	assert.equal(lines[0], "Registry");
	assert.match(lines[1], /✗ tools\s+collision/);
	assert.ok(lines.indexOf("Runtime") > lines.indexOf("Registry"));
	assert.ok(report.includes("1 failed"));
	// Hints stay out of the default view but appear in verbose mode.
	assert.ok(!report.includes("rename one"));
	assert.ok(renderReport([{ group: "Registry", title: "tools", status: "fail", detail: "x", hint: "rename one" }], { verbose: true }).includes("rename one"));
});

test("toJson drops internal fix metadata", () => {
	const payload = toJson([{ group: "Config", title: "x", status: "fail", detail: "d", fix: "restore-config", fixTarget: "/a" }]);
	assert.deepEqual(payload.checks[0], { group: "Config", title: "x", status: "fail", detail: "d" });
	assert.equal(payload.summary.fail, 1);
});

test("renderVerdict prefers the worst status", () => {
	// "all clear" over a report where part of it was never checked is the exact
	// false confidence this package exists to remove, so the skip count shows.
	assert.equal(renderVerdict([{ status: "ok" }, { status: "skip" }]), "✓ 1 ok, 1 skipped");
	assert.equal(renderVerdict([{ status: "ok" }, { status: "ok" }]), "✓ all clear");
	assert.equal(renderVerdict([{ status: "skip" }, { status: "skip" }]), "· nothing verified (2 skipped)");
	assert.equal(renderVerdict([{ status: "ok" }, { status: "warn" }]), "! 1 warning");
	assert.equal(renderVerdict([{ status: "warn" }, { status: "warn" }]), "! 2 warnings");
	assert.equal(renderVerdict([{ status: "warn" }, { status: "fail" }]), "✗ 1 failed");
});

test("renderReport takes its footer hint from the caller", () => {
	const results = [{ group: "Config", title: "x", status: "warn", detail: "d", hint: "h" }];
	assert.ok(renderReport(results).includes("/checkup verbose"));
	assert.ok(renderReport(results, { hintCommand: "pi-checkup --verbose" }).includes("pi-checkup --verbose"));
});

test("the registry check reports skipped when no session is running", async () => {
	const registry = await import("../src/checks/registry.js");
	const results = await registry.run({ pi: null, hasRuntime: false, settings: null });
	assert.equal(results.length, 1);
	assert.equal(results[0].status, "skip");
	assert.match(results[0].detail, /no Pi session/);
});

test("the extension exports a factory that registers a command", () => {
	assert.equal(typeof checkupExtension, "function");
	const registered = [];
	const fakePi = { registerCommand: (name, spec) => registered.push({ name, spec }) };
	checkupExtension(fakePi);
	assert.equal(registered.length, 1);
	assert.equal(registered[0].name, "checkup");
	assert.equal(typeof registered[0].spec.handler, "function");
});

test("summarize counts an unknown status as a failure", () => {
	// A malformed row used to land in `total` and in no bucket, so a report that
	// contained only unknown statuses summarized as "all clear".
	const s = summarize([{ status: "ok" }, { status: "weird" }]);
	assert.equal(s.total, 2);
	assert.equal(s.fail, 1);
	assert.equal(s.ok, 1);
});

test("a title longer than the title column keeps the detail aligned", () => {
	const long = "a-very-long-check-name-that-cannot-fit";
	const rows = [
		{ group: "Config", id: "a", title: long, status: "ok", detail: "one two three four five six seven eight nine ten" },
		{ group: "Config", id: "b", title: "short", status: "ok", detail: "x" },
	];
	const wide = renderReport(rows, { width: 80 }).split("\n");
	// At a normal width the title is never touched: it is the identifier the user
	// needs to look the check up by.
	assert.ok(wide.some((l) => l.includes(long)), wide.join("\n"));

	const narrow = renderReport(rows, { width: 40 }).split("\n");
	// Narrower than the title: the name may wrap, but nothing may overflow, and the
	// detail must still start at the column every other wrapped line uses.
	for (const line of narrow) assert.ok(line.length <= 40, `over 40: ${line}`);
	const joined = narrow.join("").replace(/\s+/g, "");
	assert.ok(joined.includes(long.replace(/\s+/g, "")), "the title was truncated rather than wrapped");
	assert.ok(narrow.some((l) => l.trimStart().startsWith("one two three")), narrow.join("\n"));
	assert.match(renderReport(rows, { width: 80 }), /\n {2}✓ short +x/);
});

test("isLoopbackHost recognises IPv6 literals with and without brackets", () => {
	assert.equal(isLoopbackHost("::1"), true);
	assert.equal(isLoopbackHost("[::1]"), true);
	assert.equal(isLoopbackHost("0:0:0:0:0:0:0:1"), true);
	assert.equal(isLoopbackHost("127.0.0.1"), true);
	assert.equal(isLoopbackHost("127.1.2.3"), true);
	assert.equal(isLoopbackHost("localhost"), true);
	assert.equal(isLoopbackHost("api.localhost"), true);
	assert.equal(isLoopbackHost("api.example.com"), false);
	assert.equal(isLoopbackHost("fe80::1"), false);
	assert.equal(isLoopbackHost(undefined), false);
	assert.equal(bareHost("[::1]"), "::1");
	assert.equal(bareHost("::1"), "::1");
});

test("sourceOf reads both settings entry shapes and ignores junk", () => {
	assert.equal(sourceOf("npm:pi-lens"), "npm:pi-lens");
	assert.equal(sourceOf({ source: "npm:pi-lens" }), "npm:pi-lens");
	// null is the documented "this entry carries no source" answer, so callers
	// can treat it as a plain falsy value without distinguishing undefined.
	assert.equal(sourceOf({}), null);
	assert.equal(sourceOf(null), null);
	assert.equal(sourceOf(42), null);
	assert.equal(sourceOf({ source: 42 }), null);
});

test("no rendered line exceeds the requested width", () => {
	// The report is read in a terminal split down the middle as often as not, and
	// a line that wraps on its own breaks the column alignment that makes it
	// scannable.
	const rows = [
		{ group: "Registry", id: "a", title: "attribution", status: "ok", detail: "x".repeat(200) },
		{ group: "Binaries", id: "b", title: "a-title-that-is-much-longer-than-the-column", status: "warn", detail: "short", hint: "y".repeat(200) },
		{ group: "Config", id: "c", title: "env", status: "fail", detail: "z".repeat(50), hint: "h".repeat(300) },
	];
	for (const width of [40, 60, 80, 120]) {
		const report = renderReport(rows, { verbose: true, width });
		for (const line of report.split("\n")) {
			assert.ok(line.length <= width, `width ${width}: ${line.length} cols: ${line}`);
		}
	}
});
