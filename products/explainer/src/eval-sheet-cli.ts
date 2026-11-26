import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import type { EvalCliDeps } from "./eval-cli.js";
import { createJudgeHarness, JudgeConfigSchema, type JudgeConfig } from "./eval-harness.js";
import { runSheetCritique, SHEET_JUDGE } from "./sheet-judge.js";
import type { CritiqueResult } from "./sheet-critique.js";

const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

// The pipeline's script model; a judge config naming it is refused (TP-6200).
const SCRIPT_MODEL = "sonnet";
// The D1 proposal for "passes": award work reads 7.5 to 8, so 7 is the line a gate draws.
const GATE_MIN_OVERALL = 7;

interface SheetFlags {
  sheets: string;
  judge?: string;
  json?: boolean;
  minOverall?: string;
  gate?: boolean;
}

const CellsFileSchema = z.object({
  sheets: z.array(z.object({ file: z.string().min(1) })).min(1),
  cells: z.array(z.object({ beat: z.string().min(1), t: z.number() })),
});

type Severity = "warning" | "error" | "report";

interface SheetRow {
  check_id: string;
  severity: Severity;
  pass: boolean;
  detail: string;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function readCells(dir: string): { sheets: string[]; cells: { beat: string; t: number }[] } {
  const file = join(dir, "cells.json");
  let raw: unknown;
  try {
    raw = readJson(file);
  } catch {
    throw new Error(`no readable cells.json in ${dir}; run \`explainer sheets\` first`);
  }
  const parsed = CellsFileSchema.parse(raw);
  return { sheets: parsed.sheets.map((sheet) => resolve(dir, sheet.file)), cells: parsed.cells };
}

const fmt = (n: number): string => n.toFixed(1);

/** The overall row is a warning until `--gate`; a threshold only fails it when asked for with `--min-overall` or `--gate`. */
function sheetRows(score: CritiqueResult, flags: { minOverall?: number; gate: boolean }): SheetRow[] {
  const threshold = flags.minOverall ?? GATE_MIN_OVERALL;
  const enforced = flags.gate || flags.minOverall !== undefined;
  const below = score.overall < threshold;
  const dims = (["design", "clarity", "idea", "content"] as const).map((dim) => ({ check_id: `sheet:${dim}`, severity: "report" as const, pass: true, detail: fmt(score.scores[dim]) }));
  return [
    { check_id: "sheet:overall", severity: flags.gate ? "error" : "warning", pass: !below, detail: `${fmt(score.overall)} (min ${fmt(threshold)}${enforced ? "" : ", not enforced"})` },
    ...dims,
    { check_id: "sheet:caps", severity: "report", pass: true, detail: score.caps.length > 0 ? score.caps.join(",") : "none" },
  ];
}

const enforcedFailure = (score: CritiqueResult, flags: { minOverall?: number; gate: boolean }): boolean =>
  (flags.gate || flags.minOverall !== undefined) && score.overall < (flags.minOverall ?? GATE_MIN_OVERALL);

function parseMinOverall(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : z.coerce.number().min(0).max(10).parse(raw);
}

function print(flags: SheetFlags, body: Record<string, unknown>, lines: readonly string[]): void {
  if (flags.json) console.log(JSON.stringify(body));
  else lines.forEach((line) => console.log(line));
}

async function evalSheet(flags: SheetFlags, deps: EvalCliDeps): Promise<number> {
  const minOverall = parseMinOverall(flags.minOverall);
  const { sheets, cells } = readCells(flags.sheets);
  const judge: JudgeConfig = flags.judge ? JudgeConfigSchema.parse(readJson(flags.judge)) : SHEET_JUDGE;
  const harness = (deps.harness ?? createJudgeHarness)(judge);
  const result = await runSheetCritique({ sheets, cells, harness, judge, scriptModel: SCRIPT_MODEL });
  const usd = result.spend.usd.toFixed(2);
  if (!result.ok) {
    print(flags, { judge: result.judge, ok: false, reason: result.reason, usd: result.spend.usd }, [`failed: ${result.reason}`, `usd ${usd}`]);
    return EXIT.FAILURE;
  }
  const gate = flags.gate === true;
  const rows = sheetRows(result.score, { minOverall, gate });
  const lines = [
    ...rows.map((row) => `${row.check_id}\t${row.pass ? "pass" : "fail"}\t${row.severity}\t${row.detail}`),
    ...result.score.top.map((line, i) => `top ${i + 1}\t${line}`),
    `voided ${result.voided}`,
    ...(result.trusted ? [] : ["untrusted: the judge missed the planted glow, so its scores are not to be believed"]),
    `usd ${usd}`,
  ];
  print(flags, { judge: result.judge, trusted: result.trusted, voided: result.voided, rows, top: result.score.top, usd: result.spend.usd }, lines);
  return result.trusted && !enforcedFailure(result.score, { minOverall, gate }) ? EXIT.OK : EXIT.FAILURE;
}

export const sheetCommand = (deps: EvalCliDeps, onResult: (code: number) => void): Command =>
  new Command("sheet")
    .description("Judge a contact-sheet directory (cells.json plus sheet PNGs) with four critique passes and a planted-glow canary; print the scores, caps, top three fixes and the usd spent")
    .requiredOption("--sheets <dir>", "a directory with cells.json and the sheet PNGs, from `explainer sheets` or the sheets stage")
    .option("--judge <file>", "judge config JSON; by default claude-print opus")
    .option("--json", "print one JSON object instead of lines")
    .option("--min-overall <n>", "exit 1 when the overall score is below this (0 to 10)")
    .option("--gate", `make sheet:overall an error and exit 1 below the minimum (${GATE_MIN_OVERALL} unless --min-overall says otherwise)`)
    .exitOverride()
    .action(async (flags: SheetFlags) => {
      try {
        onResult(await evalSheet(flags, deps));
      } catch (error) {
        console.error(`${flags.sheets}: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
