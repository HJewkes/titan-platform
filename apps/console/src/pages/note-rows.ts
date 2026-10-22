interface NoteRow {
  label: string | null;
  value: string;
}

// A label is capitals (digits, spaces, slashes, hyphens inside) closing on a colon that is followed by
// whitespace or the end, so "10:30" and "https://host" are values, not labels.
const LABEL = /(^|\s)([A-Z][A-Z0-9/-]*(?: [A-Z0-9/-]+){0,2}):(?=\s|$)/g;

/** Splits an author's note into rows: one per line, and a line with labels in it into one row per label. */
export function noteRows(text: string): NoteRow[] {
  return text.split(/\r?\n/).flatMap(lineRows);
}

function lineRows(line: string): NoteRow[] {
  const marks = [...line.matchAll(LABEL)].map((match) => ({
    label: match[2] ?? "",
    start: match.index + (match[1]?.length ?? 0),
    end: match.index + match[0].length,
  }));
  const lead = line.slice(0, marks[0]?.start ?? line.length);
  const rows: NoteRow[] = [{ label: null, value: lead.trim() }];
  marks.forEach((mark, index) => rows.push({ label: mark.label, value: line.slice(mark.end, marks[index + 1]?.start ?? line.length).trim() }));
  return rows.filter((row) => row.label !== null || row.value !== "");
}
