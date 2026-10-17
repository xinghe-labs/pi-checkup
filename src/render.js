// Rendering. One formatter feeds both the human report and the JSON payload so
// the two can never disagree about what was found.
const MARKS = { ok: "✓", warn: "!", fail: "✗", skip: "·" };

const GROUP_ORDER = ["Registry", "Packages", "Binaries", "Network", "Config", "Runtime"];

export function summarize(results) {
	const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
	for (const r of results) {
		// An unrecognised status would otherwise be counted in `total` and in
		// nothing else, letting a malformed row render as "all clear".
		const key = Object.hasOwn(counts, r.status) ? r.status : "fail";
		counts[key] += 1;
	}
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
 * Greedy word wrap. `indent` is the column the first line starts at, so a
 * continuation line lines up under the text it continues.
 * A single word longer than the available width is left intact rather than cut.
 */
function wrapText(text, width, indent) {
	const body = String(text ?? "");
	if (!body) return [""];
	if (indent + body.length <= width) return [body];

	const lines = [];
	let line = "";
	for (const word of body.split(/\s+/).filter(Boolean)) {
		if (!line) line = word;
		else if (indent + line.length + 1 + word.length <= width) line += ` ${word}`;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line) lines.push(line);
	return lines.length ? lines : [body];
}

/**
 * Human report. Plain text on purpose: it renders identically in the TUI, over
 * RPC, and in a CI log.
 *
 * Details are wrapped rather than left to the terminal, because the longest of
 * them (a list of unreachable package commands) runs well past 80 columns and
 * terminal wrapping breaks it mid-word with no indent, which reads as a new
 * finding. `width` is supplied by the CLI from the real terminal; the default
 * keeps RPC and log output stable regardless of who is reading it.
 */
export function renderReport(results, { verbose = false, hintCommand = "/checkup verbose", width = 80 } = {}) {
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

	// Wide enough for the longest title in this report, so one long name does not
	// push a single row's detail out of alignment with every other row. A title
	// longer than the cap gets its detail on its own line rather than shoving it
	// past the column every wrapped continuation line uses.
	const titleWidth = Math.min(22, Math.max(8, ...results.map((r) => r.title.length)));
	const detailColumn = 4 + titleWidth + 1;

	const lines = [];
	for (const g of groups) {
		lines.push(g);
		for (const r of byGroup.get(g)) {
			const mark = `  ${MARKS[r.status] ?? "?"} `;
			const title = r.title.padEnd(titleWidth);
			if (r.title.length > titleWidth) {
				lines.push(`${mark}${r.title}`);
				for (const p of wrapText(r.detail, width, detailColumn)) lines.push("".padEnd(detailColumn) + p);
			} else {
				const parts = wrapText(r.detail, width, detailColumn);
				lines.push(`${mark}${title} ${parts[0]}`);
				for (const p of parts.slice(1)) lines.push("".padEnd(detailColumn) + p);
			}
			// Hints are shown for anything the user can act on, including an ok row
			// whose detail carries a caveat.
			if (verbose && r.hint) {
				for (const p of wrapText(r.hint, width, detailColumn)) {
					lines.push("".padEnd(detailColumn) + p);
				}
			}
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
