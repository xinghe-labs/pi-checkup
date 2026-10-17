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

/** Root of the Pi agent directory (holds settings.json, models.json, npm/, bin/). */
export function agentDir() {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
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
export function whichAll(name) {
	const exts = isWindows ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const hits = [];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = path.join(dir, name + ext);
			if (!exists(candidate)) continue;
			// `which` only reports executables on POSIX; matching that keeps the
			// shadow and unreachable findings honest.
			if (!isWindows) {
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
		return { ok: true, data: JSON.parse(raw), raw };
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
