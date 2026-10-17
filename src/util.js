// Shared helpers. Everything here is dependency-free and cross-platform
// (Node built-ins only), because a diagnostic tool that fails on the machine
// it is diagnosing is worse than useless.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const TIMEOUT_MS = 8000;
export const isWindows = process.platform === "win32";

// Windows and the default macOS filesystem are case-insensitive, so two paths
// that differ only in case are the same file there.
const CASE_INSENSITIVE = isWindows || process.platform === "darwin";

// Config files are small. A cap turns "read whatever this path points at" into
// a bounded read when the path came out of a settings file.
const MAX_JSON_BYTES = 4 << 20;

const SHIM_EXT = /\.(com|exe|bat|cmd|ps1)$/i;

/**
 * Are two paths the same command?
 *
 * On Windows a package bin is linked as `foo`, `foo.cmd` and `foo.ps1`, and PATH
 * resolution appends PATHEXT, so the hit is `foo.CMD` while the link is `foo`.
 * Comparing the raw strings reported every correctly linked package command as
 * shadowed. The directory still has to match: a `foo.cmd` in some other
 * directory really is a different program.
 */
export function sameCommand(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	const stem = (p) => path.basename(p).replace(SHIM_EXT, "").toLowerCase();
	return normalizePath(path.dirname(a)) === normalizePath(path.dirname(b)) && stem(a) === stem(b);
}

/** Root of the Pi agent directory (holds settings.json, models.json, npm/, bin/). */
export function agentDir() {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/**
 * One finding row. Every module builds rows the same shape, and four of them used
 * to carry their own copy of this one-liner.
 */
export function makeRow(group) {
	return (id, title, status, detail, extra = {}) => ({ group, id, title, status, detail, ...extra });
}

/** Run a command without blocking the event loop. Never throws. */
export async function sh(cmd, args, timeout = TIMEOUT_MS) {
	try {
		const { stdout, stderr } = await exec(cmd, args, {
			timeout,
			encoding: "utf8",
			maxBuffer: 4 << 20,
			windowsHide: true,
		});
		return { ok: true, out: stdout, err: stderr };
	} catch (e) {
		return {
			ok: false,
			// ENOENT means the binary is not installed, which is a different answer
			// from "the command ran and failed". Callers that must tell the two
			// apart need this; without it a dead proxy looked like a missing curl.
			missing: e?.code === "ENOENT",
			code: typeof e?.code === "number" ? e.code : null,
			out: typeof e?.stdout === "string" ? e.stdout : "",
			err: typeof e?.stderr === "string" ? e.stderr : String(e?.message ?? e),
		};
	}
}

/**
 * Every PATH hit for a command name, best match first.
 *
 * Resolved in-process rather than by spawning `which`/`where`: that removes one
 * subprocess per binary inspected (a package with a dozen commands was costing a
 * dozen spawns), and it still answers on images that ship no `which` at all.
 */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function whichAll(name, env = process.env, { windows = isWindows } = {}) {
	const exts = windows ? (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean) : [""];
	const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const hits = [];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = path.join(dir, name + ext);
			if (!exists(candidate)) continue;
			// `which` only reports executables on POSIX; matching that keeps the
			// shadow and unreachable findings honest.
			if (!windows) {
				try {
					fs.accessSync(candidate, fs.constants.X_OK);
				} catch {
					continue;
				}
			}
			hits.push(candidate);
		}
	}
	return hits;
}

/**
 * Read a JSON file. Returns a discriminated result instead of throwing so that
 * callers can report "this file is broken" as a finding rather than a crash.
 */
export function readJson(file) {
	try {
		const size = fs.statSync(file).size;
		if (size > MAX_JSON_BYTES) {
			return { ok: false, error: `${humanBytes(size)} is too large to inspect` };
		}
	} catch (e) {
		return { ok: false, missing: e?.code === "ENOENT", error: String(e?.message ?? e) };
	}
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		return { ok: false, missing: e?.code === "ENOENT", error: String(e?.message ?? e) };
	}
	try {
		return { ok: true, data: JSON.parse(raw) };
	} catch (e) {
		// `invalid` marks a genuine parse failure, which is a different problem from
		// a file that is missing or too large to read.
		return { ok: false, invalid: true, error: String(e?.message ?? e).slice(0, 160) };
	}
}

export function exists(p) {
	try {
		fs.accessSync(p);
		return true;
	} catch {
		return false;
	}
}

/** True only when the path is genuinely not there, not when it is unreadable. */
export function isMissing(p) {
	try {
		fs.statSync(p);
		return false;
	} catch (e) {
		// EACCES/EPERM/ELOOP/EMFILE mean the path may well be fine and this process
		// just cannot look at it. Treating those as "missing" is how a permission
		// problem turns into a deleted settings entry.
		return e?.code === "ENOENT" || e?.code === "ENOTDIR";
	}
}

/**
 * Canonical form of a path for comparisons: symlinks resolved, separators
 * unified, case-folded where the filesystem is case-insensitive.
 *
 * Resolving symlinks matters in practice: with pnpm, a package's directory is a
 * link into a global store, so the path Pi reports for a loaded tool and the
 * path resolved from settings are different strings for the same package.
 */
export function normalizePath(p) {
	if (typeof p !== "string" || !p) return "";
	let absolute;
	try {
		absolute = fs.realpathSync.native(p);
	} catch {
		absolute = path.resolve(p);
	}
	const slashed = absolute.replace(/\\/g, "/");
	return CASE_INSENSITIVE ? slashed.toLowerCase() : slashed;
}

/**
 * Newest sibling backup of a file, matching either the `.checkup-bak-*` naming
 * this package uses or the common `file.json.bak` convention other tools use.
 *
 * Ordered by mtime, not by name: a plain `.bak` written a minute ago is more
 * useful to restore than a `.checkup-bak-2026-01-01` from last year, and the
 * two naming schemes do not sort chronologically against each other.
 */
export function newestBackup(file) {
	const dir = path.dirname(file);
	const base = path.basename(file);
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return null;
	}
	let best = null;
	let bestTime = Number.NEGATIVE_INFINITY;
	for (const entry of entries) {
		if (entry === base || !entry.startsWith(base)) continue;
		if (!/(\.bak|\.checkup-bak)(-|$)/.test(entry.slice(base.length))) continue;
		const full = path.join(dir, entry);
		let mtimeMs;
		try {
			mtimeMs = fs.statSync(full).mtimeMs;
		} catch {
			continue; // dangling symlink or raced deletion
		}
		// A bulk copy can give several backups the same mtime; break the tie on
		// the name so repeated runs always pick the same file.
		if (mtimeMs > bestTime || (mtimeMs === bestTime && best !== null && full > best)) {
			best = full;
			bestTime = mtimeMs;
		}
	}
	return best;
}

/**
 * Attribute a source path to the package that owns it, so findings can say
 * "pi-lens did this" instead of dumping an absolute path at the user.
 */
export function ownerOf(sourcePath) {
	if (!sourcePath) return "unknown";
	if (sourcePath.startsWith("builtin:")) return "builtin";
	const normalized = sourcePath.replace(/\\/g, "/");
	const marker = "/node_modules/";
	const i = normalized.lastIndexOf(marker);
	if (i === -1) {
		// User-level or project-level extension file, not from a package.
		const parts = normalized.split("/");
		const parent = parts.at(-2) ?? "";
		return parent === "extensions" ? `local:${parts.at(-1)}` : `local:${parent}`;
	}
	const rest = normalized.slice(i + marker.length).split("/");
	return rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
}

/** Read the `source` out of a settings `packages` entry, whatever shape it has. */
export function sourceOf(spec) {
	if (typeof spec === "string") return spec;
	const source = spec?.source;
	return typeof source === "string" ? source : null;
}

/** Map a settings `packages` entry to the directory Pi installed it into. */
export function resolvePackageDir(spec, root = agentDir()) {
	const s = sourceOf(spec);
	if (!s) return null;
	if (s.startsWith("npm:")) return path.join(root, "npm", "node_modules", s.slice(4));
	if (s.startsWith("./") || s.startsWith("../") || path.isAbsolute(s)) return path.resolve(root, s);
	// git:, https:, and bare names are resolved by Pi itself; static probing
	// cannot follow them reliably, so callers treat null as "not inspectable".
	return null;
}

/**
 * Match one path segment against a `*`-glob.
 *
 * Hand-rolled instead of compiled to a RegExp: a manifest glob like
 * `*a*a*a*a*a*a*a*a*b` becomes `^.*a.*a…b$`, which backtracks catastrophically
 * on a long name. Splitting on `*` and scanning with indexOf stays linear.
 */
function segmentMatches(pattern, name) {
	const parts = pattern.split("*");
	if (parts.length === 1) return pattern === name;
	const head = parts[0];
	const tail = parts.at(-1);
	if (!name.startsWith(head)) return false;
	if (name.length - head.length < tail.length || !name.endsWith(tail)) return false;
	let pos = head.length;
	const limit = name.length - tail.length;
	for (const part of parts.slice(1, -1)) {
		const i = name.indexOf(part, pos);
		if (i === -1 || i + part.length > limit) return false;
		pos = i + part.length;
	}
	return true;
}

/** True when a manifest glob matches something on disk. Handles `*` segments only. */
export function globExists(dir, pattern) {
	if (!pattern.includes("*")) return exists(path.join(dir, pattern));
	let cur = dir;
	for (const seg of pattern.replace(/\\/g, "/").split("/")) {
		if (!seg) continue;
		if (!seg.includes("*")) {
			cur = path.join(cur, seg);
			continue;
		}
		let entries;
		try {
			entries = fs.readdirSync(cur);
		} catch {
			return false;
		}
		const hit = entries.find((e) => segmentMatches(seg, e));
		if (!hit) return false;
		cur = path.join(cur, hit);
	}
	return exists(cur);
}

/** fetch() with a hard timeout. Returns {ok, status, error} and never throws. */
export async function timedFetch(url, init = {}, timeout = TIMEOUT_MS) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);
	try {
		const res = await fetch(url, { ...init, signal: controller.signal });
		// We only want the status line. Dropping the body lets undici release the
		// socket instead of parking one connection per probe until keep-alive ends.
		await res.body?.cancel().catch(() => {});
		return { ok: true, status: res.status };
	} catch (e) {
		return { ok: false, status: 0, error: String(e?.message ?? e) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolve a hostname to addresses. Never throws and never outlives `timeout`.
 *
 * `dns.lookup` takes no timeout of its own: it hands off to getaddrinfo on the
 * libuv threadpool, which on a blackholed resolver blocks for tens of seconds.
 * A report that promises a hard timeout cannot leave one check unbounded.
 */
export async function resolveHost(host, timeout = 4000) {
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), timeout);
	});
	const lookup = dns.lookup(host, { all: true }).then(
		(addrs) => ({ ok: true, addresses: addrs.map((a) => a.address) }),
		(e) => ({ ok: false, error: String(e?.code ?? e?.message ?? e) }),
	);
	try {
		return await Promise.race([lookup, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The proxy this process should use, from the environment, or undefined.
 *
 * Read here rather than in one module: the provider probe and the runtime proxy
 * check have to agree on what "a proxy is configured" means, and they used to
 * disagree — Runtime reported one while the probe silently ignored it.
 */
export function proxyFromEnv(env = process.env) {
	for (const key of ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]) {
		const value = env[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/**
 * Make one request through `proxy` with curl, and return the HTTP status code.
 *
 * curl is used instead of fetch because Node's global fetch ignores the proxy
 * environment variables entirely: a user behind a corporate proxy got
 * "unreachable" for endpoints that work fine in their browser. curl honours
 * `proxy` natively, and this package already depends on it for the opt-in
 * forwarding test.
 *
 * The proxy URL and every header go in a 0600 config file, never in argv:
 * `-x`/`-H` on the command line are readable by every other user on the box
 * through `ps` and /proc, and both routinely carry a credential.
 */
export async function curlProbe(url, { proxy, headers = {}, maxTime = 6, timeout = 8000 } = {}) {
	let dir;
	try {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-checkup-"));
		const configFile = path.join(dir, "curl.conf");
		// curl config syntax: quoted values, backslash escapes. Line breaks are
		// stripped first: a newline in the value would end the directive and let
		// the rest of the string start a new one.
		const quote = (value) =>
			String(value)
				.replace(/[\r\n]/g, "")
				.replace(/\\/g, "\\\\")
				.replace(/"/g, '\\"');
		const lines = [];
		if (proxy) lines.push(`proxy = "${quote(proxy)}"`);
		for (const [name, value] of Object.entries(headers)) {
			if (value === undefined || value === null) continue;
			lines.push(`header = "${quote(`${name}: ${value}`)}"`);
		}
		fs.writeFileSync(configFile, `${lines.join("\n")}\n`, { mode: 0o600 });
		const res = await sh(
			"curl",
			// -sS: quiet progress, but still print the failure reason to stderr.
			["-sS", "-o", isWindows ? "NUL" : "/dev/null", "-w", "%{http_code}", "--max-time", String(maxTime), "--config", configFile, url],
			timeout,
		);
		// curl prints 000 for a refused or timed-out connection and exits 7 or 28.
		// Reading only `ok` turned a dead proxy into "skipped, tool unavailable".
		return { missing: res.missing === true, code: (res.out ?? "").trim(), error: res.ok ? "" : String(res.err ?? "").trim() };
	} catch (e) {
		return { missing: false, code: "", error: String(e?.message ?? e) };
	} finally {
		if (dir) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best effort; the file is 0600 and inside the OS temp dir.
			}
		}
	}
}

/** Is this HTTP status one that proves the endpoint answered? */
export function statusIsAlive(code) {
	return code === 200 || code === 401 || code === 403;
}

/**
 * A URL that is safe to put in a report: scheme, host, port and path, with the
 * userinfo and the query string dropped.
 *
 * Both are routine places to paste a credential — a self-hosted gateway with
 * `https://user:pass@host/v1`, or a provider URL copied with `?key=sk-…` still
 * attached — and a report is the one place they must not reappear.
 */
export function redactUrl(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return "(empty)";
	if (!text.includes("://") && !text.startsWith("//")) {
		// Not a URL. Strip anything that looks like a credential anyway rather than
		// echoing the raw paste back at the user.
		return scrubCredentials(text);
	}
	try {
		const url = new URL(text);
		// An empty hostname means the parse produced an opaque path, not an address:
		// `git:https://…` and the routine `localhost:11434/v1` paste both land here.
		// Printing `url.origin` would then print the string "null".
		if (!url.hostname) return scrubCredentials(text);
		const path = url.pathname === "/" ? "" : url.pathname;
		return `${url.protocol}//${url.host}${path}`;
	} catch {
		return scrubCredentials(text);
	}
}

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
				// Only the port the user actually wrote: printing a default :443 next to
				// a URL that has no port makes the report disagree with the config the
				// user is looking at, which is the one thing this string is for.
				return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
			}
		} catch {
			// Fall through to the textual scrub below.
		}
	}

	// Everything before the last "@" is a credential; everything after it is the
	// proxy the user needs to recognise.
	return text.slice(text.lastIndexOf("@") + 1).replace(/^[a-z0-9+.-]+:\/\//i, "") || "(configured)";
}

/**
 * A package source, safe to print.
 *
 * `settings.json` legitimately holds sources that carry a token, because the
 * only way to install a private repo over HTTPS is one in the URL:
 * `git:https://ghp_xxx@github.com/me/private`. That string used to reach the
 * report, the `--json` payload and therefore any CI log verbatim.
 */
export function redactSource(spec) {
	const text = String(spec ?? "");
	const at = text.indexOf("://");
	if (at === -1) return scrubCredentials(text);
	const scheme = text.slice(0, at + 3);
	const rest = text.slice(at + 3);
	return scrubCredentials(`${scheme}${rest}`);
}

/**
 * Scrub credentials out of arbitrary text — an error message that quotes the URL
 * it failed on, for instance. Node's fetch says
 * `Request cannot be constructed from a URL that includes credentials:
 * https://user:pass@host/v1/models`, and that message ends up in the report.
 */
export function scrubCredentials(text) {
	return (
		String(text ?? "")
			// The scheme is optional on purpose: `//user:pass@host/v1` is a
			// protocol-relative paste, it fails `new URL` without a base, and it used
			// to be echoed unchanged by the very branch that exists to hide it.
			.replace(/([a-z][a-z0-9+.-]*:)?\/\/[^/\s@]+@/gi, "$1//***@")
			// A query string is dropped whole rather than masked: it is where a pasted
			// `?key=sk-…` lives, and nothing in a report needs it.
			.replace(/\?[^\s]*/g, "")
	);
}

/**
 * Strip the brackets WHATWG URLs keep on IPv6 literals.
 *
 * `new URL("http://[::1]:11434/v1").hostname` is `"[::1]"`, and both
 * `dns.lookup` and `net.connect` want the bare address. Passing the bracketed
 * form made a loopback provider look remote and unresolvable.
 */
export function bareHost(host) {
	return String(host ?? "").replace(/^\[|\]$/g, "");
}

/** Loopback in any of its spellings, IPv6 literals included. */
export function isLoopbackHost(host) {
	const bare = bareHost(host).toLowerCase();
	return bare === "localhost" || bare === "::1" || bare === "0:0:0:0:0:0:0:1" || /^127\./.test(bare) || bare.endsWith(".localhost");
}

/** Human-readable byte size. */
export function humanBytes(n) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = Number(n);
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
