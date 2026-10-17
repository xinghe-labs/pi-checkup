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
 * @param {{ pi?: object, cwd?: string, offline?: boolean, agentDir?: string }} input
 */
export function buildContext({ pi, cwd, offline = false, agentDir: rootOverride } = {}) {
	const root = rootOverride ?? agentDir();
	const settingsFile = path.join(root, "settings.json");
	const modelsFile = path.join(root, "models.json");

	// A Pi session exposes getSettings(); the CLI does not.
	const hasRuntime = Boolean(pi && typeof pi.getSettings === "function");

	let settings = null;
	let settingsSource = "file";
	if (hasRuntime) {
		try {
			settings = pi.getSettings() ?? null;
			settingsSource = "runtime";
		} catch {
			settings = null;
		}
	}
	if (!settings) {
		const parsed = readJson(settingsFile);
		settings = parsed.ok ? parsed.data : null;
		settingsSource = parsed.ok ? "file" : "unavailable";
	}

	return {
		pi: pi ?? null,
		cwd: cwd ?? process.cwd(),
		agentDir: root,
		settingsFile,
		modelsFile,
		settings,
		settingsSource,
		hasRuntime,
		// Set when the caller asked for checks that must not touch the network.
		offline,
	};
}
