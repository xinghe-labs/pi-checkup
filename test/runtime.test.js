// Tests for the runtime checks — the module with the most external surface
// (filesystem, child processes, sockets) and, until now, none of the coverage.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as runtime from "../src/checks/runtime.js";

function tmp() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "checkup-runtime-"));
}

test("redactProxy never returns credentials", () => {
	// Corporate proxies put the password in the URL, and this string goes into the
	// report, the JSON payload, and CI logs.
	assert.equal(runtime.redactProxy("http://alice:s3cr3t@proxy.corp:8080"), "http://proxy.corp:8080");
	assert.equal(runtime.redactProxy("https://u:p@proxy.corp"), "https://proxy.corp");
	// A port the user did not write must not appear in the report.
	assert.equal(runtime.redactProxy("https://u:p@proxy.corp:3128"), "https://proxy.corp:3128");
	// Without a scheme the URL parser reads `alice:` as the scheme, so the
	// fallback is a string split, not new URL().
	assert.equal(runtime.redactProxy("alice:s3cr3t@proxy.corp:8080"), "proxy.corp:8080");
	assert.equal(runtime.redactProxy("socks5h://127.0.0.1:10808"), "socks5h://127.0.0.1:10808");
	assert.equal(runtime.redactProxy("http://127.0.0.1:10808"), "http://127.0.0.1:10808");
	assert.equal(runtime.redactProxy("garbage"), "garbage");
	// A user and a password with no host at all: the shape is the credential.
	assert.equal(runtime.redactProxy("alice:s3cr3t"), "(configured)");
	assert.equal(runtime.redactProxy("http://alice:s3cr3t"), "(configured)");
	// A scheme-less host:port is a shape curl accepts, so it is shown as written.
	assert.equal(runtime.redactProxy("proxy.corp:8080"), "proxy.corp:8080");
	assert.equal(runtime.redactProxy(""), "(empty)");
	assert.equal(runtime.redactProxy(undefined), "(empty)");
	for (const value of ["alice:s3cr3t@proxy.corp:8080", "http://alice:s3cr3t@proxy.corp:8080"]) {
		assert.ok(!runtime.redactProxy(value).includes("s3cr3t"), value);
	}
});

test("a zero-block filesystem does not report NaN% used", async () => {
	const original = fs.statfsSync;
	fs.statfsSync = () => ({ blocks: 0, bfree: 0, bavail: 0 });
	try {
		const rows = await runtime.run({ agentDir: tmp(), env: {} });
		const disk = rows.find((r) => r.id === "disk");
		// Some virtual filesystems report no block counts. Dividing by zero used to
		// print "NaN% used" on a green row.
		assert.equal(disk.status, "skip");
		assert.doesNotMatch(disk.detail, /NaN/);
	} finally {
		fs.statfsSync = original;
	}
});

test("a proxy that is not listening fails rather than passing silently", async () => {
	const dir = tmp();
	// Port 1 on loopback is reserved and never listening.
	const rows = await runtime.run({ agentDir: dir, env: { https_proxy: "http://127.0.0.1:1" } });
	const proxy = rows.find((r) => r.id === "proxy");
	assert.ok(proxy, JSON.stringify(rows));
	assert.equal(proxy.status, "fail");
	assert.match(proxy.detail, /127\.0\.0\.1:1/);
});

test("no proxy configured is skipped, not an empty green tick", async () => {
	const rows = await runtime.run({ agentDir: tmp(), env: {} });
	const proxy = rows.find((r) => r.id === "proxy");
	assert.equal(proxy.status, "skip");
});

test("a proxy URL in the report is always redacted", async () => {
	const rows = await runtime.run({
		agentDir: tmp(),
		env: { https_proxy: "http://alice:s3cr3t@127.0.0.1:1" },
	});
	const text = JSON.stringify(rows);
	assert.ok(!text.includes("s3cr3t"), text);
	assert.ok(!text.includes("alice"), text);
});

test("an IPv6 proxy literal is probed without its brackets", async () => {
	const rows = await runtime.run({ agentDir: tmp(), env: { https_proxy: "http://[::1]:1" } });
	const proxy = rows.find((r) => r.id === "proxy");
	// dns.lookup("[::1]") is ENOTFOUND; the brackets are URL syntax, not part of
	// the address.
	assert.ok(proxy, JSON.stringify(rows));
	// The redacted URL keeps the brackets because that is how the user wrote it,
	// but the connect itself must use the bare address: the error text is the
	// proof, since dns.lookup("[::1]") would have said ENOTFOUND instead.
	assert.match(proxy.detail, /::1:1/);
	assert.doesNotMatch(proxy.detail, /ENOTFOUND/);
});
