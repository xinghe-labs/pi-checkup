// Runtime checks — the host environment Pi itself depends on.
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { bareHost, curlProbe, describeFsError, humanBytes, isMissing, isWindows, proxyFromEnv, redactProxy, whichAll } from "../util.js";

export const group = "Runtime";

/**
 * Can this directory actually be listed?
 *
 * `exists()` is `access(F_OK)`, which only answers "something is there" — a
 * mode-000 directory and a regular file both pass it. Everything this group
 * reports about an install is read out of the directory, so a directory that
 * cannot be listed has to be named as such.
 */
function canOpen(dir) {
	try {
		fs.readdirSync(dir);
		return true;
	} catch {
		return false;
	}
}

const MIN_NODE_MAJOR = 20;

function launcherHint(status, found) {
	if (status === "ok") return undefined;
	if (found) return "Shell shims and scripts that call `pi` by name may resolve to a different install.";
	return "No Pi launcher was found. This report describes the files on disk; install Pi or run it from the directory that has one.";
}

/**
 * The directory the free-space figure belongs to.
 *
 * `statfs` reports the filesystem holding the path, so on a machine with a
 * separate /home or a mounted workspace the number under "disk" is not the
 * number for `/`. Walking up while `dev` stays the same finds the mount root —
 * the same thing `df` prints — and a path that cannot be stat'ed falls back to
 * the filesystem root rather than dropping the row.
 */
function mountPointOf(target) {
	if (!target) return path.parse(process.cwd()).root;
	if (isWindows) return path.parse(target).root;
	let dir = path.resolve(target);
	let dev;
	try {
		dev = fs.statSync(dir).dev;
	} catch {
		return path.parse(dir).root;
	}
	for (;;) {
		const up = path.dirname(dir);
		if (up === dir) return dir;
		try {
			if (fs.statSync(up).dev !== dev) return dir;
		} catch {
			return dir;
		}
		dir = up;
	}
}

export async function run({ offline = false, agentDir: root, env = process.env, agentDirExplicit = false } = {}) {
	const results = [];

	// --- agent directory ---------------------------------------------------
	// Without this row a container that never ran Pi reported "2 ok, 12 skipped"
	// and a green verdict: every check had skipped, so nothing had been looked at,
	// and the reader was told the install was fine.
	if (root && isMissing(root)) {
		// Two situations, and only one of them is a problem with this run. An absent
		// default ~/.pi/agent just means Pi has not been started here yet; a path
		// the user passed in and got wrong is a broken invocation, and reporting it
		// as a warning left a mistyped PI_CODING_AGENT_DIR exiting 0 in CI over an
		// install that was never opened.
		// Still a warning, not a failure: a directory Pi has not created yet is not
		// damage, and `fail` is reserved for confirmed breakage. What changes when
		// the path was named explicitly is where the reader should look — at the
		// variable they typed, not at a default location this run never used.
		results.push({
			group,
			id: "agent-dir",
			title: "agent dir",
			status: "warn",
			detail: agentDirExplicit
				? `${root} does not exist — PI_CODING_AGENT_DIR names a directory that is not there, so nothing was inspected`
				: `${root} does not exist — nothing about an install was inspected`,
			hint: agentDirExplicit
				? "Check the value of PI_CODING_AGENT_DIR, or unset it to use ~/.pi/agent. Nothing was read from the install you meant to check."
				: "Run `pi` once to create it, or set PI_CODING_AGENT_DIR to the directory your install uses.",
		});
	} else if (root && !canOpen(root)) {
		// A directory this process cannot open is not a missing one, and "run pi
		// once to create it" is the wrong advice for a permissions problem. The
		// test is a read, not an existence check: `access(F_OK)` succeeds on a
		// mode-000 directory, so the old branch never fired for the case it was
		// written for.
		results.push({
			group,
			id: "agent-dir",
			title: "agent dir",
			status: "warn",
			// The directory could not be listed. `isMissing()` already ruled out a
			// path that is not there, so the finding is about access, not creation.
			detail: `${root} could not be opened — nothing about an install was inspected`,
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
	// `isFile`, not `exists`: a directory named `bin/pi` satisfied the existence
	// check and its 0755 mode satisfied the executable check, so the row showed a
	// green tick over something that cannot launch anything.
	const isFile = (p) => {
		try {
			return fs.statSync(p).isFile();
		} catch {
			return false;
		}
	};
	const found = [piBin, piBinAlt].find(isFile);
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
		const onPath = whichAll("pi", env, { windows: isWindows }).find(isFile);
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
				detail: `${humanBytes(free)} free on ${mountPointOf(root)}; this filesystem does not report a capacity`,
			});
		} else {
			results.push(
				usedPct >= 95
					? {
							group,
							id: "disk",
							title: "disk",
							status: "fail",
							detail: `${usedPct}% used on ${mountPointOf(root)}, ${humanBytes(free)} free`,
							hint: "Session files and package installs both fail when the volume fills up.",
						}
					: // The volume, not just a percentage: the report is scoped to one agent
						// directory, and "6% used" on a machine with three mounted disks left
						// the reader to guess which one had to have room.
						{ group, id: "disk", title: "disk", status: "ok", detail: `${usedPct}% used on ${mountPointOf(root)}, ${humanBytes(free)} free` },
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
			detail: isMissing(root) ? "agent directory does not exist yet — no volume to report on" : `could not stat ${root}: ${describeFsError(e)}`,
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
	// `redactProxy` returns a parenthesised placeholder for a value that is nothing
	// but a credential, so wrapping it again printed "configured ((configured))
	// but not a parsable URL"; saying "value hidden" is clearer than repeating
	// the word configured.
	const shownInParens = shown.startsWith("(") ? "(value hidden)" : `(${shown})`;
	const row = (status, detail, hint) => ({ group, id: "proxy", title: "proxy", status, detail, hint });
	let parsed = null;
	try {
		parsed = new URL(proxy);
	} catch {
		// Not fatal here: `127.0.0.1:10808` and `proxy.corp:8080` are both shapes
		// curl accepts, and only the second one parses as a URL (its "scheme" is a
		// dotted name). Returning early on the throw judged the same env value two
		// different ways depending on whether the host happened to start with a
		// digit. The textual fallback below decides.
	}
	let hostname = parsed?.hostname ?? "";
	let port = Number(parsed?.port) || DEFAULT_PROXY_PORT[parsed?.protocol] || 0;
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
		return row("warn", `configured ${shownInParens} but not a parsable URL`, "Expected something like http://127.0.0.1:10808.");
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
			return row("skip", `configured ${shownInParens}; the probe could not be set up: ${probe.error}`);
		}
		if (probe.missing) {
			return row("skip", `configured ${shownInParens}; curl is not installed so forwarding was not tested`);
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
	if (probe.ok) {
		return row("ok", `${shown} accepting connections`, "Set PI_CHECKUP_PROBE_URL to test real forwarding through it.");
	}
	// The 3s deadline is this process's. Folding it into the same branch as a
	// refused connection reported a slow or firewalled proxy as "nothing
	// listening" — the same local-timeout-blamed-on-the-remote mistake the
	// network checks were rewritten to avoid.
	if (probe.timedOut) {
		return row("warn", `${shown} did not answer within ${Math.round(tcpProbeTimeoutMs / 1000)}s — not proven down`, "A slow or firewalled proxy looks like this. If it is supposed to be running, check that host and port directly.");
	}
	return row("fail", `nothing listening on ${shown} (${probe.error})`, "The proxy process is probably not running.");
}

const tcpProbeTimeoutMs = 3000;

/** Plain TCP connect, so the proxy check causes no third-party traffic. */
function tcpProbe(host, port, timeout = tcpProbeTimeoutMs) {
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
		socket.once("timeout", () => finish({ ok: false, timedOut: true, error: "timed out" }));
		socket.once("error", (e) => finish({ ok: false, error: String(e?.message ?? e) }));
	});
}
