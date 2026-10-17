// Unit tests for the pure helpers and the renderer. The check modules have their
// own file: test/checks.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	bareHost,
	describeFsError,
	globExists,
	humanBytes,
	isLoopbackHost,
	newestBackup,
	ownerOf,
	readJson,
	redactSource,
	pinnedVersion,
	curlArgs,
	curlConfig,
	curlProbe,
	redactUrl,
	resolvePackageDir,
	sameCommand,
	scrubCredentials,
	sourceOf,
	truncateList,
	whichAll,
} from "../src/util.js";
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

test("sameCommand folds the Windows shim extension but not the directory", () => {
	// PATH resolution answers `foo.CMD` for a link named `foo`; comparing the raw
	// strings called every correctly linked package command shadowed on Windows.
	assert.equal(sameCommand("C:\\pi\\npm\\node_modules\\.bin\\foo.CMD", "C:\\pi\\npm\\node_modules\\.bin\\foo"), true);
	assert.equal(sameCommand("C:\\pi\\npm\\node_modules\\.bin\\foo.ps1", "C:\\pi\\npm\\node_modules\\.bin\\foo"), true);
	// A different program with the same name really is shadowing.
	assert.equal(sameCommand("C:\\Windows\\foo.cmd", "C:\\pi\\npm\\node_modules\\.bin\\foo"), false);
	// On POSIX there is no shim extension to fold.
	assert.equal(sameCommand("/usr/local/bin/foo", "/opt/pi/node_modules/.bin/foo"), false);
	assert.equal(sameCommand("/opt/pi/node_modules/.bin/foo", "/opt/pi/node_modules/.bin/foo"), true);
});

test("whichAll honours PATHEXT when told it is Windows", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkup-which-"));
	fs.writeFileSync(path.join(dir, "tool.CMD"), "");
	try {
		const env = { PATH: dir, PATHEXT: ".CMD" };
		// The platform branch is injectable so it can be exercised from Linux,
		// where PATHEXT never applies.
		assert.deepEqual(whichAll("tool", env, { windows: true }), [path.join(dir, "tool.CMD")]);
		// Without the Windows branch the extension is not appended at all.
		assert.deepEqual(whichAll("tool", env, { windows: false }), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("redactUrl keeps the address and drops every credential", () => {
	assert.equal(redactUrl("https://user:pass@gateway.corp/v1"), "https://gateway.corp/v1");
	assert.equal(redactUrl("https://api.example.com/v1?key=sk-live-abc"), "https://api.example.com/v1");
	assert.equal(redactUrl("http://[::1]:11434/v1"), "http://[::1]:11434/v1");
	// Not a URL at all, which is what a hand-pasted baseUrl looks like.
	assert.doesNotMatch(redactUrl("api.example.com/v1?key=sk-live-abc"), /sk-live/);
	assert.equal(redactUrl(""), "(empty)");
	// A key pasted where the URL belongs has no dots, slashes or colons, so the
	// whole string is the secret: nothing of it can be reprinted.
	assert.equal(redactUrl("sk-ant-api03-AbC123"), "(unparsable value)");
	// A host-shaped paste stays readable, because that is what makes it fixable.
	assert.equal(redactUrl("localhost:11434/v1"), "localhost:11434/v1");
	assert.equal(redactUrl("api.example.com/v1?key=sk-live-abc"), "api.example.com/v1");
});

test("curlProbe reports a setup failure instead of a dead endpoint", async () => {
	// An unwritable temp dir makes the config file impossible to create. The
	// request never leaves the machine, so nothing about the endpoint was learned.
	const before = process.env.TMPDIR;
	process.env.TMPDIR = path.join(os.tmpdir(), "checkup-no-such-dir", "nested");
	try {
		const res = await curlProbe("http://127.0.0.1:9/v1/models");
		assert.equal(res.setupFailed, true);
		assert.equal(res.missing, false);
	} finally {
		if (before === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = before;
	}
});

test("scrubCredentials removes a userinfo and a query string from an error message", () => {
	// This is the exact wording Node's fetch uses, and it quotes the URL.
	const message = "Request cannot be constructed from a URL that includes credentials: https://u:p@host/v1/models";
	assert.doesNotMatch(scrubCredentials(message), /u:p@/);
	assert.match(scrubCredentials(message), /https:\/\/\*\*\*@host\/v1\/models/);
	assert.doesNotMatch(scrubCredentials("failed for https://host/v1?token=abc"), /token=abc/);
});

test("redactUrl does not reprint a pasted token that looks host-shaped", () => {
	// A JWT is base64url labels joined by dots — the same characters a hostname
	// uses. Only the shape (no DNS label is 25 characters long) tells them apart,
	// and this function exists precisely so the terminal and --json never echo it.
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
	assert.equal(redactUrl(jwt), "(unparsable value)");
	// Host shapes keep working, including the ones with no scheme.
	assert.equal(redactUrl("api.example.com/v1?key=abc"), "api.example.com/v1");
	assert.equal(redactUrl("localhost:11434/v1"), "localhost:11434/v1");
	assert.equal(redactUrl("[::1]:10808"), "[::1]:10808");
	assert.equal(redactUrl("192.168.1.5:8080"), "192.168.1.5:8080");
});

test("whichAll reads the Windows Path spelling too", () => {
	// A spread copy of process.env on Windows can carry `Path`, and reading only
	// PATH then found nothing and called every installed binary missing.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkup-path-"));
	try {
		fs.writeFileSync(path.join(dir, "tool.exe"), "");
		// `.exe`, not `.EXE`: this test also runs on a case-sensitive filesystem.
		const hits = whichAll("tool", { Path: dir, PATHEXT: ".exe" }, { windows: true });
		assert.equal(hits.length, 1);
		assert.equal(hits[0], path.join(dir, "tool.exe"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("globExists honours an absolute pattern instead of re-rooting it", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkup-glob-"));
	const pkg = path.join(dir, "pkg");
	fs.mkdirSync(pkg, { recursive: true });
	const outside = path.join(dir, "outside.js");
	fs.writeFileSync(outside, "");
	try {
		// path.join(pkg, "/abs/file.js") would look under pkg and report a file that
		// loads fine as missing.
		assert.equal(globExists(pkg, outside), true);
		assert.equal(globExists(pkg, path.join(dir, "nope.js")), false);
		assert.equal(globExists(pkg, "../outside.js"), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("pinnedVersion reports only an exact pin", () => {
	assert.equal(pinnedVersion("npm:pi-lens@1.2.3"), "1.2.3");
	assert.equal(pinnedVersion("npm:@scope/pkg@2.0.0-rc.1"), "2.0.0-rc.1");
	// A range or a tag is satisfied by whatever is newest; comparing it to the
	// installed version would warn forever.
	assert.equal(pinnedVersion("npm:pi-lens@^1.2.3"), null);
	assert.equal(pinnedVersion("npm:pi-lens@latest"), null);
	assert.equal(pinnedVersion("npm:pi-lens"), null);
	assert.equal(pinnedVersion("git+https://example.com/x.git"), null);
});

test("resolvePackageDir drops a version pin but keeps the scope", () => {
	const root = path.join(path.sep, "agent");
	assert.equal(resolvePackageDir("npm:pi-lens@1.2.3", root), path.join(root, "npm", "node_modules", "pi-lens"));
	assert.equal(resolvePackageDir("npm:@scope/pkg@^2", root), path.join(root, "npm", "node_modules", "@scope", "pkg"));
	assert.equal(resolvePackageDir("npm:@scope/pkg", root), path.join(root, "npm", "node_modules", "@scope", "pkg"));
	assert.equal(resolvePackageDir("npm:pkg@latest", root), path.join(root, "npm", "node_modules", "pkg"));
});

test("redactSource keeps a glob and a scoped path", () => {
	// A manifest entry is a glob, and a scoped local package has an `@` segment.
	// Both used to come back as "(unparsable value)", which made the finding that
	// named them useless.
	assert.equal(redactSource("dist/*.js"), "dist/*.js");
	assert.equal(redactSource("./packages/@acme/ext"), "./packages/@acme/ext");
	assert.equal(redactSource("@scope/pkg"), "@scope/pkg");
	// Still not a source: userinfo, and a bare word that could be a token.
	assert.equal(redactSource("user@host/path"), "(unparsable value)");
	assert.equal(redactSource("sk-live-pasted"), "(unparsable value)");
});

test("describeFsError turns an errno into words", () => {
	// Node's own message carries the errno, the syscall and the absolute path, and
	// it used to be the text of the "unreadable manifest" row.
	const err = (code) => Object.assign(new Error(`raw ${code} text`), { code });
	assert.equal(describeFsError(err("EACCES")), "permission denied");
	assert.equal(describeFsError(err("EISDIR")), "it is a directory, not a file");
	assert.equal(describeFsError(err("ENOSPC")), "no space left on the device");
	assert.equal(describeFsError(err("EWHAT")), "could not be read (EWHAT)");
	assert.doesNotMatch(describeFsError(err("EACCES")), /raw|text|\//);
});

test("ownerOf survives a registry entry that is not a path", () => {
	// `sourceInfo.path` comes from a third-party extension: a number there used to
	// throw out of the Registry group and collapse it into one crash row.
	assert.equal(ownerOf(42), "unknown");
	assert.equal(ownerOf({ path: "/x" }), "unknown");
	assert.equal(ownerOf(null), "unknown");
});

test("readJson reports a parse failure without quoting the file", () => {
	// Node 22 embeds a slice of the input in some JSON.parse messages, so the raw
	// message would put a neighbouring apiKey in the report.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-checkup-json-"));
	const file = path.join(dir, "models.json");
	fs.writeFileSync(file, '{"providers":{"p":{"apiKey": sk-live-9f8e}}}');
	const parsed = readJson(file);
	assert.equal(parsed.ok, false);
	assert.equal(parsed.invalid, true);
	assert.doesNotMatch(parsed.error, /sk-live-9f8e/);
	assert.match(parsed.error, /^not valid JSON/);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("redactSource keeps a local path and hides a pasted token", () => {
	// A package source is not always a URL: `./ext/single.js` and `/opt/ext` are
	// local entries, and hiding them made a real "points at a file" finding
	// unreadable. A bare token is the opposite case — no scheme, no path, no
	// host — and it is the one string that must never be echoed.
	assert.equal(redactSource("./ext/single.js"), "./ext/single.js");
	assert.equal(redactSource("/opt/ext"), "/opt/ext");
	assert.equal(redactSource("ext/single.js"), "ext/single.js");
	assert.equal(redactSource("npm:pkg"), "npm:pkg");
	assert.equal(redactSource("git:https://ghp_sekrit@github.com/me/x"), "git:https://***@github.com/me/x");
	assert.equal(redactSource("sk-ant-api03-AbC123"), "(unparsable value)");
	assert.equal(redactSource("sk-ant-api03-AbC123?x=1"), "(unparsable value)");
});

test("redactSource hides userinfo even when the source has no slashes", () => {
	// `alice:pw@host/v1` starts with `word:` and used to be taken for a scheme, so
	// scrubCredentials — which only matched the `//user:pass@` form — handed the
	// password back to the report.
	for (const value of ["alice:pw@host/v1", "npm:alice:pw@host/v1", "https:/alice:pw@host", "alice:s3cr3t"]) {
		const out = redactSource(value);
		assert.doesNotMatch(out, /pw|s3cr3t/, value);
	}
	// A package spec is not userinfo: `npm:pi-lens@0.9.1` has an "@" after a ":".
	assert.equal(redactSource("npm:pi-lens@0.9.1"), "npm:pi-lens@0.9.1");
	assert.equal(scrubCredentials("npm:stale@0.9.1"), "npm:stale@0.9.1");
	// scp-style git sources have a user but no password, and hiding them made a
	// real entry unreadable.
	assert.equal(redactSource("git@github.com:me/x"), "git@github.com:me/x");
});

test("renderReport stacks the detail under the title on a narrow terminal", () => {
	// At 40 columns the title column plus one word of detail left a gutter two
	// words wide, and the row read as one run-on sentence.
	const rows = [
		{ group: "Packages", id: "dirs", title: "package dirs", status: "warn", detail: "2 missing from node_modules: npm:a, npm:b", hint: "Run pi install." },
	];
	const narrow = renderReport(rows, { verbose: true, width: 40 });
	const lines = narrow.split("\n").filter(Boolean);
	assert.ok(lines.every((line) => line.length <= 40), narrow);
	assert.match(narrow, /package dirs\n {6}2 missing/);
	// The default layout is unchanged: the detail still starts on the title line.
	const wide = renderReport(rows, { verbose: true, width: 80 });
	assert.match(wide, /package dirs 2 missing from node_modules/);
});

test("truncateList says how much it left out", () => {
	assert.equal(truncateList(["a", "b"], 3), "a, b");
	assert.equal(truncateList(["a", "b", "c", "d"], 2), "a, b, ... 2 more");
	assert.equal(truncateList([], 2), "");
});

test("ownerOf names an owner for a path that ends at node_modules", () => {
	// The empty segment used to come back as "", and the attribution row rendered
	// as " (3)" — a count with no owner next to it.
	assert.equal(ownerOf("/home/u/.pi/agent/npm/node_modules/"), "unknown");
});

test("curl never carries the URL, proxy or headers on its command line", () => {
	// argv is world-readable through `ps`, and the URL can carry a query string
	// while the proxy and headers routinely carry credentials.
	const url = "https://user:sekrit@api.example.com/v1/models?key=sk-live";
	const proxy = "http://alice:s3cr3t@127.0.0.1:8080";
	const headers = { Authorization: "Bearer sk-live-token" };
	const config = curlConfig({ url, proxy, headers });
	const args = curlArgs("/tmp/curl.conf").join(" ");

	assert.match(config, /url = "https:\/\/user:sekrit@api\.example\.com\/v1\/models\?key=sk-live"/);
	assert.match(config, /proxy = "http:\/\/alice:s3cr3t@127\.0\.0\.1:8080"/);
	assert.match(config, /header = "Authorization: Bearer sk-live-token"/);
	for (const secret of ["sekrit", "s3cr3t", "sk-live", "api.example.com"]) {
		assert.doesNotMatch(args, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	// -q has to be the very first argument or curl still reads ~/.curlrc, and an
	// inherited NO_PROXY would route the probe around the proxy being tested.
	assert.equal(curlArgs("/tmp/curl.conf")[0], "-q");
	assert.match(args, /--noproxy {2}/);
});
