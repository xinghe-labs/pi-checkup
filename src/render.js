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
 * Greedy word wrap. `indent` is the column the text starts at, so every line has
 * the same available width and continuation lines line up under the text they
 * continue.
 *
 * A token longer than the whole column — a URL, a hash, a deep path — is cut into
 * chunks rather than left to overflow: the terminal would wrap it anyway, and it
 * would do so with no indent, which breaks the column alignment that makes the
 * report scannable.
 */
function wrapText(text, width, indent) {
	const body = String(text ?? "");
	if (!body) return [""];
	const avail = Math.max(8, width - indent);
	if (body.length <= avail) return [body];

	const lines = [];
	let line = "";
	const flush = () => {
		if (line) {
			lines.push(line);
			line = "";
		}
	};
	for (const word of body.split(/\s+/).filter(Boolean)) {
		if (word.length > avail) {
			flush();
			for (let i = 0; i < word.length; i += avail) lines.push(word.slice(i, i + avail));
			continue;
		}
		if (!line) line = word;
		else if (line.length + 1 + word.length <= avail) line += ` ${word}`;
		else {
			flush();
			line = word;
		}
	}
	flush();
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
				// The title gets the same treatment as the detail: a name that does not
				// fit would otherwise set the width for the whole report.
				const titleParts = wrapText(r.title, width, mark.length);
				lines.push(`${mark}${titleParts[0]}`);
				for (const p of titleParts.slice(1)) lines.push("".padEnd(mark.length) + p);
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
	// Any hint, on any row. Tying this to non-ok rows meant a report whose only
	// finding carried no hint never mentioned --verbose at all, so the user had
	// no way to learn the flag exists.
	if (!verbose && results.some((r) => r.hint)) {
		lines.push(`Run \`${hintCommand}\` to show what to do about each finding.`);
	}
	return lines.join("\n");
}

/** One-line verdict suitable for a status bar or a commit message. */
export function renderVerdict(results) {
	const s = summarize(results);
	if (s.fail) return `✗ ${s.fail} failed`;
	if (s.warn) return `! ${s.warn} ${s.warn === 1 ? "warning" : "warnings"}`;
	// "all clear" over a report where nothing could be checked is the exact false
	// confidence this package exists to remove, so the skipped count is part of
	// the verdict rather than a footnote.
	if (!s.ok) return `· nothing verified (${s.skip} skipped)`;
	if (s.skip) return `✓ ${s.ok} ok, ${s.skip} skipped`;
	return "✓ all clear";
}
