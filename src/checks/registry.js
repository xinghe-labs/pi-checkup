// Registry checks — what is actually loaded right now.
//
// These are the checks a shell script cannot do: `pi list` shows which packages
// are installed, but only the running session knows which tools and commands
// they really registered, under what names, and who lost a collision.
import path from "node:path";
import { normalizePath, ownerOf, readJson, redactSource, resolvePackageDir, scrubCredentials, sourceOf, truncateList } from "../util.js";

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
		// Scrubbed before it is shortened, not after: slicing first can cut a
		// `//user:pass@` in half, and then there is no userinfo left to recognise
		// when the text is printed.
		return { ok: false, error: scrubCredentials(String(e?.message ?? e)).slice(0, 120) };
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
	// Only entries that carry a name: a nameless one still counted towards an
	// owner's total, so the row said "(3)" and then listed two names.
	const named = (list) => list.filter((item) => typeof item?.name === "string" && item.name);
	const toolsByOwner = new Map();
	for (const tool of named(tools)) {
		const owner = ownerOf(tool.sourceInfo?.path);
		if (!toolsByOwner.has(owner)) toolsByOwner.set(owner, []);
		toolsByOwner.get(owner).push(tool.name);
	}
	const commandsByOwner = new Map();
	for (const command of named(commands)) {
		const owner = ownerOf(command.sourceInfo?.path);
		if (!commandsByOwner.has(owner)) commandsByOwner.set(owner, []);
		commandsByOwner.get(owner).push(command.name);
	}
	const toolsNamed = [...toolsByOwner.values()].reduce((n, list) => n + list.length, 0);
	// Counted from every entry, not from `toolsByOwner`: that map only holds the
	// named ones, so a registry whose entries carry no `name` printed
	// "2 registered ... across 0 sources" — two tools from no source at all. A
	// partly-named registry understated the same number.
	const toolsSources = new Set(tools.map((tool) => ownerOf(tool?.sourceInfo?.path)));
	const commandsSources = new Set(commands.map((command) => ownerOf(command?.sourceInfo?.path)));

	// `sourceInfo.path` is a third-party field: a number here threw out of run()
	// and replaced the whole Registry group with one crash row.
	const builtinTools = tools.filter((t) => typeof t?.sourceInfo?.path === "string" && t.sourceInfo.path.startsWith("builtin:")).length;
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
					detail: `${tools.length} registered (${tools.length - builtinTools} extension, ${builtinTools} builtin) across ${toolsSources.size} sources`,
				}
			: {
					group,
					id: "tools",
					title: "tools",
					status: "warn",
					// Scrubbed: the rejection can quote a URL with a token in it, and this
				// detail goes to the terminal, the notification and --json.
				detail: `could not read the tool registry (${scrubCredentials(toolsResult.error)})`,
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
			detail: `${commands.length} registered across ${commandsSources.size} sources, ${serverCount}`,
		});
	} else {
		results.push({
			group,
			id: "commands",
			title: "commands",
			status: "warn",
			detail: `could not read the command registry (${scrubCredentials(commandsResult.error)})`,
			hint: "The Pi API may have changed, or an extension failed mid-load. Run `pi --verbose`.",
		});
	}

	// Which package owns which names — the answer `pi list` cannot give. Shown
	// under --verbose, since the summary line above already covers the default view.
	const attribution = [...toolsByOwner]
		.sort((a, b) => b[1].length - a[1].length)
		.slice(0, 12)
		.map(([owner, names]) => `${owner}: ${truncateList(names, 6)}`)
		.join("; ");
	if (registryReadable && attribution) {
		// The owners themselves belong in the default view: "12 sources own 40
		// tools" answers nothing a user asked, while naming them is the whole point
		// of an attribution row. The per-owner tool names stay behind --verbose.
		const ranked = [...toolsByOwner].sort((a, b) => b[1].length - a[1].length).map(([owner, names]) => `${owner} (${names.length})`);
		results.push({
			group,
			id: "attribution",
			title: "attribution",
			status: "ok",
			detail: `${toolsNamed} tool(s) from ${toolsByOwner.size} source(s): ${truncateList(ranked, 4)}${tools.length > toolsNamed ? ` (${tools.length - toolsNamed} entr${tools.length - toolsNamed === 1 ? "y carries" : "ies carry"} no name and cannot be attributed)` : ""}`,
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
					// Already redacted where the label was built, with the scheme still
					// attached; re-redacting a bare name would erase it.
					detail: `${truncateList(silent, 6)} declared an extension but registered no tool or command`,
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
		// Redacted while the scheme is still attached: `redactSource` can only
		// recognise a source by its scheme or path shape, so stripping `npm:`
		// first turned every bare package name into "(unparsable value)" in the
		// one row a user runs this command to read.
		out.push({ label: redactSource(source).replace(/^npm:/, ""), dir: normalizePath(dir) });
	}
	return out;
}
