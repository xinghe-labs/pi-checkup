// Rendering. One formatter feeds both the human report and the JSON payload so
// the two can never disagree about what was found.
const MARKS = { ok: "✓", warn: "!", fail: "✗", skip: "·" };

const GROUP_ORDER = ["Registry", "Packages", "Binaries", "Network", "Config", "Runtime"];

export function summarize(results) {
	const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
	for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
	return { total: results.length, ...counts };
}

/** Machine-readable payload for `/checkup json`. */
export function toJson(results, extra = {}) {
	return {
		summary: summarize(results),
		...extra,
		checks: results.map(({ fix, fixTarget, ...rest }) => rest),
	};
}

/**
 * Human report. Plain text on purpose: it renders identically in the TUI, over
 * RPC, and in a CI log, and it stays readable when the terminal is 60 columns.
 */
export function renderReport(results, { verbose = false, hintCommand = "/checkup verbose" } = {}) {
	const byGroup = new Map();
	for (const r of results) {
		const g = r.group ?? "Other";
		if (!byGroup.has(g)) byGroup.set(g, []);
		byGroup.get(g).push(r);
	}
	const groups = [...byGroup.keys()].sort((a, b) => {
		const ia = GROUP_ORDER.indexOf(a);
		const ib = GROUP_ORDER.indexOf(b);
		return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
	});

	const lines = [];
	for (const g of groups) {
		lines.push(g);
		for (const r of byGroup.get(g)) {
			lines.push(`  ${MARKS[r.status] ?? "?"} ${r.title.padEnd(16)} ${r.detail}`);
			if (verbose && r.hint && r.status !== "ok") lines.push(`      ${r.hint}`);
		}
	}

	const s = summarize(results);
	lines.push("");
	const warnWord = s.warn === 1 ? "warning" : "warnings";
	lines.push(`${s.total} checks: ${s.ok} ok, ${s.warn} ${warnWord}, ${s.fail} failed${s.skip ? `, ${s.skip} skipped` : ""}`);
	if (!verbose && results.some((r) => r.hint && r.status !== "ok")) {
		lines.push(`Run \`${hintCommand}\` to show what to do about each finding.`);
	}
	return lines.join("\n");
}

/** One-line verdict suitable for a status bar or a commit message. */
export function renderVerdict(results) {
	const s = summarize(results);
	if (s.fail) return `✗ ${s.fail} failed`;
	if (s.warn) return `! ${s.warn} ${s.warn === 1 ? "warning" : "warnings"}`;
	return "✓ all clear";
}
