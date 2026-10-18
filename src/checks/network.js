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
	truncateList,
} from "../util.js";

export const group = "Network";

/**
 * Does this provider declare a header whose value is a credential?
 *
 * Matched by name, never by value: the values are the secrets. Pi interpolates
 * `$NAME` in header values and sends them, so a header carrying a token is the
 * same exposure as an `apiKey` and has to count the same way.
 */
function hasCredentialHeader(headers) {
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) return false;
	return Object.keys(headers).some((name) =>
		/(^|[-_])(authorization|auth|api[-_]?key|access[-_]?key|token|secret|password|bearer)([-_]|$)/i.test(name),
	);
}

export async function run({ offline = false, modelsFile, env = process.env, hasRuntime = false }) {
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

	// `providers` must be a non-null object. The `??` fallthrough to the whole
	// file made two wrong shapes read as content: `"providers": null` iterated the
	// top-level keys as if they were providers, and `"providers": 5` silently
	// became "no provider with a baseUrl" — a claim about a config whose
	// providers key is a number. Feeding the bad value back through the normal
	// entry loop makes it land in the named shape row instead.
	const fileData = models.data && typeof models.data === "object" && !Array.isArray(models.data) ? models.data : {};
	const rawProviders = fileData.providers;
	let providers;
	if (rawProviders === undefined) {
		providers = fileData;
	} else if (rawProviders && typeof rawProviders === "object" && !Array.isArray(rawProviders)) {
		providers = rawProviders;
	} else {
		providers = { providers: rawProviders };
	}

	// Worked out before the offline branch: whether a key would cross the network
	// in the clear is a property of the config, not of the probe. Skipping it in
	// offline mode hid a real misconfiguration from the one mode a locked-down
	// user is most likely to run.
	const cleartext = [];
	const planned = [];
	// Anything dropped for its shape is named here. Dropping silently made the
	// report claim "no provider with a baseUrl" about a config it had just
	// disproved — and a provider whose value is not even an object was the same
	// hole one level up.
	const shape = [];
	const queryWithheld = [];
	// Providers that declare a credential but no `baseUrl` are not endpoints to
	// probe — Pi may have a built-in default for them — but they were dropped in
	// silence, so a user with five providers and one baseUrl read "1 endpoint(s)
	// reachable" and had no way to tell the other four were never looked at.
	const noBaseUrl = [];
	const proxy = proxyFromEnv(env);
	for (const [name, provider] of Object.entries(providers)) {
		if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
			shape.push(`${name} (${provider === null ? "null" : Array.isArray(provider) ? "array" : typeof provider}) is not a provider object`);
			continue;
		}
		const baseUrl = provider.baseUrl ?? provider.base_url;
		if (baseUrl === undefined || baseUrl === null || baseUrl === "") {
			noBaseUrl.push(name);
			continue;
		}
		if (typeof baseUrl !== "string") {
			shape.push(`${name} (${Array.isArray(baseUrl) ? "array" : typeof baseUrl}) — baseUrl is not a string`);
			continue;
		}
		// Pi interpolates `apiKey` and header values, not `baseUrl`. A `${HOST}` here
		// is a literal string, and `new URL` accepts it — so the probe would ask DNS
		// for a host literally named `${HOST}`, report "does not resolve", and leave
		// the reader to work out that the interpolation they expected never happens.
		// Only the part before the query is examined: `?$filter=x` is OData, not an
		// environment reference, and flagging it was noise.
		if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(baseUrl.split("?")[0])) {
			shape.push(`${name}: baseUrl contains an environment reference, but Pi interpolates only apiKey and header values — this is the literal string`);
			continue;
		}
		let url;
		try {
			url = new URL(baseUrl);
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
		// Appended to the pathname, not to the raw string: `…/v1?api-version=2024`
		// used to become `…/v1?api-version=2024/models`, so the probe asked a
		// different question than the config posed and a 404 was reported as a
		// broken provider.
		url.pathname = url.pathname.replace(/\/+$/, "") + "/models";
		// A gateway configured as https://user:pass@host/v1 cannot be fetched at
		// all: fetch() refuses a URL that carries credentials, so the probe failed
		// with an error that quoted the password back. Moving them into a header
		// makes the probe work and keeps them out of the URL and the message.
		const key = provider.apiKey ?? provider.api_key;
		const hasKey = typeof key === "string" && key.length > 0;
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
				// Only a blocker when the userinfo was the credential that would have
				// been sent: with an apiKey configured, refusing to probe reported a
				// credentials typo as an unreachable provider.
				if (!hasKey) userinfoError = `${name}: credentials in baseUrl are not valid percent-encoding, so they were not sent`;
			}
			url.username = "";
			url.password = "";
		}
		const loopback = isLoopbackHost(url.hostname);
		// One rule for every credential shape: over plain http to a host that is
		// not this machine, nothing is sent. Testing reachability is not worth
		// putting a live secret on the wire in the clear. The apiKey branch had
		// this guard from the start; userinfo went out as a Basic header, and
		// `?key=…` gateways went out as part of the URL.
		const hasQuery = url.search.length > 1;
		// A custom header is a credential Pi interpolates and Pi sends, so a remote
		// http:// endpoint whose only secret lives in `headers.Authorization` was
		// reported clean by the one row that exists to catch exactly that. Names
		// only — the values are never read here, let alone printed.
		const headerAuth = hasCredentialHeader(provider.headers);
		const cleartextAuth = (hasKey || userinfo || hasQuery || headerAuth) && url.protocol === "http:" && !loopback;
		if (cleartextAuth) cleartext.push(name);
		// A query string cannot be inspected for secrets, so it is not sent at all
		// on a cleartext endpoint: dropping only the parts that look like keys
		// would be guessing. The endpoint is left unprobed rather than probed with
		// a different URL, because a 404 for the stripped request is not a fact
		// about the configured endpoint.
		// Not probed at all (see the probe loop): dropping the query string and
		// sending the rest would answer a question the config did not ask.
		const withheld = cleartextAuth && hasQuery;
		if (withheld) queryWithheld.push(name);
		planned.push({
			name,
			url,
			withheld,
			key: hasKey && !cleartextAuth ? key : null,
			// An explicit apiKey wins over userinfo; a URL carrying both is a user
			// mid-migration, not a configuration to guess about.
			userinfo: hasKey || cleartextAuth ? null : userinfo,
			userinfoError,
		});
	}

	const cleartextRow = cleartext.length
		? {
				group,
				id: "cleartext",
				title: "cleartext auth",
				status: "warn",
				detail: `${cleartext.join(", ")} use http:// with credentials configured${queryWithheld.length ? ` (query string on ${queryWithheld.join(", ")} withheld)` : ""}`,
				hint: `Switch the baseUrl to https://, or use a host on localhost. ${
					queryWithheld.length
						? "Endpoints carrying a query string were left unprobed; the rest were probed without the credential, so a 401 there is not a broken endpoint."
						: "The probe was sent without the credential, which is also why a 401 here is not a broken endpoint."
				}`,
			}
		: null;

	// A baseUrl that cannot be parsed is a config fault, not a network one, so it
	// is named here as well. Offline mode used to report only the endpoints it did
	// not probe, which left `localhost:11434/v1` — the routine hand-paste — with
	// no finding at all on a machine that runs with --offline.
	const notUrl = planned.filter((item) => item.invalid !== undefined).map((item) => `${item.name}: baseUrl is not a URL`);
	const shapeNotes = [...shape, ...notUrl];

	// Built once so offline mode can emit it too: whether a baseUrl is even a
	// string is a property of the config, not of the probe.
	// Named, not silently dropped: a provider with a credential but no `baseUrl`
	// is not an endpoint to probe, and Pi may have a built-in default for it — but
	// saying only "1 endpoint(s) reachable" left the reader unable to tell whether
	// the other four providers were fine or were never looked at.
	const noBaseUrlNote = noBaseUrl.length ? `; ${noBaseUrl.length} provider(s) declare no baseUrl and were not probed: ${truncateList(noBaseUrl, 4)}` : "";

	const shapeRow = shapeNotes.length
		? {
				group,
				id: "baseUrl-shape",
				title: "baseUrl shape",
				status: "warn",
				detail: `${shapeNotes.join("; ")} — not probed`,
				hint: "baseUrl has to be an absolute http(s) URL as a quoted string, like \"https://api.example.com/v1\"."
					+ " An environment reference there is not expanded: Pi interpolates only apiKey and header values.",
			}
		: null;

	if (offline) {
		const rows = [
			{
				group,
				id: "providers",
				title: "providers",
				status: "skip",
				detail: shapeNotes.length
					? `offline mode — ${planned.length} endpoint(s) not probed; ${shapeNotes.join("; ")}`
					: `offline mode — ${planned.length} configured endpoint(s) not probed${noBaseUrlNote}`,
				hint: "Re-run without --offline to test reachability.",
			},
			// Emitted as a skip rather than omitted: a row that vanishes in offline
			// mode makes the check count and the summary change between two runs of
			// the same tool, which is exactly the kind of drift a health report
			// should not have.
			{ group, id: "dns", title: "dns", status: "skip", detail: "offline mode — no host resolved" },
		];
		if (cleartextRow) rows.push(cleartextRow);
		if (shapeRow) rows.push(shapeRow);
		return rows;
	}

	const hosts = new Map();
	const probes = [];
	for (const item of planned) {
		// Drop the name: the hint already prefixes every sentence with the provider,
		// so re-echoing the detail's own prefix printed "openai: openai: invalid…".
		const outcome = (status, detail) => ({ name: item.name, status, detail: detail.replace(`${item.name}: `, "") });
		if (item.invalid !== undefined) {
			probes.push(Promise.resolve(outcome("fail", `${item.name}: invalid baseUrl ${item.invalid}`)));
			continue;
		}
		const { name, url, key, userinfo, userinfoError, withheld } = item;
		const host = bareHost(url.hostname);
		hosts.set(host, name);
		if (withheld) {
			probes.push(
				Promise.resolve({
					name,
					status: "skip",
					detail: `${name}: not probed — a query string would have crossed the network in the clear`,
				}),
			);
			continue;
		}
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
	// The denominator is the endpoints the probe actually judged. Probes that were
	// withheld (a query string that would cross the network in the clear, a missing
	// curl, a request that could not be built) appear in the detail as unprobed —
	// counting them as judged said "1 of 3 unhealthy" where only two were asked.
	const probed = outcomes.length - unprobed.length;
	if (!outcomes.length) {
		results.push({
			group,
			id: "providers",
			title: "providers",
			status: "skip",
			detail: shapeNotes.length
				? `no provider with a usable baseUrl — ${shapeNotes.join("; ")}`
				: noBaseUrl.length
					? `no provider with a baseUrl in models.json (${truncateList(noBaseUrl, 4)} declare${noBaseUrl.length === 1 ? "s" : ""} none)`
					: "no provider with a baseUrl in models.json",
		});
	} else if (!unhealthy.length && unprobed.length) {
		// Nothing was sent, so there is nothing to call healthy — but when some
		// endpoints did answer, saying only "skipped" hid the ones that were proven.
		const answered = outcomes.length - unprobed.length;
		results.push({
			group,
			id: "providers",
			title: "providers",
			status: "skip",
			detail: `${answered ? `${answered} endpoint(s) reachable; ` : ""}${unprobed.map((o) => o.detail).join("; ")}`,
		});
		} else if (!unhealthy.length) {
		results.push({
			group,
			id: "providers",
			title: "providers",
			status: "ok",
			detail: `${probed} endpoint(s) reachable${noBaseUrlNote}`,
		});
	} else {
		results.push({
			group,
			id: "providers",
			title: "providers",
			status: unhealthy.some((o) => o.status === "fail") ? "fail" : "warn",
			detail: `${unhealthy.length} of ${probed} unhealthy: ${truncateList(unhealthy.map((o) => o.name), 6)}${noBaseUrlNote}`,
			// An outcome that knows why it failed brings its own advice; the generic
			// sentence is only for the ones that do not (a refused connection, a
			// timeout) and for the ones that sit next to them.
			hint: [
				`${unhealthy.map((o) => `${o.name}: ${o.detail}`).join("; ")}.`,
				// Each hint is attributed. Unattributed, two endpoints failing for
				// different reasons produced one paragraph whose sentences contradicted
				// each other — "the request was cut off locally" followed by "the
				// hostname does not resolve" — with nothing saying which was which.
				...new Set(unhealthy.filter((o) => o.hint).map((o) => `${o.name}: ${o.hint}`)),
				unhealthy.some((o) => !o.hint) ? "Check the baseUrl, whether the server is running, and whether a proxy is required." : "",
			]
				.filter(Boolean)
				.join(" "),
		});
	}

	if (cleartextRow) results.push(cleartextRow);
	if (shapeRow) results.push(shapeRow);

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
					return {
						host,
						provider,
						status: res.timedOut ? "warn" : "fail",
						detail: res.timedOut
							? `${host} resolution timed out (${res.error}) — not proven broken`
							: `${host} does not resolve — ${res.error}`,
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
			// The in-session command has no --offline flag — naming a flag the reader
			// cannot pass made the hint a dead end exactly when Pi would not boot.
			hint: hasRuntime
				? "Fix DNS or use a proxy. To skip every network check, run `npx pi-checkup --offline` outside the session. A hosts-file override is usually the fastest repair."
				: "Fix DNS or use a proxy, or pass --offline to skip every network check. A hosts-file override is usually the fastest repair.",
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
 * curl's own stderr, with the proxy it failed on replaced by its redacted form.
 *
 * curl quotes the configured proxy verbatim in `Could not resolve proxy: …`, so
 * a proxy value that is nothing but a token reached the report through this
 * path even though the row itself printed `(configured)`.
 */
function scrubCurlError(text, proxy) {
	const scrubbed = scrubCredentials(String(text ?? ""));
	if (!proxy) return scrubbed;
	return scrubbed.split(String(proxy)).join(redactProxy(proxy));
}

/**
 * Probe one endpoint, through the proxy when one is configured.
 *
 * Node's global fetch ignores `https_proxy` and friends, so a user behind a
 * corporate proxy saw "unreachable" for endpoints that work in their browser —
 * a false finding in a tool whose only job is to avoid them. curl honours the
 * proxy natively; it is already a dependency of the opt-in forwarding test.
 */
async function probeEndpoint(url, { headers, proxy }) {
	// A header value with a newline or a character outside Latin-1 is not an HTTP
	// header value. fetch refuses to build the request; curl would silently send a
	// different key (line breaks stripped) and a 401 from that request says nothing
	// about the configured one. Neither path is allowed to make the attempt, and
	// neither message may quote the value.
	const badHeader = Object.values(headers ?? {}).some(
		(value) => value !== undefined && value !== null && /[\r\n]|[^\u0000-\u00ff]/.test(String(value)),
	);
	if (badHeader) {
		// A warning, not a skip: this is a fault in the config, not a probe that
		// could not run. Nothing was sent, so the endpoint is still unjudged — the
		// row must say that in the same breath, or it reads as "the server is down".
		return {
			status: "warn",
			detail: "not probed: a configured header value cannot be sent as an HTTP header (a newline or a non-Latin-1 character)",
			hint: "Fix the apiKey or headers for this provider in models.json — the value is rejected before the request leaves the machine.",
		};
	}
	if (!proxy) {
		const res = await timedFetch(url.toString(), { headers });
		// A request Node refuses to construct never opens a socket. `describeNetError`
		// already classifies that as `kind: "request"` without quoting the value —
		// undici's own message embeds it, and the value here is the apiKey.
		if (res.kind === "request") {
			return { status: "skip", detail: "not probed: the request could not be built — a header value or baseUrl the fetch API rejects" };
		}
		// 401/403 means the endpoint is up and merely disagrees about auth, which
		// is a configuration problem, not a reachability problem.
		const alive = res.ok && (res.status === 200 || res.status === 401 || res.status === 403);
		// A refused connection, a rejected certificate, an HTTP 5xx: the endpoint was
		// asked and answered with something other than life. That is the finding this
		// check exists to report, and reporting it as a warning exited 0 — CI and
		// `npx pi-checkup && start-pi` sailed past the one row that said unhealthy.
		// Only a local timeout stays a warning: the deadline is this process's, and
		// the detail already refuses to call the endpoint unreachable. A response
		// status — 503 and 404 included — is a definitive answer from the endpoint,
		// so the comment above and the status have to agree.
		const failed = !alive && !res.aborted;
		return { status: alive ? "ok" : failed ? "fail" : "warn", detail: describeProbe(url, res, alive), hint: probeHint(res) };
	}
	const res = await curlProbe(url.toString(), { proxy, headers });
	if (res.setupFailed) {
		// The probe never left the machine; blaming the endpoint would be a finding
		// this check did not establish.
		return { status: "skip", detail: `not probed: ${scrubCurlError(res.error, proxy)}` };
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
			// A config problem either way (the proxy path is the one Pi's own requests
			// do not take), and the detail says so — not a confirmed-dead endpoint.
			status: "warn",
			detail: `${redactUrl(url.toString())} answered HTTP ${direct.status} directly but not ${through} (${scrubCurlError(res.error, proxy) || `HTTP ${code}`}) — Pi's own requests ignore https_proxy`,
		};
	}
	// Both paths failed. curl got a definitive answer (a refused connection, a
	// rejected certificate, an HTTP error status) — the endpoint did not answer,
	// which is the finding this check exists to report.
	const failed = Boolean(res.code) || !/no response/.test(String(res.error ?? ""));
	return {
		status: failed ? "fail" : "warn",
		detail: `${redactUrl(url.toString())} did not answer ${through}${code ? ` (HTTP ${code})` : ""}; ${scrubCurlError(res.error, proxy) || "no response"}${direct.status ? ` — and HTTP ${direct.status} directly` : ""}`,
	};
}

function describeProbe(url, res, alive) {
	// `url.origin` never carries userinfo, and `res.error` is prose from
	// `describeNetError`, so neither can quote a credential or an errno.
	if (alive) return `${url.origin} reachable (HTTP ${res.status})`;
	if (res.status) return `${url.origin} answered HTTP ${res.status}`;
	// A local timeout is this process giving up. Saying "unreachable" asserted a
	// fact about the endpoint that an 8s deadline did not establish, and the same
	// file already refuses to make that claim on the DNS path.
	if (res.aborted) {
		// The deadline is already named by `error`; repeating it in parentheses made
		// the line read "did not answer in time (no answer within 8s)".
		return `${url.origin} did not answer within ${Math.round((res.timeoutMs ?? 8000) / 1000)}s — not proven unreachable`;
	}
	return `${url.origin} unreachable (${res.error})`;
}

/** Advice that matches the failure, rather than one sentence for all of them. */
function probeHint(res) {
	if (res.aborted) return "The request was cut off locally, which says nothing about the endpoint. Re-run, or raise the timeout on a slow link.";
	if (res.kind === "ENOTFOUND" || res.kind === "EAI_AGAIN" || res.kind === "EAI_NODATA") {
		return "The hostname does not resolve. Check the spelling of baseUrl, or the proxy or DNS settings of this machine.";
	}
	if (res.kind === "ECONNREFUSED") return "Nothing is listening on that host and port. Check that the server is running, and whether baseUrl has the right port.";
	if (/^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL)/.test(String(res.kind))) {
		return "The TLS certificate was rejected. A corporate proxy that terminates TLS needs its CA added to Node's trust store.";
	}
	return "Check the baseUrl, whether the server is running, and whether a proxy is required.";
}
