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
 * Columns a string occupies, not code units.
 *
 * A CJK path — `C:\Users\张三\.pi\agent` — is one code unit per character and
 * two columns on every terminal, so measuring with `.length` wrapped one column
 * short and let the line spill past the width the report promises to respect.
 */
function displayWidth(text) {
	let width = 0;
	for (const ch of String(text ?? "")) {
		const cp = ch.codePointAt(0);
		// Combining marks and zero-width joiners occupy no column of their own.
		if (cp === 0x200b || cp === 0xfeff || (cp >= 0x0300 && cp <= 0x036f)) continue;
		const wide =
			(cp >= 0x1100 && cp <= 0x115f) ||
			(cp >= 0x2e80 && cp <= 0x303e) ||
			(cp >= 0x3041 && cp <= 0x33ff) ||
			(cp >= 0x3400 && cp <= 0x4dbf) ||
			(cp >= 0x4e00 && cp <= 0x9fff) ||
			(cp >= 0xa000 && cp <= 0xa4cf) ||
			(cp >= 0xa960 && cp <= 0xa97f) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe10 && cp <= 0xfe19) ||
			(cp >= 0xfe30 && cp <= 0xfe6f) ||
			(cp >= 0xff00 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1f300 && cp <= 0x1f64f) ||
			(cp >= 0x1f900 && cp <= 0x1f9ff) ||
			(cp >= 0x20000 && cp <= 0x3fffd);
		width += wide ? 2 : 1;
	}
	return width;
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
 *
 * Widths are display columns, not code units: see `displayWidth`.
 */
function wrapText(text, width, indent) {
	const body = String(text ?? "");
	if (!body) return [""];
	const avail = Math.max(8, width - indent);
	if (displayWidth(body) <= avail) return [body];

	const lines = [];
	let line = "";
	let lineWidth = 0;
	const flush = () => {
		if (line) {
			lines.push(line);
			line = "";
			lineWidth = 0;
		}
	};
	for (const word of body.split(/\s+/).filter(Boolean)) {
		const wordWidth = displayWidth(word);
		if (wordWidth > avail) {
			flush();
			// Cut the long token into pieces that fit, measured in columns so a
			// wide character cannot straddle the edge.
			let piece = "";
			let pieceWidth = 0;
			for (const ch of word) {
				const cw = displayWidth(ch);
				if (pieceWidth + cw > avail) {
					lines.push(piece);
					piece = "";
					pieceWidth = 0;
				}
				piece += ch;
				pieceWidth += cw;
			}
			if (piece) {
				line = piece;
				lineWidth = pieceWidth;
			}
			continue;
		}
		if (!line) {
			line = word;
			lineWidth = wordWidth;
		} else if (lineWidth + 1 + wordWidth <= avail) {
			line += ` ${word}`;
			lineWidth += 1 + wordWidth;
		} else {
			flush();
			line = word;
			lineWidth = wordWidth;
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
	const titleWidth = Math.min(22, Math.max(8, ...results.map((r) => displayWidth(r.title))));
	// Below this width the title column plus one word of detail leaves a gutter
	// too narrow to read ("package dirs 2 missing from" then two words a line), so
	// the detail moves under the title instead of beside it.
	const stacked = width < 56;
	const detailColumn = stacked ? 6 : 4 + titleWidth + 1;

	const lines = [];
	for (const g of groups) {
		lines.push(g);
		for (const r of byGroup.get(g)) {
			const mark = `  ${MARKS[r.status] ?? "?"} `;
			const title = r.title.padEnd(titleWidth);
			if (stacked || displayWidth(r.title) > titleWidth) {
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
	// Wrapped like every other line: the summary is the longest single sentence in
	// a short report — "19 checks: 11 ok, 0 warnings, 0 failed, 8 skipped" is 51
	// columns — and leaving it unwrapped broke the width the rest of the report
	// respects on a narrow terminal or a split pane.
	for (const part of wrapText(`${s.total} checks: ${s.ok} ok, ${s.warn} ${warnWord}, ${s.fail} failed${s.skip ? `, ${s.skip} skipped` : ""}`, width, 0)) {
		lines.push(part);
	}
	// Any hint, on any row. Tying this to non-ok rows meant a report whose only
	// finding carried no hint never mentioned --verbose at all, so the user had
	// no way to learn the flag exists.
	if (!verbose && results.some((r) => r.hint)) {
		for (const part of wrapText(`Run \`${hintCommand}\` to show what to do about each finding.`, width, 0)) {
			lines.push(part);
		}
	}
	return lines.join("\n");
}

/** One-line verdict suitable for a status bar or a commit message. */
export function renderVerdict(results) {
	const s = summarize(results);
	// The skipped count travels with every verdict, not just the clean one. It
	// used to disappear the moment anything was non-ok, so `! 1 warning` was the
	// last line of a report in which 12 of 15 checks had looked at nothing — the
	// same false confidence the branches below exist to avoid, one level up.
	const tail = s.skip ? `, ${s.skip} skipped` : "";
	if (s.fail) return `✗ ${s.fail} failed${tail}`;
	if (s.warn) return `! ${s.warn} ${s.warn === 1 ? "warning" : "warnings"}${tail}`;
	// "all clear" over a report where nothing could be checked is the exact false
	// confidence this package exists to remove, so the skipped count is part of
	// the verdict rather than a footnote.
	if (!s.ok) return `· nothing verified (${s.skip} skipped)`;
	if (s.skip) return `✓ ${s.ok} ok, ${s.skip} skipped`;
	return "✓ all clear";
}
