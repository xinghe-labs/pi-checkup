// Runtime checks — the host environment Pi itself depends on.
import path from "node:path";
import fs from "node:fs";
import { agentDir, exists, humanBytes, isWindows, sh } from "../util.js";

export const group = "Runtime";

const MIN_NODE_MAJOR = 20;

export async function run({ offline = false } = {}) {
	const results = [];
	const root = agentDir();

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
	// Only meaningful when the user configured one. We report that it is set and
	// reachable; we never send credentials anywhere.
	const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.http_proxy;
	if (!proxy) {
		results.push({ group, id: "proxy", title: "proxy", status: "skip", detail: "none configured" });
	} else if (offline) {
		results.push({ group, id: "proxy", title: "proxy", status: "skip", detail: `configured (${proxy}); not tested in offline mode` });
	} else {
		// Neutral, cheap endpoint: any HTTP answer proves the proxy is forwarding.
		// Override with PI_CHECKUP_PROBE_URL when the default is blocked locally.
		const probeUrl = process.env.PI_CHECKUP_PROBE_URL || "https://api.openai.com/v1/models";
		const probe = await sh(
			"curl",
			["-s", "-o", isWindows ? "NUL" : "/dev/null", "-w", "%{http_code}", "--max-time", "6", "-x", proxy, probeUrl],
			8000,
		);
		if (!probe.ok) {
			results.push({
				group,
				id: "proxy",
				title: "proxy",
				status: "skip",
				detail: `configured (${proxy}); curl unavailable so reachability was not tested`,
			});
		} else {
			const code = probe.out.trim();
			const reachable = code !== "000" && code !== "";
			results.push({
				group,
				id: "proxy",
				title: "proxy",
				status: reachable ? "ok" : "fail",
				detail: reachable ? `${proxy} reachable (HTTP ${code})` : `${proxy} did not answer (HTTP ${code || "000"})`,
				hint: reachable ? undefined : "The proxy process is probably not running.",
			});
		}
	}

	return results;
}
