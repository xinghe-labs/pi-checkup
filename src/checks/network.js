// Network checks — are the endpoints your config points at actually alive?
//
// Deliberately provider-agnostic: every OpenAI-compatible provider exposes
// /models, and a 401/403 still proves the host answered. No vendor SDK, no
// API key validation (this package never spends your tokens).
import path from "node:path";
import { agentDir, readJson, resolveHost, timedFetch } from "../util.js";

export const group = "Network";

export async function run() {
	const results = [];
	const modelsFile = path.join(agentDir(), "models.json");
	const models = readJson(modelsFile);
	if (!models.ok) {
		return [
			{
				group,
				id: "models",
				title: "providers",
				status: "skip",
				detail: `cannot read ${modelsFile}`,
			},
		];
	}

	const providers = models.data?.providers ?? models.data ?? {};
	const entries = Object.entries(providers).filter(([, p]) => p && typeof p === "object");

	const hosts = new Map();
	const probes = [];
	for (const [name, provider] of entries) {
		const baseUrl = provider.baseUrl ?? provider.base_url;
		if (!baseUrl || typeof baseUrl !== "string") continue;
		let url;
		try {
			url = new URL(baseUrl.replace(/\/+$/, "") + "/models");
		} catch {
			results.push({
				group,
				id: `url:${name}`,
				title: name,
				status: "fail",
				detail: `invalid baseUrl: ${baseUrl}`,
			});
			continue;
		}
		hosts.set(url.hostname, name);
		const headers = {};
		const key = provider.apiKey ?? provider.api_key;
		if (typeof key === "string" && key) headers.Authorization = `Bearer ${key}`;
		probes.push(
			timedFetch(url.toString(), { headers }).then((res) => {
				// 401/403 means the endpoint is up and merely disagrees about auth,
				// which is a configuration problem, not a reachability problem.
				const alive = res.ok && (res.status === 200 || res.status === 401 || res.status === 403);
				return {
					group,
					id: `endpoint:${name}`,
					title: name,
					status: alive ? "ok" : "warn",
					detail: describeProbe(url, res, alive),
					hint: alive ? undefined : "Check the baseUrl, whether the server is running, and whether a proxy is required.",
				};
			}),
		);
	}

	if (!probes.length) {
		results.push({
			group,
			id: "providers",
			title: "providers",
			status: "skip",
			detail: "no provider with a baseUrl in models.json",
		});
	}

	results.push(...(await Promise.all(probes)));

	// --- DNS ---------------------------------------------------------------
	// A host that resolves to loopback while the baseUrl is remote, or does not
	// resolve at all, explains a whole class of "it worked yesterday" failures.
	const dnsChecks = await Promise.all(
		[...hosts].map(async ([host, provider]) => {
			if (host === "localhost" || /^127\./.test(host) || /^::1$/.test(host)) return null;
			const res = await resolveHost(host);
			if (!res.ok) return { host, provider, status: "fail", detail: `${host} does not resolve (${res.error})` };
			const loopback = res.addresses.every((a) => a === "::1" || a.startsWith("127."));
			if (loopback) {
				return {
					host,
					provider,
					status: "warn",
					detail: `${host} resolves only to loopback (${res.addresses.join(", ")}) for provider "${provider}"`,
				};
			}
			return null;
		}),
	);
	const dnsProblems = dnsChecks.filter(Boolean);
	const anyUnresolved = dnsProblems.some((p) => p.status === "fail");
	if (dnsProblems.length) {
		results.push({
			group,
			id: "dns",
			title: "dns",
			status: anyUnresolved ? "fail" : "warn",
			detail: dnsProblems.map((p) => p.detail).join("; "),
			hint: "Fix DNS or use a proxy. A hosts-file override is usually the fastest repair.",
		});
	} else {
		results.push({
			group,
			id: "dns",
			title: "dns",
			status: "ok",
			detail: `${hosts.size} provider host(s) resolve normally`,
		});
	}

	return results;
}

/** One-line verdict for a provider probe, kept out of the ternary chain. */
function describeProbe(url, res, alive) {
	if (alive) return `${url.origin} reachable (HTTP ${res.status})`;
	if (res.status) return `${url.origin} answered HTTP ${res.status}`;
	return `${url.origin} unreachable (${res.error})`;
}
