// Registry checks — what is actually loaded right now.
//
// These are the checks a shell script cannot do: `pi list` shows which packages
// are installed, but only the running session knows which tools and commands
// they really registered, under what names, and who lost a collision.
import path from "node:path";
import { normalizePath, ownerOf, readJson, redactSource, resolvePackageDir, sourceOf } from "../util.js";

export const group = "Registry";

/**
 * Call into the Pi API, keeping "it threw" distinguishable from "it returned
 * nothing". Swallowing the error produced a green "0 registered across 0
 * sources" over a registry that was never read.
 */
function call(fn) {
	try {
		const value = fn();
		// A non-array is a shape this code does not understand, not an empty
		// registry: treating it as [] would print "0 registered across 0 sources"
		// as a pass over a registry that was never read.
		if (Array.isArray(value)) return { ok: true, value };
		return { ok: false, error: `unexpected registry shape (${value === null ? "null" : typeof value})` };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
	}
}

export async function run({ pi, hasRuntime, settings, agentDir: root }) {
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

	const toolsResult = call(() => pi.getAllTools());
	const commandsResult = call(() => pi.getCommands());
	const serversResult = call(() => pi.getMcpServers());
	const tools = toolsResult.ok ? toolsResult.value : [];
	const commands = commandsResult.ok ? commandsResult.value : [];
	const servers = serversResult.ok ? serversResult.value : [];
	const registryReadable = toolsResult.ok && commandsResult.ok;

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
	results.push(
		toolsResult.ok
			? {
					group,
					id: "tools",
					title: "tools",
					// A readable but empty registry is not a pass: the session may have
					// started with tools disabled, and "0 registered across 0 sources"
					// with a tick reads like everything is accounted for.
					status: tools.length ? "ok" : "skip",
					detail: `${tools.length} registered (${tools.length - builtinTools} extension, ${builtinTools} builtin) across ${toolsByOwner.size} sources`,
				}
			: {
					group,
					id: "tools",
					title: "tools",
					status: "warn",
					detail: `could not read the tool registry (${toolsResult.error})`,
					hint: "The Pi API may have changed, or an extension failed mid-load. Run `pi --verbose`.",
				},
	);
	// A failed getMcpServers() is not "0 servers": reporting the zero would state a
	// fact the check never learned.
	const serverCount = serversResult.ok ? `${servers.length} MCP server(s)` : "MCP servers unreadable";
	if (commandsResult.ok) {
		results.push({
			group,
			id: "commands",
			title: "commands",
			// Same rule as the tools row: a readable but empty registry is not a
			// pass. "0 registered across 0 sources" with a tick claims an answer
			// the check does not have.
			status: commands.length ? "ok" : "skip",
			detail: `${commands.length} registered across ${commandsByOwner.size} sources, ${serverCount}`,
		});
	} else {
		results.push({
			group,
			id: "commands",
			title: "commands",
			status: "warn",
			detail: `could not read the command registry (${commandsResult.error})`,
			hint: "The Pi API may have changed, or an extension failed mid-load. Run `pi --verbose`.",
		});
	}

	// Which package owns which names — the answer `pi list` cannot give. Shown
	// under --verbose, since the summary line above already covers the default view.
	const attribution = [...toolsByOwner]
		.sort((a, b) => b[1].length - a[1].length)
		.slice(0, 12)
		.map(([owner, names]) => `${owner}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` +${names.length - 6}` : ""}`)
		.join("; ");
	if (registryReadable && attribution) {
		// The owners themselves belong in the default view: "12 sources own 40
		// tools" answers nothing a user asked, while naming them is the whole point
		// of an attribution row. The per-owner tool names stay behind --verbose.
		const ranked = [...toolsByOwner].sort((a, b) => b[1].length - a[1].length).map(([owner, names]) => `${owner} (${names.length})`);
		const head = ranked.slice(0, 4).join(", ");
		const more = ranked.length > 4 ? ` +${ranked.length - 4} more` : "";
		results.push({
			group,
			id: "attribution",
			title: "attribution",
			status: "ok",
			detail: `${tools.length} tool(s) from ${toolsByOwner.size} source(s): ${head}${more}`,
			hint: `Run with --verbose for the tool names. ${attribution}`,
		});
	}

	// --- collisions --------------------------------------------------------
	// A collision means one extension silently stops being reachable: the later
	// registration wins and the earlier tool or command is gone without an error.
	// Without a readable registry every list is empty, so "no collisions" would be
	// a green row over a registry that was never read.
	const duplicateTools = findDuplicates(tools);
	results.push(
		!toolsResult.ok
			? {
					group,
					id: "tool-collisions",
					title: "tool collisions",
					status: "skip",
					detail: "the tool registry could not be read",
				}
			: duplicateTools.length
			? {
					group,
					id: "tool-collisions",
					title: "tool collisions",
					status: "fail",
					detail: duplicateTools.map(([name, owners]) => `${name} claimed by ${owners.join(" + ")}`).join("; "),
					hint: "Rename one of them, or disable the package you do not need.",
				}
			: !comparable(tools)
			? {
					group,
					id: "tool-collisions",
					title: "tool collisions",
					status: "skip",
					// The tools row above may have just reported registrations, so
					// "nothing registered" would contradict it: the entries exist and
					// simply carry no name to compare.
					detail: "no registered entry carries a name to compare",
				}
			: { group, id: "tool-collisions", title: "tool collisions", status: "ok", detail: "none" },
	);

	const duplicateCommands = findDuplicates(commands);
	results.push(
		!commandsResult.ok
			? {
					group,
					id: "command-collisions",
					title: "command collisions",
					status: "skip",
					detail: "the command registry could not be read",
				}
			: duplicateCommands.length
			? {
					group,
					id: "command-collisions",
					title: "command collisions",
					status: "fail",
					detail: duplicateCommands.map(([name, owners]) => `/${name} claimed by ${owners.join(" + ")}`).join("; "),
					hint: "Only one handler will run. Rename or remove one of the packages.",
				}
			: !comparable(commands)
			? {
					group,
					id: "command-collisions",
					title: "command collisions",
					status: "skip",
					detail: "no registered entry carries a name to compare",
				}
			: { group, id: "command-collisions", title: "command collisions", status: "ok", detail: "none" },
	);

	// --- silent failures ---------------------------------------------------
	// A package that declares extensions but registered nothing is the most
	// common failure mode that produces no error message anywhere.
	//
	// Compared by resolved file path rather than by name: a local package is
	// declared as `./local-ext` in settings but attributed as `local:local-ext`
	// by ownerOf(), and an npm package can register from a nested directory. Path
	// containment is the only comparison that holds for every source kind.
	const loadedPaths = [...tools, ...commands]
		.map((item) => item?.sourceInfo?.path)
		.filter((p) => typeof p === "string" && !p.startsWith("builtin:"))
		.map(normalizePath);

	// Without a readable registry every declared package looks silent, so the
	// comparison is only meaningful when both halves loaded.
	if (!registryReadable) {
		results.push({
			group,
			id: "silent",
			title: "silent packages",
			status: "skip",
			detail: "cannot compare against the registry that failed to load",
		});
		return results;
	}

	const candidates = declaredPackages(settings, root);
	const silent = candidates
		.filter((pkg) => !loadedPaths.some((loaded) => loaded === pkg.dir || loaded.startsWith(`${pkg.dir}/`)))
		.map((pkg) => pkg.label);
	results.push(
		!candidates.length
			? {
					group,
					id: "silent",
					title: "silent packages",
					status: "skip",
					detail: "no inspectable package declares an extension",
				}
			: silent.length
			? {
					group,
					id: "silent",
					title: "silent packages",
					status: "warn",
					// A source can be a URL with userinfo in it, and this list is the only
					// place a source reaches the report from this module.
					detail: `${silent.map(redactSource).join(", ")} declared an extension but registered no tool or command`,
					hint: "May be event-only by design, or may have failed to load. Restart `pi --verbose` to see extension load errors.",
				}
			: { group, id: "silent", title: "silent packages", status: "ok", detail: "none" },
	);

	return results;
}

/**
 * Is there anything to compare? A registry whose entries carry no `name` cannot
 * collide, and `findDuplicates` drops those, so counting the array instead would
 * print "none" over zero compared objects.
 */
function comparable(items) {
	return items.some((item) => item?.name);
}

function findDuplicates(items) {
	// Keyed by registration, not by owner label: two packages that register the
	// same name but carry no sourceInfo.path both resolve to "unknown", and
	// de-duplicating by label collapsed them into a single owner — the collision
	// then rendered as "none".
	const byName = new Map();
	let unattributed = 0;
	for (const item of items) {
		const name = item?.name;
		if (!name) continue;
		const sourcePath = item?.sourceInfo?.path;
		const key = typeof sourcePath === "string" && sourcePath ? sourcePath : `unknown#${unattributed++}`;
		const owner = ownerOf(sourcePath);
		if (!byName.has(name)) byName.set(name, new Map());
		byName.get(name).set(key, owner);
	}
	return [...byName].filter(([, owners]) => owners.size > 1).map(([name, owners]) => [name, [...owners.values()]]);
}

/**
 * Packages from settings whose manifests declare an extension entry.
 * Returns the resolved directory, because the declared source string and the
 * path Pi reports in sourceInfo are not in the same namespace.
 */
function declaredPackages(settings, root) {
	const out = [];
	// Guard the type: a hand-edited string here would be walked character by
	// character, and every character is itself a string.
	const specs = Array.isArray(settings?.packages) ? settings.packages : [];
	for (const spec of specs) {
		const source = sourceOf(spec);
		if (!source) continue;
		const dir = resolvePackageDir(source, root);
		// git:/https:/bare sources are resolved by Pi itself; the Packages group
		// already reports those as unverifiable rather than guessing here.
		if (!dir) continue;
		const manifest = readJson(path.join(dir, "package.json"));
		if (!manifest.ok) continue;
		// An empty list declares no extension, so loading nothing is correct.
		// A single string is as valid as a list here; both declare at least one
		// extension, and only "declares none" means silence is expected.
		const declared = manifest.data?.pi?.extensions;
		let count = 1;
		if (Array.isArray(declared)) count = declared.length;
		// `null`, `false` and `""` declare nothing, exactly as packages.js reads
		// them. Treating null as one extension reported "declared an extension but
		// registered no tool or command" for a package that declared none.
		else if (!declared) count = 0;
		if (!count) continue;
		out.push({ label: source.replace(/^npm:/, ""), dir: normalizePath(dir) });
	}
	return out;
}
