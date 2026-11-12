import { readFileSync } from "node:fs";
import { readTaskRows, type TaskRow } from "@titan-design/session-analytics";
import { z } from "zod";
import { readLabels } from "./read-labels.js";
import type { OriginLinkCounts } from "./read-origin.js";
import { measureFigures, populationRows, weekLinks, type Measure, type ReproduceInput, type WeekLinks } from "./reproduce-figures.js";
import { figureLabel, type ExpectedFile, type Tolerance } from "./reproduce-spec.js";
import { runTicketScorecard, type ScorecardRunOptions } from "./run.js";

type Verdict = "pass" | "miss" | "not measured";

interface ReproduceLine {
  figure: string;
  expected: number;
  tolerance: Tolerance;
  /** Null when the rows cannot give the figure yet; `note` then says why. */
  actual: number | null;
  verdict: Verdict;
  note: string | null;
}

interface ReproduceReport {
  population: string;
  populationRows: number;
  lines: ReproduceLine[];
  /** Per week, the population's tasks and those linked only through the session origin (inferred). */
  weeks: WeekLinks[];
  /** Every spawn with no recorded task, by how its session origin link fared; null when not measured. */
  originLinks: OriginLinkCounts | null;
  /** Every figure inside its tolerance. A miss or a figure not measured needs a named data change to explain it. */
  ok: boolean;
}

function bound(expected: number, tolerance: Tolerance): number {
  if ("pp" in tolerance) return tolerance.pp;
  if ("pct" in tolerance) return (Math.abs(expected) * tolerance.pct) / 100;
  return 0;
}

function verdictOf(expected: number, tolerance: Tolerance, measured: Measure): Pick<ReproduceLine, "actual" | "verdict" | "note"> {
  if ("notMeasured" in measured) return { actual: null, verdict: "not measured", note: measured.notMeasured };
  const inside = Math.abs(measured.value - expected) <= bound(expected, tolerance) + 1e-9;
  return { actual: measured.value, verdict: inside ? "pass" : "miss", note: null };
}

/** Each expected figure against the rows, inside or outside its tolerance. */
export function reproduce(input: ReproduceInput, spec: ExpectedFile, population: string, originLinks: OriginLinkCounts | null = null): ReproduceReport {
  const measures = measureFigures(input, spec, population);
  const lines = spec.figures.map((figure, i) => ({
    figure: figureLabel(figure),
    expected: figure.expected,
    tolerance: figure.tolerance,
    ...verdictOf(figure.expected, figure.tolerance, measures[i]!),
  }));
  const rows = populationRows(input.rows, spec, population);
  return { population, populationRows: rows.length, lines, weeks: weekLinks(rows), originLinks, ok: lines.every((l) => l.verdict === "pass") };
}

function toleranceText(tolerance: Tolerance): string {
  if ("pp" in tolerance) return `±${tolerance.pp} pp`;
  if ("pct" in tolerance) return `±${tolerance.pct}%`;
  return "exact";
}

function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function percentText(part: number, whole: number): string {
  return whole === 0 ? "–" : `${((100 * part) / whole).toFixed(1)}%`;
}

/** The population per week and the share of its task rows whose dispatch link is inferred. */
function renderLinks(report: ReproduceReport): string[] {
  const head = ["", "| week | tasks | link inferred | share |", "|---|---:|---:|---:|"];
  const rows = report.weeks.map((w) => `| ${w.week} | ${w.tasks} | ${w.inferredLink} | ${percentText(w.inferredLink, w.tasks)} |`);
  const o = report.originLinks;
  const tail = o === null ? [] : ["", `spawns without meta.task: ${o.linked} linked through the session origin; unlinked ${o.several + o.none + o.noOrigin} (${o.several} several tasks, ${o.none} no task, ${o.noOrigin} no origin)`];
  return [...head, ...rows, ...tail];
}

/** The pass/miss table as markdown, one row per figure, then the weekly link table. */
export function renderReport(report: ReproduceReport): string {
  const head = [`population ${report.population}: ${report.populationRows} tasks`, "", "| figure | expected | tolerance | actual | verdict | note |", "|---|---:|---|---:|---|---|"];
  const rows = report.lines.map((l) => {
    const actual = l.actual === null ? "–" : numberText(l.actual);
    return `| ${l.figure} | ${numberText(l.expected)} | ${toleranceText(l.tolerance)} | ${actual} | ${l.verdict} | ${l.note ?? ""} |`;
  });
  const counts = (["pass", "miss", "not measured"] as const).map((v) => `${report.lines.filter((l) => l.verdict === v).length} ${v}`);
  return `${[...head, ...rows, "", counts.join(", "), ...renderLinks(report)].join("\n")}\n`;
}

const SampleRow = z.object({ task: z.string().min(1) });

/** The hand audit's sample file (JSONL, one `{task}` per line), as bare task ids. */
export function readSample(file: string): Set<string> {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  return new Set(lines.map((l) => SampleRow.parse(JSON.parse(l)).task));
}

interface Rebuilt {
  rows: TaskRow[];
  originLinks: OriginLinkCounts | null;
}

/** Rebuild every task row into an in-memory store, read-only on every source, and hand back the rows. */
export async function rebuiltRows(options: ScorecardRunOptions): Promise<Rebuilt | null> {
  // Assigned inside the callback, which control-flow narrowing does not follow.
  let rows = null as TaskRow[] | null;
  const inMemory = { ...options, storeFile: ":memory:", weeksDir: null, lockFile: null, rebuild: true };
  const result = await runTicketScorecard({ ...inMemory, inspect: (store) => (rows = readTaskRows(store)) });
  if (rows === null) return null;
  return { rows, originLinks: "originLinks" in result ? result.originLinks : null };
}

/** The labels file's `class_raw` map; empty when the file is absent or carries none. */
export function rawClassOf(labelsFile: string): ReproduceInput["rawClass"] {
  return readLabels(labelsFile)?.rawClass ?? new Map();
}
