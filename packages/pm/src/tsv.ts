/**
 * Splits TSV text into records keyed by the header row, each with its 1-based line in the
 * file. Blank lines are skipped. Throws when a required column is missing from the header, so
 * a renamed column fails loudly instead of reading as empty.
 */
export function readTsv(
  text: string,
  required: readonly string[],
  label: string,
): { line: number; fields: Record<string, string> }[] {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? "").split("\t");
  const absent = required.filter((column) => !header.includes(column));
  if (absent.length > 0) throw new Error(`${label}: header lacks ${absent.join(", ")}`);
  const records: { line: number; fields: Record<string, string> }[] = [];
  lines.slice(1).forEach((raw, index) => {
    if (raw.trim() === "") return;
    const cells = raw.split("\t");
    const fields = Object.fromEntries(header.map((column, i) => [column, (cells[i] ?? "").trim()]));
    records.push({ line: index + 2, fields });
  });
  return records;
}
