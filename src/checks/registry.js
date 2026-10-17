// Registry checks — what is actually loaded right now.
//
// These are the checks a shell script cannot do: `pi list` shows which packages
// are installed, but only the running session knows which tools and commands
// they really registered, under what names, and who lost a collision.
import path from "node:path";
import { ownerOf, readJson, resolvePackageDir } from "../util.js";

export const group = "Registry";

function call(fn, fallback) {
	try {
		return fn() ?? fallback;
	} catch {
		return fallback;
	}
}

export async function run({ pi, hasRuntime, settings }) {
	const results = [];

	// Without a running session there is no registry to audit. Say so once rather
	// than emitting five empty checks that look like passes.
	if (!hasRuntime) {
		return [
			{
				group,
				id: "runtime",
				title: "live registry",
				status: "skip",
				detail: "no Pi session — registry checks need a running process",
				hint: "Run /checkup from inside Pi to audit loaded tools and commands.",
			},
		];
	}

	const tools = call(() => pi.getAllTools(), []);
	const commands = call(() => pi.getCommands(), []);
	const servers = call(() => pi.getMcpServers(), []);

	// --- attribution -------------------------------------------------------
	const toolsByOwner = new Map();
	for (const tool of tools) {
		const owner = ownerOf(tool?.sourceInfo?.path);
		if (!toolsByOwner.has(owner)) toolsByOwner.set(owner, []);
		toolsByOwner.get(owner).push(tool.name);
	}
	const commandsByOwner = new Map();
	for (const command of commands) {
		const owner = ownerOf(command?.sourceInfo?.path);
		if (!commandsByOwner.has(owner)) commandsByOwner.set(owner, []);
		commandsByOwner.get(owner).push(command.name);
	}

	const builtinTools = tools.filter((t) => (t?.sourceInfo?.path ?? "").startsWith("builtin:")).length;
	results.push({
		group,
		id: "tools",
		title: "tools",
		status: "ok",
		detail: `${tools.length} registered (${tools.length - builtinTools} extension, ${builtinTools} builtin) across ${toolsByOwner.size} sources`,
	});
	results.push({
		group,
		id: "commands",
		title: "commands",
		status: "ok",
		detail: `${commands.length} registered across ${commandsByOwner.size} sources, ${servers.length} MCP server(s)`,
	});

	// --- collisions --------------------------------------------------------
	// A collision means one extension silently stops being reachable: the later
	// registration wins and the earlier tool or command is gone without an error.
	const duplicateTools = findDuplicates(tools);
	results.push(
		duplicateTools.length
			? {
					group,
					id: "tool-collisions",
					title: "tool collisions",
					status: "fail",
					detail: duplicateTools.map(([name, owners]) => `${name} claimed by ${owners.join(" + ")}`).join("; "),
					hint: "Rename one of them, or disable the package you do not need.",
				}
			: { group, id: "tool-collisions", title: "tool collisions", status: "ok", detail: "none" },
	);

	const duplicateCommands = findDuplicates(commands);
	results.push(
		duplicateCommands.length
			? {
					group,
					id: "command-collisions",
					title: "command collisions",
					status: "fail",
					detail: duplicateCommands.map(([name, owners]) => `/${name} claimed by ${owners.join(" + ")}`).join("; "),
					hint: "Only one handler will run. Rename or remove one of the packages.",
				}
			: { group, id: "command-collisions", title: "command collisions", status: "ok", detail: "none" },
	);

	// --- silent failures ---------------------------------------------------
	// A package that declares extensions but registered nothing is the most
	// common failure mode that produces no error message anywhere.
	const registered = new Set([...toolsByOwner.keys(), ...commandsByOwner.keys()]);
	const declared = declaredPackages(settings);
	const silent = declared.filter((name) => !registered.has(name));
	results.push(
		silent.length
			? {
					group,
					id: "silent",
					title: "silent packages",
					status: "warn",
					detail: `${silent.join(", ")} declared an extension but registered no tool or command`,
					hint: "May be event-only by design, or may have failed to load. Try /reload with --verbose.",
				}
			: { group, id: "silent", title: "silent packages", status: "ok", detail: "none" },
	);

	return results;
}

function findDuplicates(items) {
	const byName = new Map();
	for (const item of items) {
		const name = item?.name;
		if (!name) continue;
		const owner = ownerOf(item?.sourceInfo?.path);
		if (!byName.has(name)) byName.set(name, new Set());
		byName.get(name).add(owner);
	}
	return [...byName].filter(([, owners]) => owners.size > 1).map(([name, owners]) => [name, [...owners]]);
}

/** Packages from settings whose manifests actually declare an extension entry. */
function declaredPackages(settings) {
	const out = [];
	for (const spec of settings?.packages ?? []) {
		const source = typeof spec === "string" ? spec : spec?.source;
		if (typeof source !== "string") continue;
		const dir = resolvePackageDir(source);
		if (!dir) continue;
		const manifest = readJson(path.join(dir, "package.json"));
		if (!manifest.ok || !manifest.data?.pi?.extensions) continue;
		out.push(source.startsWith("npm:") ? source.slice(4) : source);
	}
	return out;
}
