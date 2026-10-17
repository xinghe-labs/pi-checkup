// Runtime checks — the host environment Pi itself depends on.
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { bareHost, exists, humanBytes, isWindows, sh } from "../util.js";

export const group = "Runtime";

const MIN_NODE_MAJOR = 20;

export async function run({ offline = false, agentDir: root } = {}) {
	const results = [];

	// --- node --------------------------------------------------------------
	const major = Number(process.versions.node.split(".")[0]);
	results.push(
		major >= MIN_NODE_MAJOR
			? { group, id: "node", title: "node", status: "ok", detail: `v${process.versions.node}` }
			: {
					group,
					id: "node",
					title: "node",
					status: "fail",
					detail: `v${process.versions.node} is below the minimum v${MIN_NODE_MAJOR}`,
					hint: "Upgrade Node. Older releases miss APIs that packages here assume.",
				},
	);

	// --- pi binary ---------------------------------------------------------
	const piBin = path.join(root, "bin", isWindows ? "pi.cmd" : "pi");
	const piBinAlt = path.join(root, "bin", "pi");
	const found = [piBin, piBinAlt].find(exists);
	let executable = false;
	if (found && !isWindows) {
		try {
			executable = (fs.statSync(found).mode & 0o111) !== 0;
		} catch {
			executable = false;
		}
	} else {
		executable = Boolean(found);
	}
	let launcherDetail;
	let launcherStatus;
	if (!found) {
		launcherStatus = "warn";
		launcherDetail = `no launcher at ${path.join(root, "bin")}`;
	} else if (!executable) {
		launcherStatus = "warn";
		launcherDetail = `${found} is not executable`;
	} else {
		launcherStatus = "ok";
		launcherDetail = found;
	}
	results.push({
		group,
		id: "pi-bin",
		title: "pi launcher",
		status: launcherStatus,
		detail: launcherDetail,
		hint: launcherStatus === "ok" ? undefined : "Shell shims and scripts that call `pi` by name may resolve to a different install.",
	});

	// --- disk --------------------------------------------------------------
	try {
		const stats = fs.statfsSync(root);
		const free = Number(stats.bavail) * Number(stats.bsize);
		// blocks is 0 on some virtual filesystems; 1 - 0/0 is NaN, which used to
		// sail past the threshold check and print "NaN% used" as a green tick.
		const blocks = Number(stats.blocks);
		const usedPct = blocks > 0 ? Math.round((1 - Number(stats.bavail) / blocks) * 100) : null;
		if (usedPct === null) {
			results.push({
				group,
				id: "disk",
				title: "disk",
				status: "skip",
				detail: `${humanBytes(free)} free; this filesystem does not report a capacity`,
			});
		} else {
			results.push(
				usedPct >= 95
					? {
							group,
							id: "disk",
							title: "disk",
							status: "fail",
							detail: `${usedPct}% used, ${humanBytes(free)} free`,
							hint: "Session files and package installs both fail when the volume fills up.",
						}
					: { group, id: "disk", title: "disk", status: "ok", detail: `${usedPct}% used, ${humanBytes(free)} free` },
			);
		}
	} catch (e) {
		results.push({
			group,
			id: "disk",
			title: "disk",
			status: "skip",
			detail: `cannot stat ${root}: ${String(e?.message ?? e)}`,
		});
	}

	// --- proxy -------------------------------------------------------------
	// Only meaningful when the user configured one. The default test is a plain
	// TCP connect to the proxy's own host:port: that answers "is the proxy
	// process running" without sending a single byte to a third party, which is
	// the only version of this check that matches the promise that pi-checkup
	// generates no traffic of its own. Set PI_CHECKUP_PROBE_URL to opt into a
	// real end-to-end forwarding test through the proxy.
	const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.http_proxy;
	if (!proxy) {
		results.push({ group, id: "proxy", title: "proxy", status: "skip", detail: "none configured" });
	} else if (offline) {
		results.push({
			group,
			id: "proxy",
			title: "proxy",
			status: "skip",
			detail: `configured (${redactProxy(proxy)}); not tested in offline mode`,
		});
	} else {
		results.push(await checkProxy(proxy));
	}

	return results;
}

const DEFAULT_PROXY_PORT = { "http:": 80, "https:": 443, "socks5:": 1080, "socks5h:": 1080, "socks4:": 1080 };

/**
 * A proxy URL safe to put in a report.
 *
 * Corporate proxies are routinely configured as http://user:password@host:port,
 * so the raw env value must never reach the terminal, the JSON payload, or a CI
 * log — which is exactly where --offline used to print it. Scheme, host and port
 * are all the user needs to recognise their own proxy.
 */
export function redactProxy(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return "(empty)";

	// Only trust the URL parser when the value actually looks like a URL. Without
	// "//", `alice:pw@host:8080` parses as scheme "alice:" and the parser returns
	// a meaningless origin instead of a scrubbed one.
	if (text.includes("://")) {
		try {
			const url = new URL(text);
			if (url.hostname) {
				const port = url.port || DEFAULT_PROXY_PORT[url.protocol] || "";
				return `${url.protocol}//${url.hostname}${port ? `:${port}` : ""}`;
			}
		} catch {
			// Fall through to the textual scrub below.
		}
	}

	// Everything before the last "@" is a credential; everything after it is the
	// proxy the user needs to recognise.
	return text.slice(text.lastIndexOf("@") + 1).replace(/^[a-z0-9+.-]+:\/\//i, "") || "(configured)";
}

/** Does something accept connections at this proxy's own address? */
async function checkProxy(proxy) {
	const shown = redactProxy(proxy);
	const row = (status, detail, hint) => ({ group, id: "proxy", title: "proxy", status, detail, hint });
	let parsed;
	try {
		parsed = new URL(proxy);
	} catch {
		return row("warn", `configured (${shown}) but not a parsable URL`, "Expected something like http://127.0.0.1:10808.");
	}
	const port = Number(parsed.port) || DEFAULT_PROXY_PORT[parsed.protocol] || 0;
	if (!parsed.hostname || !port) {
		return row("warn", `configured (${shown}) without a usable host and port`);
	}

	// Opt-in end-to-end test: an explicit probe URL means the user asked for
	// real traffic through the proxy.
	const probeUrl = process.env.PI_CHECKUP_PROBE_URL;
	if (probeUrl) {
		const probe = await probeThroughProxy(proxy, probeUrl);
		// A non-zero curl exit is not "curl is missing": curl prints 000 to stdout
		// for a refused or timed-out connection and exits 7 or 28. Reading only
		// sh().ok turned a dead proxy into "skipped, tool unavailable".
		if (probe.missing) {
			return row("skip", `configured (${shown}); curl is not installed so forwarding was not tested`);
		}
		const code = probe.out.trim();
		const reachable = code !== "000" && code !== "";
		return row(
			reachable ? "ok" : "fail",
			reachable ? `${shown} forwarded a request (HTTP ${code})` : `${shown} did not forward (HTTP ${code || "000"})`,
			reachable ? undefined : "The proxy process is probably not running, or does not allow this target.",
		);
	}

	const probe = await tcpProbe(bareHost(parsed.hostname), port);
	return probe.ok
		? row("ok", `${shown} accepting connections`, "Set PI_CHECKUP_PROBE_URL to test real forwarding through it.")
		: row("fail", `nothing listening on ${shown} (${probe.error})`, "The proxy process is probably not running.");
}

/**
 * Run curl through the proxy, passing the proxy URL in a 0600 config file.
 *
 * Not as `-x <proxy>`: that puts any embedded password in argv, where every
 * other user on the box can read it out of `ps` and /proc.
 */
async function probeThroughProxy(proxy, probeUrl) {
	let configFile;
	try {
		configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-checkup-")), "curl.conf");
		// curl config syntax: quoted values, backslash escapes.
		const quoted = String(proxy).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		fs.writeFileSync(configFile, `proxy = "${quoted}"\n`, { mode: 0o600 });
	} catch {
		return { out: "", err: "could not create a temp config file", missing: false };
	}
	try {
		return await sh(
			"curl",
			["-s", "-o", isWindows ? "NUL" : "/dev/null", "-w", "%{http_code}", "--max-time", "6", "--config", configFile, probeUrl],
			8000,
		);
	} finally {
		try {
			fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
		} catch {
			// Best effort; the file is 0600 and inside the OS temp dir.
		}
	}
}

/** Plain TCP connect, so the proxy check causes no third-party traffic. */
function tcpProbe(host, port, timeout = 3000) {
	return new Promise((resolve) => {
		let socket;
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			socket?.destroy();
			resolve(result);
		};
		try {
			socket = net.connect({ host, port });
		} catch (e) {
			finish({ ok: false, error: String(e?.message ?? e) });
			return;
		}
		socket.setTimeout(timeout);
		socket.once("connect", () => finish({ ok: true }));
		socket.once("timeout", () => finish({ ok: false, error: "timed out" }));
		socket.once("error", (e) => finish({ ok: false, error: String(e?.message ?? e) }));
	});
}
