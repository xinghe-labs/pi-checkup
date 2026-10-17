// Runtime checks — the host environment Pi itself depends on.
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { exists, humanBytes, isWindows, sh } from "../util.js";

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
		const usedPct = Math.round((1 - stats.bavail / stats.blocks) * 100);
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
			detail: `configured (${proxy}); not tested in offline mode`,
		});
	} else {
		results.push(await checkProxy(proxy));
	}

	return results;
}

const DEFAULT_PROXY_PORT = { "http:": 80, "https:": 443, "socks5:": 1080, "socks5h:": 1080, "socks4:": 1080 };

/** Does something accept connections at this proxy's own address? */
async function checkProxy(proxy) {
	const row = (status, detail, hint) => ({ group, id: "proxy", title: "proxy", status, detail, hint });
	let parsed;
	try {
		parsed = new URL(proxy);
	} catch {
		return row("warn", `configured (${proxy}) but not a parsable URL`, "Expected something like http://127.0.0.1:10808.");
	}
	const port = Number(parsed.port) || DEFAULT_PROXY_PORT[parsed.protocol] || 0;
	if (!parsed.hostname || !port) {
		return row("warn", `configured (${proxy}) without a usable host and port`);
	}

	// Opt-in end-to-end test: an explicit probe URL means the user asked for
	// real traffic through the proxy.
	const probeUrl = process.env.PI_CHECKUP_PROBE_URL;
	if (probeUrl) {
		const probe = await sh(
			"curl",
			["-s", "-o", isWindows ? "NUL" : "/dev/null", "-w", "%{http_code}", "--max-time", "6", "-x", proxy, probeUrl],
			8000,
		);
		if (!probe.ok) return row("skip", `configured (${proxy}); curl unavailable so forwarding was not tested`);
		const code = probe.out.trim();
		const reachable = code !== "000" && code !== "";
		return row(
			reachable ? "ok" : "fail",
			reachable ? `${proxy} forwarded a request (HTTP ${code})` : `${proxy} did not forward (HTTP ${code || "000"})`,
			reachable ? undefined : "The proxy process is probably not running, or does not allow this target.",
		);
	}

	const probe = await tcpProbe(parsed.hostname, port);
	return probe.ok
		? row("ok", `${parsed.hostname}:${port} accepting connections`, "Set PI_CHECKUP_PROBE_URL to test real forwarding through it.")
		: row("fail", `nothing listening on ${parsed.hostname}:${port} (${probe.error})`, "The proxy process is probably not running.");
}

/** Plain TCP connect, so the proxy check causes no third-party traffic. */
function tcpProbe(host, port, timeout = 3000) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		const socket = net.connect({ host, port });
		socket.setTimeout(timeout);
		socket.once("connect", () => finish({ ok: true }));
		socket.once("timeout", () => finish({ ok: false, error: "timed out" }));
		socket.once("error", (e) => finish({ ok: false, error: String(e?.message ?? e) }));
	});
}
