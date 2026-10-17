// Network checks — are the endpoints your config points at actually alive?
//
// Deliberately provider-agnostic: every OpenAI-compatible provider exposes
// /models, and a 401/403 still proves the host answered. No vendor SDK, no
// API key validation (this package never spends your tokens).
import path from "node:path";
import { bareHost, isLoopbackHost, readJson, resolveHost, timedFetch } from "../util.js";

export const group = "Network";

export async function run({ offline = false, agentDir: root, modelsFile }) {
	const results = [];
	const models = readJson(modelsFile);
	if (!models.ok) {
		return [
			{
				group,
				id: "providers",
				title: "providers",
				status: "skip",
				detail: `cannot read ${modelsFile}`,
			},
		];
	}

	const providers = models.data?.providers ?? models.data ?? {};
	const entries = Object.entries(providers).filter(([, p]) => p && typeof p === "object");

	// Worked out before the offline branch: whether a key would cross the network
	// in the clear is a property of the config, not of the probe. Skipping it in
	// offline mode hid a real misconfiguration from the one mode a locked-down
	// user is most likely to run.
	const cleartext = [];
	const planned = [];
	for (const [name, provider] of entries) {
		const baseUrl = provider.baseUrl ?? provider.base_url;
		if (!baseUrl || typeof baseUrl !== "string") continue;
		let url;
		try {
			url = new URL(baseUrl.replace(/\/+$/, "") + "/models");
		} catch {
			planned.push({ name, invalid: baseUrl });
			continue;
		}
		const key = provider.apiKey ?? provider.api_key;
		const hasKey = typeof key === "string" && key.length > 0;
		const loopback = isLoopbackHost(url.hostname);
		if (hasKey && url.protocol === "http:" && !loopback) {
			// Testing reachability is not worth putting a live credential on the
			// wire in the clear, so the probe goes out unauthenticated and the
			// config gets reported instead.
			cleartext.push(name);
		}
		planned.push({ name, url, key: hasKey && !(url.protocol === "http:" && !loopback) ? key : null });
	}

	const cleartextRow = cleartext.length
		? {
				group,
				id: "cleartext",
				title: "cleartext auth",
				status: "warn",
				detail: `${cleartext.join(", ")} use http:// with an apiKey configured`,
				hint: "Switch the baseUrl to https://, or use a host on localhost. The reachability probe was sent without the key.",
			}
		: null;

	if (offline) {
		const rows = [
			{
				group,
				id: "providers",
				title: "providers",
				status: "skip",
				detail: `offline mode — ${planned.length} configured endpoint(s) not probed`,
				hint: "Re-run without --offline to test reachability.",
			},
			// Emitted as a skip rather than omitted: a row that vanishes in offline
			// mode makes the check count and the summary change between two runs of
			// the same tool, which is exactly the kind of drift a health report
			// should not have.
			{ group, id: "dns", title: "dns", status: "skip", detail: "offline mode — no host resolved" },
		];
		if (cleartextRow) rows.push(cleartextRow);
		return rows;
	}

	const hosts = new Map();
	const probes = [];
	for (const item of planned) {
		if (item.invalid !== undefined) {
			probes.push(Promise.resolve({ name: item.name, status: "fail", detail: `${item.name}: invalid baseUrl ${item.invalid}` }));
			continue;
		}
		const { name, url, key } = item;
		const host = bareHost(url.hostname);
		hosts.set(host, name);
		const headers = key ? { Authorization: `Bearer ${key}` } : {};
		probes.push(
			timedFetch(url.toString(), { headers }).then((res) => {
				// 401/403 means the endpoint is up and merely disagrees about auth,
				// which is a configuration problem, not a reachability problem.
				const alive = res.ok && (res.status === 200 || res.status === 401 || res.status === 403);
				return { name, status: alive ? "ok" : "warn", detail: describeProbe(url, res, alive) };
			}),
		);
	}

	// One line regardless of how many providers are configured. A user with ten
	// endpoints should not get ten lines of green ticks; the detail is still
	// there under `verbose`.
	const outcomes = await Promise.all(probes);
	const unhealthy = outcomes.filter((o) => o.status !== "ok");
	if (!outcomes.length) {
		results.push({
			group,
			id: "providers",
			title: "providers",
			status: "skip",
			detail: "no provider with a baseUrl in models.json",
		});
	} else if (!unhealthy.length) {
		results.push({
			group,
			id: "providers",
			title: "providers",
			status: "ok",
			detail: `${outcomes.length} endpoint(s) reachable`,
		});
	} else {
		results.push({
			group,
			id: "providers",
			title: "providers",
			status: unhealthy.some((o) => o.status === "fail") ? "fail" : "warn",
			detail: `${unhealthy.length} of ${outcomes.length} unhealthy: ${unhealthy.map((o) => o.name).join(", ")}`,
			hint: `${unhealthy.map((o) => o.detail).join("; ")}. Check the baseUrl, whether the server is running, and whether a proxy is required.`,
		});
	}

	if (cleartextRow) results.push(cleartextRow);

	// --- DNS ---------------------------------------------------------------
	// A host that resolves to loopback while the baseUrl is remote, or does not
	// resolve at all, explains a whole class of "it worked yesterday" failures.
	// Loopback hosts are excluded from the count as well as from the lookup: a
	// host this check deliberately skips is not a host that "resolved normally".
	const dnsTargets = [...hosts].filter(([host]) => !isLoopbackHost(host));
	const dnsChecks = await Promise.all(
		dnsTargets.map(async ([host, provider]) => {
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
	} else if (!dnsTargets.length) {
		results.push({
			group,
			id: "dns",
			title: "dns",
			status: "skip",
			detail: hosts.size ? "every provider host is loopback" : "no provider host to resolve",
		});
	} else {
		results.push({
			group,
			id: "dns",
			title: "dns",
			status: "ok",
			detail: `${dnsTargets.length} provider host(s) resolve normally`,
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
