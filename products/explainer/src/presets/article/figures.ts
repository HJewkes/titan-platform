import type { FigureData } from "./schemas.js";

export interface ExtractedFigure {
  id: string;
  caption: string;
  line: number;
  data: FigureData;
}

export interface FigureNote {
  code: "W-FIGURE-NO-DATA" | "W-TABLE-TEXT";
  id: string;
  line: number;
  message: string;
}

const CAPTION = /^(figure|fig\.|table)\s+(\d+)\s*[.:]\s*(.+)$/i;

const stripEmphasis = (line: string) => line.replace(/[*_]/g, "").trim();
const isTableLine = (line: string) => line.trim().startsWith("|");
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const isSeparator = (row: string[]) => row.every((cell) => /^:?-{3,}:?$/.test(cell));
const slug = (label: string, i: number) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `series-${i + 1}`;

function numberOf(cell: string): number {
  const text = cell.replace(/(\d),(\d{3})/g, "$1$2").replace(/%$/, "").trim();
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
}

/** A table's numbers as figure data: the first column is x, every other column a series; undefined when a cell is text. */
export function tableData(rows: string[][], caption: string): FigureData | undefined {
  const [header, ...body] = rows;
  if (!header || header.length < 2 || body.length === 0) return undefined;
  const ys = body.map((row) => header.slice(1).map((_, j) => numberOf(row[j + 1] ?? "")));
  if (ys.some((row) => row.some(Number.isNaN))) return undefined;
  const xs = body.map((row) => numberOf(row[0] ?? ""));
  const numericX = xs.every((x) => !Number.isNaN(x));
  const series = header.slice(1).map((label, j) => ({
    id: slug(label, j),
    label,
    points: body.map((_, i) => ({ x: numericX ? xs[i]! : i + 1, y: ys[i]![j]! })),
  }));
  const base = { x: header[0] || "x", y: caption, series };
  return numericX ? { kind: "line", ...base } : { kind: "bar", ...base, categories: body.map((row) => row[0] ?? "") };
}

function tableAt(lines: string[], start: number): string[][] | undefined {
  let i = start;
  while (i < lines.length && lines[i]!.trim() === "") i += 1;
  const rows: string[][] = [];
  for (; i < lines.length && isTableLine(lines[i]!); i += 1) rows.push(cells(lines[i]!));
  return rows.length > 0 ? rows.filter((row) => !isSeparator(row)) : undefined;
}

/**
 * Every captioned figure or table whose data the text carries as a markdown table, so the video re-plots it from
 * numbers. A figure the text holds only as an image cannot be shown, and a table of text is no figure; both are notes.
 */
export function extractFigures(text: string): { figures: ExtractedFigure[]; notes: FigureNote[] } {
  const lines = text.split(/\r?\n/);
  const figures: ExtractedFigure[] = [];
  const notes: FigureNote[] = [];
  lines.forEach((raw, i) => {
    const match = CAPTION.exec(stripEmphasis(raw));
    if (!match) return;
    const id = `${match[1]!.toLowerCase().startsWith("table") ? "table" : "figure"}-${match[2]}`;
    const caption = match[3]!.trim();
    const rows = tableAt(lines, i + 1);
    const data = rows && tableData(rows, caption);
    if (data) figures.push({ id, caption, line: i + 1, data });
    else if (rows) notes.push({ code: "W-TABLE-TEXT", id, line: i + 1, message: `${id} is a table of text, not data; it is no figure` });
    else notes.push({ code: "W-FIGURE-NO-DATA", id, line: i + 1, message: `${id} has no data table in the text; it cannot be re-plotted, so the video cannot show it` });
  });
  return { figures, notes };
}
