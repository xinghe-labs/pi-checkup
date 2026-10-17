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
			out: typeof e?.stdout === "string" ? e.stdout : "",
			err: typeof e?.stderr === "string" ? e.stderr : String(e?.message ?? e),
		};
	}
}

/** All PATH hits for a command name, best match first. Cross-platform. */
export async function whichAll(name) {
	const r = await sh(isWindows ? "where" : "which", isWindows ? [name] : ["-a", name], 5000);
	if (!r.ok) return [];
	return r.out
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Read a JSON file. Returns a discriminated result instead of throwing so that
 * callers can report "this file is broken" as a finding rather than a crash.
 */
export function readJson(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		return { ok: false, missing: e?.code === "ENOENT", error: String(e?.message ?? e) };
	}
	try {
		return { ok: true, data: JSON.parse(raw), raw };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e).slice(0, 160) };
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

/** Copy a file next to itself with a timestamp, returning the new path. */
export function backupFile(file) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const dst = `${file}.checkup-bak-${stamp}`;
	fs.copyFileSync(file, dst);
	return dst;
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

/** Map a settings `packages` entry to the directory Pi installed it into. */
export function resolvePackageDir(spec, root = agentDir()) {
	const s = typeof spec === "string" ? spec : spec?.source;
	if (typeof s !== "string") return null;
	if (s.startsWith("npm:")) return path.join(root, "npm", "node_modules", s.slice(4));
	if (s.startsWith("./") || s.startsWith("../") || path.isAbsolute(s)) return path.resolve(root, s);
	// git:, https:, and bare names are resolved by Pi itself; static probing
	// cannot follow them reliably, so callers treat null as "not inspectable".
	return null;
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
		const rx = new RegExp("^" + seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
		let entries;
		try {
			entries = fs.readdirSync(cur);
		} catch {
			return false;
		}
		const hit = entries.find((e) => rx.test(e));
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
		return { ok: true, status: res.status };
	} catch (e) {
		return { ok: false, status: 0, error: String(e?.message ?? e) };
	} finally {
		clearTimeout(timer);
	}
}

/** Resolve a hostname to addresses. Never throws. */
export async function resolveHost(host) {
	try {
		const addrs = await dns.lookup(host, { all: true });
		return { ok: true, addresses: addrs.map((a) => a.address) };
	} catch (e) {
		return { ok: false, error: String(e?.code ?? e?.message ?? e) };
	}
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
