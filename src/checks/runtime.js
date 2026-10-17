// Runtime checks — the host environment Pi itself depends on.
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { bareHost, curlProbe, exists, humanBytes, isMissing, isWindows, proxyFromEnv, redactProxy, whichAll } from "../util.js";

export const group = "Runtime";

const MIN_NODE_MAJOR = 20;

function launcherHint(status, found) {
	if (status === "ok") return undefined;
	if (found) return "Shell shims and scripts that call `pi` by name may resolve to a different install.";
	return "No Pi launcher was found. This report describes the files on disk; install Pi or run it from the directory that has one.";
}

export async function run({ offline = false, agentDir: root, env = process.env } = {}) {
	const results = [];

	// --- agent directory ---------------------------------------------------
	// Without this row a container that never ran Pi reported "2 ok, 12 skipped"
	// and a green verdict: every check had skipped, so nothing had been looked at,
	// and the reader was told the install was fine.
	if (root && isMissing(root)) {
		results.push({
			group,
			id: "agent-dir",
			title: "agent dir",
			status: "warn",
			detail: `${root} does not exist — nothing about an install was inspected`,
			hint: "Run `pi` once to create it, or set PI_CODING_AGENT_DIR to the directory your install uses.",
		});
	} else if (root && !exists(root)) {
		// A directory this process cannot open is not a missing one, and "run pi
		// once to create it" is the wrong advice for a permissions problem.
		results.push({
			group,
			id: "agent-dir",
			title: "agent dir",
			status: "warn",
			detail: `${root} exists but could not be opened — nothing about an install was inspected`,
			hint: "A permissions or filesystem problem. Check ownership of the directory, or set PI_CODING_AGENT_DIR to the one your install uses.",
		});
	}

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
		// A pi installed by npm lives on PATH, not under the agent dir, so warning
		// on the absence of ~/.pi/agent/bin/pi told those users their launcher was
		// missing when `pi` was one PATH lookup away.
		const onPath = whichAll("pi", env, { windows: isWindows }).find((c) => exists(c));
		if (onPath) {
			launcherStatus = "ok";
			launcherDetail = `${onPath} (on PATH)`;
		} else {
			launcherStatus = "warn";
			launcherDetail = `no launcher at ${path.join(root, "bin")} and no \`pi\` on PATH`;
		}
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
		// "may resolve to a different install" presumes one exists. On a machine
		// with no Pi at all — the first `npx pi-checkup` — that sentence is wrong.
		hint: launcherHint(launcherStatus, found),
	});

	// --- disk --------------------------------------------------------------
	try {
		const stats = fs.statfsSync(root);
		// Guarded separately from blocks: a mock or an exotic filesystem can report
		// a block count without a block size, and NaN B free reads as a bug.
		const free = Number(stats.bavail) * Number(stats.bsize) || 0;
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
			// A bare errno is the least polished line a first run ever shows, and on a
			// machine that never ran Pi it is the expected state, not an error.
			detail: isMissing(root)
				? "agent directory does not exist yet — no volume to report on"
				: `cannot stat ${root}: ${String(e?.message ?? e)}`,
		});
	}

	// --- proxy -------------------------------------------------------------
	// Only meaningful when the user configured one. The default test is a plain
	// TCP connect to the proxy's own host:port: that answers "is the proxy
	// process running" without sending a single byte to a third party, which is
	// the only version of this check that matches the promise that pi-checkup
	// generates no traffic of its own. Set PI_CHECKUP_PROBE_URL to opt into a
	// real end-to-end forwarding test through the proxy.
	// Shared with the provider probe: the two used to disagree about what "a proxy
	// is configured" means, so one reported a proxy the other silently ignored.
	const proxy = proxyFromEnv(env);
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
		results.push(await checkProxy(proxy, env));
	}

	return results;
}

const DEFAULT_PROXY_PORT = { "http:": 80, "https:": 443, "socks5:": 1080, "socks5h:": 1080, "socks4:": 1080 };

// Re-exported so the report and the tests have one redaction primitive to reach
// for, and so the implementation lives next to redactUrl rather than beside the
// check that happened to need it first.
export { redactProxy };

/** Does something accept connections at this proxy's own address? */
async function checkProxy(proxy, env = process.env) {
	const shown = redactProxy(proxy);
	const row = (status, detail, hint) => ({ group, id: "proxy", title: "proxy", status, detail, hint });
	let parsed;
	try {
		parsed = new URL(proxy);
	} catch {
		return row("warn", `configured (${shown}) but not a parsable URL`, "Expected something like http://127.0.0.1:10808.");
	}
	let hostname = parsed.hostname;
	let port = Number(parsed.port) || DEFAULT_PROXY_PORT[parsed.protocol] || 0;
	if (!hostname || !port) {
		// `proxy.corp:8080` with no scheme is a shape curl accepts and this check
		// used to warn about — the same env value, judged two different ways.
		// Userinfo is stripped first: `user:pass@proxy.corp:8080` is a shape curl
		// also accepts, and the credential is not part of the address. The last `@`
		// is the separator, because a password may contain one — cutting at the
		// first left `proxy.corp:8080` unparsed and reported a working proxy as
		// having no usable host.
		const trimmed = proxy.trim();
		const at = trimmed.lastIndexOf("@");
		const bare = at === -1 ? trimmed : trimmed.slice(at + 1);
		const textual = /^([a-z0-9._\-[\]]+):(\d{1,5})$/i.exec(bare);
		if (textual) {
			hostname = textual[1];
			port = Number(textual[2]);
		}
	}
	if (!hostname || !port) {
		return row("warn", `configured (${shown}) without a usable host and port`);
	}

	// Opt-in end-to-end test: an explicit probe URL means the user asked for
	// real traffic through the proxy.
	const probeUrl = env.PI_CHECKUP_PROBE_URL;
	if (probeUrl) {
		// curl reads a leading "-" as an option, so an inherited value like
		// `--output=/etc/passwd` would be executed as one. Only an http(s) URL is
		// something this check knows how to test anyway.
		if (!/^https?:\/\//i.test(probeUrl)) {
			return row("warn", `PI_CHECKUP_PROBE_URL is not an http(s) URL; forwarding was not tested`);
		}
		const probe = await curlProbe(probeUrl, { proxy });
		// A non-zero curl exit is not "curl is missing": curl prints 000 to stdout
		// for a refused or timed-out connection and exits 7 or 28. Reading only
		// sh().ok turned a dead proxy into "skipped, tool unavailable".
		if (probe.setupFailed) {
			// The request never left the machine, so accusing the proxy would be a
			// finding this check did not establish.
			return row("skip", `configured (${shown}); the probe could not be set up: ${probe.error}`);
		}
		if (probe.missing) {
			return row("skip", `configured (${shown}); curl is not installed so forwarding was not tested`);
		}
		const code = probe.code;
		const numeric = Number(code);
		// A code is not proof of forwarding: 407 is the proxy demanding its own
		// credentials and 502/503/504 are what it emits when it could not reach the
		// target, so "forwarded a request" over those would be a claim this check
		// never established.
		const forwarded = numeric > 0 && numeric !== 407 && ![502, 503, 504].includes(numeric);
		if (forwarded) return row("ok", `${shown} forwarded a request (HTTP ${code})`);
		const hint = "The proxy is reachable but did not pass the request through: check its own auth settings, or whether it allows this target.";
		if (numeric > 0) return row("warn", `${shown} answered HTTP ${code} for the probe — the request was not forwarded`, hint);
		return row("fail", `${shown} did not forward (HTTP ${code || "000"})`, hint);
	}

	const probe = await tcpProbe(bareHost(hostname), port);
	return probe.ok
		? row("ok", `${shown} accepting connections`, "Set PI_CHECKUP_PROBE_URL to test real forwarding through it.")
		: row("fail", `nothing listening on ${shown} (${probe.error})`, "The proxy process is probably not running.");
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
