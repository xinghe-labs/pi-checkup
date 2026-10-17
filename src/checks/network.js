// Network checks — are the endpoints your config points at actually alive?
//
// Deliberately provider-agnostic: every OpenAI-compatible provider exposes
// /models, and a 401/403 still proves the host answered. No vendor SDK, no
// API key validation (this package never spends your tokens).
import {
	bareHost,
	curlProbe,
	isLoopbackHost,
	proxyFromEnv,
	readJson,
	redactProxy,
	redactUrl,
	resolveHost,
	scrubCredentials,
	statusIsAlive,
	timedFetch,
} from "../util.js";

export const group = "Network";

export async function run({ offline = false, agentDir: root, modelsFile, env = process.env }) {
	const results = [];
	const models = readJson(modelsFile);
	if (!models.ok) {
		// Same distinction as Config: a parse failure is corruption, an oversized or
		// unreadable file is not, and saying "not valid JSON" about a valid file is
		// a claim this check never established.
		let reason = "could not be inspected";
		if (models.missing) reason = "is missing";
		else if (models.invalid) reason = "is not valid JSON";
		// "cannot read" covered a missing file and a corrupt one with the same
		// jargon, and those are two different problems with two different fixes.
		return [
			{
				group,
				id: "providers",
				title: "providers",
				status: "skip",
				detail: `models.json ${reason} — no endpoint to probe`,
				hint: models.missing
					? "Add providers to models.json, or configure them through Pi."
					: models.invalid
						? "The Config group reports the parse error."
						: undefined,
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
	// A provider whose baseUrl is not a string used to be dropped in silence, and
	// the report then claimed there was "no provider with a baseUrl in models.json"
	// — a statement about the config that the check had just disproved.
	const badBaseUrl = [];
	const proxy = proxyFromEnv(env);
	for (const [name, provider] of entries) {
		const baseUrl = provider.baseUrl ?? provider.base_url;
		if (baseUrl === undefined || baseUrl === null || baseUrl === "") continue;
		if (typeof baseUrl !== "string") {
			badBaseUrl.push(`${name} (${Array.isArray(baseUrl) ? "array" : typeof baseUrl})`);
			continue;
		}
		let url;
		try {
			url = new URL(baseUrl.replace(/\/+$/, "") + "/models");
		} catch {
			// Redacted: the usual cause is a hand-pasted baseUrl, and a pasted URL
			// is the one that still has `?key=…` on it.
			planned.push({ name, invalid: redactUrl(baseUrl) });
			continue;
		}
		// `localhost:11434/v1` — the routine hand-paste with no scheme — parses as
		// scheme `localhost:` with an opaque path and an empty hostname. The probe
		// then printed "null unreachable" and the DNS check invented a failure for
		// the empty string, which is a finding the check never established.
		if (!url.hostname || !/^https?:$/.test(url.protocol)) {
			planned.push({ name, invalid: redactUrl(baseUrl) });
			continue;
		}
		// A gateway configured as https://user:pass@host/v1 cannot be fetched at
		// all: fetch() refuses a URL that carries credentials, so the probe failed
		// with an error that quoted the password back. Moving them into a header
		// makes the probe work and keeps them out of the URL and the message.
		let userinfo = null;
		let userinfoError = null;
		if (url.username || url.password) {
			// A literal `%` survives the URL parser but throws in decodeURIComponent.
			// The throw used to escape run(), replacing the whole Network group with
			// a crash row that blamed pi-checkup for a typo in the user's config.
			try {
				const pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
				userinfo = `Basic ${Buffer.from(pair).toString("base64")}`;
			} catch {
				userinfoError = `${name}: credentials in baseUrl are not valid percent-encoding, so they were not sent`;
			}
			url.username = "";
			url.password = "";
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
		planned.push({
			name,
			url,
			key: hasKey && !(url.protocol === "http:" && !loopback) ? key : null,
			// An explicit apiKey wins over userinfo; a URL carrying both is a user
			// mid-migration, not a configuration to guess about.
			userinfo: hasKey ? null : userinfo,
			userinfoError,
		});
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
		const { name, url, key, userinfo, userinfoError } = item;
		const host = bareHost(url.hostname);
		hosts.set(host, name);
		if (userinfoError) {
			probes.push(Promise.resolve({ name, status: "warn", detail: userinfoError }));
			continue;
		}
		const auth = key ? `Bearer ${key}` : userinfo;
		const headers = auth ? { Authorization: auth } : {};
		probes.push(probeEndpoint(url, { headers, proxy }).then((outcome) => ({ ...outcome, name })));
	}

	// One line regardless of how many providers are configured. A user with ten
	// endpoints should not get ten lines of green ticks; the detail is still
	// there under `verbose`.
	const outcomes = await Promise.all(probes);
	const unhealthy = outcomes.filter((o) => o.status === "warn" || o.status === "fail");
	const unprobed = outcomes.filter((o) => o.status === "skip");
	if (!outcomes.length) {
		results.push({
			group,
			id: "providers",
			title: "providers",
			status: "skip",
			detail: "no provider with a baseUrl in models.json",
		});
	} else if (!unhealthy.length && unprobed.length) {
		// Nothing was sent, so there is nothing to call healthy.
		results.push({
			group,
			id: "providers",
			title: "providers",
			status: "skip",
			detail: unprobed.map((o) => o.detail).join("; "),
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

	if (badBaseUrl.length) {
		results.push({
			group,
			id: "baseUrl-shape",
			title: "baseUrl shape",
			status: "warn",
			detail: `${badBaseUrl.join(", ")} — baseUrl is not a string, so the endpoint was not probed`,
			hint: "baseUrl has to be a quoted string like \"https://api.example.com/v1\".",
		});
	}

	// --- DNS ---------------------------------------------------------------
	// A host that resolves to loopback while the baseUrl is remote, or does not
	// resolve at all, explains a whole class of "it worked yesterday" failures.
	// Loopback hosts are excluded from the count as well as from the lookup: a
	// host this check deliberately skips is not a host that "resolved normally".
	const dnsTargets = [...hosts].filter(([host]) => !isLoopbackHost(host));
	const dnsChecks = await Promise.all(
		dnsTargets.map(async ([host, provider]) => {
			const res = await resolveHost(host);
			if (!res.ok) {
				// A deadline is this process giving up, not the resolver answering.
				// Reporting it as "does not resolve" failed a host that resolves fine
				// on a slow corporate resolver.
				const timedOut = /timeout/i.test(String(res.error));
				return {
					host,
					provider,
					status: timedOut ? "warn" : "fail",
					detail: timedOut ? `${host} resolution timed out — not proven broken` : `${host} does not resolve (${res.error})`,
				};
			}
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
/**
 * Probe one endpoint, through the proxy when one is configured.
 *
 * Node's global fetch ignores `https_proxy` and friends, so a user behind a
 * corporate proxy saw "unreachable" for endpoints that work in their browser —
 * a false finding in a tool whose only job is to avoid them. curl honours the
 * proxy natively; it is already a dependency of the opt-in forwarding test.
 */
async function probeEndpoint(url, { headers, proxy }) {
	if (!proxy) {
		const res = await timedFetch(url.toString(), { headers });
		// 401/403 means the endpoint is up and merely disagrees about auth, which
		// is a configuration problem, not a reachability problem.
		const alive = res.ok && (res.status === 200 || res.status === 401 || res.status === 403);
		return { status: alive ? "ok" : "warn", detail: describeProbe(url, res, alive) };
	}
	const res = await curlProbe(url.toString(), { proxy, headers });
	if (res.setupFailed) {
		// The probe never left the machine; blaming the endpoint would be a finding
		// this check did not establish.
		return { status: "skip", detail: `not probed: ${res.error}` };
	}
	if (res.missing) {
		return { status: "skip", detail: "not probed: a proxy is configured but curl is not installed" };
	}
	const code = Number(res.code);
	const alive = statusIsAlive(code);
	if (alive) {
		return { status: "ok", detail: `${redactUrl(url.toString())} answered ${code} through ${redactProxy(proxy)}` };
	}
	// The proxy path failed. Node's fetch ignores `https_proxy`, so Pi's own
	// requests take the direct path — and a run inside Pi would then call the same
	// endpoint reachable while the CLI called it dead. Ask the other path before
	// blaming the endpoint.
	const direct = await timedFetch(url.toString(), { headers });
	const directAlive = direct.ok && statusIsAlive(direct.status);
	const through = `through ${redactProxy(proxy)}`;
	if (directAlive) {
		return {
			status: "warn",
			detail: `${redactUrl(url.toString())} answered HTTP ${direct.status} directly but not ${through} (${scrubCredentials(res.error) || `HTTP ${code}`}) — Pi's own requests ignore https_proxy`,
		};
	}
	return {
		status: "warn",
		detail: `${redactUrl(url.toString())} did not answer ${through}${code ? ` (HTTP ${code})` : ""}; ${scrubCredentials(res.error) || "no response"}${direct.status ? ` — and HTTP ${direct.status} directly` : ""}`,
	};
}

function describeProbe(url, res, alive) {
	// `url.origin` never carries userinfo, but `res.error` is fetch's own message
	// and does quote the URL it failed on, so it is scrubbed before it can reach
	// the report.
	if (alive) return `${url.origin} reachable (HTTP ${res.status})`;
	if (res.status) return `${url.origin} answered HTTP ${res.status}`;
	return `${url.origin} unreachable (${scrubCredentials(res.error)})`;
}
