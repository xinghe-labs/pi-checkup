// Shared helpers. Everything here is dependency-free and cross-platform
// (Node built-ins only), because a diagnostic tool that fails on the machine
// it is diagnosing is worse than useless.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

export const TIMEOUT_MS = 8000;

/**
 * The version of this package, read from its own manifest.
 *
 * A corrupt or partial install must still produce a report, so a manifest that
 * does not parse degrades to "unknown" instead of an unhandled SyntaxError.
 */
export function packageVersion() {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		return JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
}
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
	// Windows exposes the same variable as `Path` when the environment block came
	// from a case-preserving source (a spread copy of process.env, a child process
	// launched by a shell). Reading only `PATH` there found zero commands and the
	// report called every installed binary missing.
	const extVar = windows ? (env.PATHEXT ?? env.Pathext ?? env.pathext ?? DEFAULT_PATHEXT) : "";
	const exts = windows ? extVar.split(";").filter(Boolean) : [""];
	const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
	const dirs = pathVar.split(path.delimiter).filter(Boolean);
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
 * A filesystem error in words a user can act on.
 *
 * Node's messages carry an errno, the syscall and the absolute path —
 * `EISDIR: illegal operation on a directory, read` — which is the least polished
 * text in the whole report, and it lands in the row that is supposed to explain
 * what to do next.
 */
export function describeFsError(e) {
	const code = e?.code;
	if (code === "EACCES" || code === "EPERM") return "permission denied";
	if (code === "EISDIR") return "it is a directory, not a file";
	if (code === "ELOOP") return "too many symbolic links";
	if (code === "EMFILE" || code === "ENFILE") return "too many open files";
	if (code === "ENOENT" || code === "ENOTDIR") return "not found";
	if (code === "ENOSPC") return "no space left on the device";
	if (code === "EIO") return "the device reported an I/O error";
	return code ? `could not be read (${code})` : String(e?.message ?? e);
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
		return { ok: false, missing: e?.code === "ENOENT", error: describeFsError(e) };
	}
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		return { ok: false, missing: e?.code === "ENOENT", error: describeFsError(e) };
	}
	try {
		return { ok: true, data: JSON.parse(raw) };
	} catch (e) {
		// `invalid` marks a genuine parse failure, which is a different problem from
		// a file that is missing or too large to read.
		//
		// V8 quotes a window of the input in some of its messages — `Unexpected
		// token 's', ..."\"apiKey\": sk-live-d}" is not valid JSON` — and this file
		// is often models.json, the one that holds keys. Only the position is
		// carried through; the message itself never reaches a report.
		const pos = /at position (\d+)/.exec(String(e?.message ?? ""));
		return { ok: false, invalid: true, error: pos ? `not valid JSON (position ${pos[1]})` : "not valid JSON" };
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
	// A registry entry is a third-party object: `sourceInfo.path` can be a number
	// or an object, and calling `.startsWith` on it took the whole Registry group
	// down as one crash row.
	if (typeof sourcePath !== "string" || !sourcePath) return "unknown";
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
	const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
	// `/x/node_modules/` has nothing after the marker; returning "" rendered the
	// attribution row as " (3)" — a count with no owner.
	return name || "unknown";
}

/**
 * A list, cut to `max` items with a count of what was left out.
 *
 * Every row that prints a list had its own version of this, and three of them
 * simply stopped — a reader could not tell a complete list from a truncated one.
 */
export function truncateList(list, max, separator = ", ") {
	const items = Array.from(list ?? []);
	if (items.length <= max) return items.join(separator);
	return `${items.slice(0, max).join(separator)}${separator}... ${items.length - max} more`;
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
	if (s.startsWith("npm:")) {
		// `npm:name@1.2.3`, `npm:@scope/name@^2` and `npm:name@latest` all install
		// into the same directory: the version is a request, not part of the path.
		// Taking the spec literally made every pinned package read as missing from
		// node_modules — a `fail` that then offered to delete the entry.
		const body = s.slice(4);
		const at = body.indexOf("@", body.startsWith("@") ? 1 : 0);
		return path.join(root, "npm", "node_modules", at === -1 ? body : body.slice(0, at));
	}
	if (s.startsWith("./") || s.startsWith("../") || path.isAbsolute(s)) return path.resolve(root, s);
	// git:, https:, and bare names are resolved by Pi itself; static probing
	// cannot follow them reliably, so callers treat null as "not inspectable".
	return null;
}

/**
 * The exact version an `npm:` spec pins, or null.
 *
 * Only an exact pin is comparable: `^2` or `latest` is a request the installer
 * is free to satisfy with whatever is newest, and calling that a mismatch would
 * be a warning nobody can clear.
 */
export function pinnedVersion(spec) {
	const s = sourceOf(spec);
	if (!s || !s.startsWith("npm:")) return null;
	const m = /@=?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(s.slice(4));
	return m ? m[1] : null;
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
	// A manifest may declare an absolute entry, or one that climbs out of the
	// package with `..`. `path.join(dir, "/abs/file.js")` silently re-roots the
	// pattern under `dir`, so a file that resolves fine at load time was reported
	// as a missing entry — a `fail` with a reinstall hint.
	const base = path.isAbsolute(pattern) ? path.parse(pattern).root : dir;
	if (!pattern.includes("*")) return exists(path.join(base, pattern));
	let cur = base;
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
		// `fetch failed` is the whole message for every network fault; the reason is
		// on `cause` (ECONNREFUSED, a header Node refuses to build, a timeout). A
		// report that says only "fetch failed" leaves the user with nothing.
		const cause = e?.cause?.message ?? e?.cause?.code ?? "";
		const message = String(e?.message ?? e);
		return { ok: false, status: 0, error: cause ? `${message} — ${String(cause)}` : message };
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
 * The proxy URL and every header go in a config file created with mode 0600 —
 * a no-op on Windows, where the per-user temp directory ACL is what protects it
 * — and never in argv: `-x`/`-H` on the command line are readable by every other
 * user on the box through `ps` and /proc, and both routinely carry a credential.
 */
export function curlConfig({ url, proxy, headers = {} }) {
	// curl config syntax: quoted values, backslash escapes. Line breaks are
	// stripped first: a newline in the value would end the directive and let the
	// rest of the string start a new one.
	const quote = (value) =>
		String(value)
			.replace(/[\r\n]/g, "")
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"');
	const lines = [];
	// The URL goes in the config file too: it can carry a query string, and argv
	// is world-readable through `ps`. curl accepts `url = "…"`.
	lines.push(`url = "${quote(url)}"`);
	if (proxy) lines.push(`proxy = "${quote(proxy)}"`);
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || value === null) continue;
		lines.push(`header = "${quote(`${name}: ${value}`)}"`);
	}
	return `${lines.join("\n")}\n`;
}

/** curl's argv for one probe. Exported so a test can prove what is not in it. */
export function curlArgs(configFile, maxTime = 6) {
	return [
		// -q has to be first: it stops curl reading a ~/.curlrc that could inject
		// options — including a different proxy than the one being tested.
		"-q",
		// -sS: quiet progress, but still print the failure reason to stderr.
		"-sS",
		"-o",
		isWindows ? "NUL" : "/dev/null",
		"-w",
		"%{http_code}",
		"--max-time",
		String(maxTime),
		// An empty value disables NO_PROXY for this request. The check exists to
		// answer "does this proxy work", and a NO_PROXY entry in the environment
		// would send the probe around it while the row still said "through <proxy>".
		"--noproxy",
		"",
		"--config",
		configFile,
	];
}

export async function curlProbe(url, { proxy, headers = {}, maxTime = 6, timeout = 8000 } = {}) {
	let dir;
	try {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-checkup-"));
		const configFile = path.join(dir, "curl.conf");
		fs.writeFileSync(configFile, curlConfig({ url, proxy, headers }), { mode: 0o600 });
		const res = await sh("curl", curlArgs(configFile, maxTime), timeout);
		// curl prints 000 for a refused or timed-out connection and exits 7 or 28.
		// Reading only `ok` turned a dead proxy into "skipped, tool unavailable".
		return { missing: res.missing === true, code: (res.out ?? "").trim(), error: res.ok ? "" : String(res.err ?? "").trim() };
	} catch (e) {
		// The request never left the machine. Consumers check this first, so a
		// failure to create the config file is reported as "could not be set up"
		// rather than as an endpoint that did not answer.
		return { setupFailed: true, missing: false, code: "", error: String(e?.message ?? e) };
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
 * Whether a bare string is a host at all, rather than a token that happens to
 * contain dots.
 *
 * A pasted JWT — `eyJhbGciOiJIUzI1NiJ9.eyJzdWIi…` — passes the character-class
 * test above: base64url is letters, digits, `-` and `_`, and the dots separate
 * segments exactly like a hostname separates labels. Only the shape tells them
 * apart: no DNS label is 25 characters long, and every token payload segment is.
 */
function looksLikeHost(value) {
	// IPv6 literal, with or without a port.
	if (/^\[[0-9a-f:.]+\](:\d+)?(\/|$)/i.test(value)) return true;
	const hostPart = value.split(/[\/:]/)[0];
	const labels = hostPart.split(".").filter(Boolean);
	if (!labels.length) return false;
	if (labels.some((label) => label.length > 24)) return false;
	const last = labels[labels.length - 1];
	// A real host ends in a TLD-shaped label of at least two characters, or in an
	// address octet. The length floor is what keeps `a.b.c` — or a truncated JWT —
	// from being reprinted as if it were a hostname.
	return /^[a-z][a-z0-9-]+$/i.test(last) || /^\d{1,3}$/.test(last);
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
		// echoing the raw paste back at the user — and only echo what is shaped
		// like a host at all. `sk-ant-api03-…` pasted into baseUrl by mistake has
		// no "." "/" or ":" in it, so the whole string was a secret the report
		// reprinted into the terminal and the JSON.
		const bare = scrubCredentials(text).split(/[?#]/)[0];
		// The bracketed alternative is an IPv6 literal: its colons are part of the
		// address, so the plain host character class cannot express it.
		const hostShaped =
			/[./:]/.test(bare) &&
			/^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d+)?(\/[\w.\-/]*)?$/i.test(bare) &&
			looksLikeHost(bare);
		return hostShaped ? bare : "(unparsable value)";
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
	const at = text.lastIndexOf("@");
	if (at !== -1) return text.slice(at + 1).replace(/^[a-z0-9+.-]+:\/\//i, "") || "(configured)";

	// No "@" at all: `alice:s3cr3t` and `http://alice:s3cr3t` are a user and a
	// password with no host, which the URL parser rejects. The shape itself is
	// the credential, so nothing of it can be shown. A bare `host:port` is safe.
	if (/^[a-z0-9._\-[\]]+:\d+$/i.test(text)) return text;
	// No "@" and no colon: a bare word cannot be a user and a password, so it is
	// safe to echo and useful to see.
	if (!text.includes(":")) return text;
	return "(configured)";
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
	if (text.includes("://")) return scrubCredentials(text);
	// `git@github.com:me/x` is a git source in scp form: one "@", no password, and
	// hiding it made a legitimate entry unreadable.
	if (/^[a-z0-9._-]+@[a-z0-9._-]+:[^\s@]*$/i.test(text)) return scrubCredentials(text);
	// `npm:pkg`, `git:…`, `file:./x`: a scheme is what makes a string a source.
	// Only the schemes Pi understands, though — `alice:s3cr3t` also starts with
	// `word:`, and treating it as a scheme printed a username and password as if
	// they were a package name.
	if (/^(npm|git|file|https?|ssh|link):/i.test(text)) return scrubCredentials(text);
	// No scheme, but a path: `./ext/single.js` and `/opt/ext` are local sources
	// with no credential in them, and hiding them made a real finding unreadable.
	// Globs and scoped paths are sources too: `dist/*.js` and `./packages/@acme/ext`
	// are what a manifest declares, and hiding them made an "entry files" finding
	// unreadable. `@` is allowed only as a whole-segment prefix, so a
	// `user:pass@host` (which has a colon) and a `user@host` stay out.
	const segment = "@?[a-z0-9._*+!-]+";
	const pathLike = new RegExp(`^(${segment})(\\/(${segment}))+$`, "i").test(text) || /^(\.{0,2}\/|\/|~\/)/.test(text);
	if (pathLike) return scrubCredentials(text);
	// Anything else is not a source. It may be a credential pasted into the wrong
	// field — `sk-ant-…` in the packages array — and scrubCredentials only knows
	// how to hide userinfo and query strings, so the value used to reach the
	// report, the TUI notification and `--json` verbatim. `redactUrl` already
	// keeps a host-shaped value and hides everything else.
	return redactUrl(text);
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
			// Userinfo without the slashes. `alice:pw@host:22` and `alice:pw@host/x`
			// are the shapes a hand-pasted DSN has, and the rule above only matches
			// the `//` form — so `user:pass@host` reached the report verbatim.
			// A single `user@host` has no colon before the "@" and is left alone: it
			// is a username, not a credential.
			// The user part may not be a scheme: `npm:pi-lens@0.9.1` is a package
			// spec, and masking it produced "***@0.9.1" in the version-pin row.
			// A ":" or "/" before the user part is allowed, so the second colon in
			// `npm:alice:pw@host` and the single slash in `https:/alice:pw@host`
			// still start a match.
			.replace(/(^|[\s"'=(,:/])(?!(?:npm|git|file|https?|ssh|link):)([^\s/@:'"]+):([^\s/@]*?)@/g, "$1***@")
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
