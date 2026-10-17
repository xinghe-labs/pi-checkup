// One place that decides where a check gets its inputs from.
//
// Inside a Pi session the authoritative source is the running process, so
// settings come from `pi.getSettings()` and the registry from the live tool and
// command tables. Outside a session (the standalone CLI) there is no process to
// ask, so settings are read from disk and the registry checks report skipped.
// Keeping that decision here means every check module stays ignorant of which
// mode it is running in, and can be pointed at a temporary root in tests.
import path from "node:path";
import { agentDir, readJson } from "./util.js";

/**
 * @param {{ pi?: object, cwd?: string, offline?: boolean, agentDir?: string, env?: object }} input
 */
export function buildContext({ pi, cwd, offline = false, agentDir: rootOverride, env } = {}) {
	const root = rootOverride ?? agentDir();
	const settingsFile = path.join(root, "settings.json");
	const modelsFile = path.join(root, "models.json");

	// A Pi session exposes getSettings(); the CLI does not.
	const hasRuntime = Boolean(pi && typeof pi.getSettings === "function");

	let settings = null;
	let settingsSource = "file";
	// A live session whose settings could not be read is not the same thing as a
	// session whose settings match the file: falling back to the file keeps the
	// report useful, but a repair would then edit a file the running process may
	// disagree with, so the source is recorded as neither.
	let runtimeUnreadable = false;
	// `settings === null` is two different states: a file that could not be read,
	// and a file whose JSON is literally `null`. Only this flag separates them.
	let settingsLoaded = false;
	if (hasRuntime) {
		try {
			settings = pi.getSettings() ?? null;
			settingsSource = "runtime";
			settingsLoaded = true;
		} catch {
			settings = null;
			runtimeUnreadable = true;
		}
	}
	if (!settings) {
		const parsed = readJson(settingsFile);
		settings = parsed.ok ? parsed.data : null;
		settingsLoaded = parsed.ok;
		if (runtimeUnreadable) settingsSource = "runtime-unreadable";
		else settingsSource = parsed.ok ? "file" : "unavailable";
	}

	return {
		pi: pi ?? null,
		cwd: cwd ?? process.cwd(),
		agentDir: root,
		settingsFile,
		modelsFile,
		// The two paths a check would otherwise rebuild itself. Deriving them here
		// keeps the agent layout in one place and lets a test describe a project
		// config or a .bin directory without touching the real tree.
		projectSettingsFile: path.join(cwd ?? process.cwd(), ".pi", "settings.json"),
		binDir: path.join(root, "npm", "node_modules", ".bin"),
		settings,
		settingsLoaded,
		settingsSource,
		hasRuntime,
		// Checks read the environment through the context, not from process.env, so
		// a test can describe a proxy or an unset variable without touching the
		// environment the suite itself runs in.
		env: env ?? process.env,
		// Set when the caller asked for checks that must not touch the network.
		offline,
	};
}
