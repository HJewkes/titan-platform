import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readRubric } from "./eval-evidence.js";
import { JudgeConfigSchema, judgeLabel, type JudgeConfig, type JudgeHarness, type JudgeReply } from "./eval-harness.js";
import { sumSpend } from "./eval-judge.js";
import { CAP_TAGS, CRITIQUE_PASSES, critiqueScore, type CritiqueResult } from "./sheet-critique.js";

/** D2: the script default is sonnet, so opus judges the sheets. One sheet cost about $0.06 on opus in the S0 spike. */
export const SHEET_JUDGE: JudgeConfig = JudgeConfigSchema.parse({ provider: "claude-print", model: "opus", max_budget_usd: 0.5 });

const RUBRIC_FILE = "sheet-critique.md";
const CANARY_PNG = fileURLToPath(new URL("../assets/canary-glow.png", import.meta.url));
// Named like a real sheet and beat, so the judge cannot tell the canary call from a pass.
const CANARY_SHEET_NAME = "sheet-intro.png";
const CANARY_CELL: SheetCellRef = { beat: "intro", t: 0 };
const CANARY_PASS: Pass = "polish";
const CANARY_TAG = "glow-or-gradient";
// The label strip prints t to 0.1 s, so a judge reading it can be off by half a step.
const CELL_T_TOLERANCE_S = 0.06;

type Pass = (typeof CRITIQUE_PASSES)[number];

/** The part of a `cells.json` record a finding is checked against. */
export interface SheetCellRef {
  beat: string;
  t: number;
}

export interface SheetCritiqueInput {
  /** Absolute paths to the chapter sheets, attached to every pass in this order. */
  sheets: readonly string[];
  cells: readonly SheetCellRef[];
  harness: JudgeHarness;
  judge: JudgeConfig;
  /** The model that wrote the script; the judge must be a different one (TP-6200). */
  scriptModel: string;
  rubric?: string;
}

type Spend = ReturnType<typeof sumSpend>;

export type SheetCritiqueResult =
  | { ok: true; judge: string; score: CritiqueResult; voided: number; canaryCaught: boolean; trusted: boolean; spend: Spend }
  | { ok: false; judge: string; reason: string; spend: Spend };

const Score = z.number().min(0).max(10);

/** What the judge is asked for: the scorer's reply shape, with the pass fixed, every finding located and tags closed. */
const passSchema = (pass: Pass) =>
  z.strictObject({
    pass: z.literal(pass),
    findings: z.array(
      z.strictObject({
        cell: z.strictObject({ beat: z.string().min(1), t: z.number().nonnegative() }),
        problem: z.string().min(1),
        change: z.string().min(1),
        tags: z.array(z.enum(CAP_TAGS)),
        severity: z.number().int().min(1).max(5),
      }),
    ),
    scores: z.strictObject({ design: Score, clarity: Score, idea: Score, content: Score }),
  });

type PassReply = z.infer<ReturnType<typeof passSchema>>;

interface PassCall {
  pass: Pass;
  images: readonly string[];
  names: readonly string[];
  cells: readonly SheetCellRef[];
}

function passPrompt(rubric: string, call: PassCall): string {
  const sheets = call.names.map((name, i) => `${i + 1}. ${name}`).join("\n");
  const cells = call.cells.map((c) => `- beat \`${c.beat}\`, t ${c.t}`).join("\n");
  return `${rubric}\n\n## Sheets, in the order attached\n\n${sheets}\n\n## Cells\n\n${cells}\n\n## This call\n\nPass: ${call.pass}\n`;
}

const callPass = (harness: JudgeHarness, rubric: string, call: PassCall): Promise<JudgeReply<PassReply>> =>
  harness({ prompt: passPrompt(rubric, call), schema: passSchema(call.pass), images: call.images });

const onSheet = (cells: readonly SheetCellRef[]) => (finding: PassReply["findings"][number]): boolean =>
  cells.some((c) => c.beat === finding.cell.beat && Math.abs(c.t - finding.cell.t) <= CELL_T_TOLERANCE_S);

/** The image analogue of the verbatim-quote void: a finding that points at no cell on the sheets never counts. */
function voidOffSheet(reply: PassReply, cells: readonly SheetCellRef[]): { reply: PassReply; voided: number } {
  const findings = reply.findings.filter(onSheet(cells));
  return { reply: { ...reply, findings }, voided: reply.findings.length - findings.length };
}

function caughtCanary(reply: PassReply): boolean {
  return voidOffSheet(reply, [CANARY_CELL]).reply.findings.some((f) => f.tags.includes(CANARY_TAG));
}

function assertRunnable(input: SheetCritiqueInput): void {
  if (input.judge.model === input.scriptModel) {
    throw new Error(`the sheet judge must differ from the writer: script model "${input.scriptModel}" and judge "${input.judge.model}" are the same model`);
  }
  if (input.sheets.length === 0) throw new Error("sheet critique needs at least one sheet");
}

type Judged = { replies: JudgeReply<PassReply>[] } & ({ failed: string } | { outputs: PassReply[] });

/** Runs every pass in order, then the canary; the first failed call ends the run, so no partial score exists. */
async function judgeAll(input: SheetCritiqueInput, rubric: string): Promise<Judged> {
  const names = input.sheets.map((sheet) => basename(sheet));
  const calls: PassCall[] = [
    ...CRITIQUE_PASSES.map((pass) => ({ pass, images: input.sheets, names, cells: input.cells })),
    { pass: CANARY_PASS, images: [CANARY_PNG], names: [CANARY_SHEET_NAME], cells: [CANARY_CELL] },
  ];
  const replies: JudgeReply<PassReply>[] = [];
  for (const call of calls) {
    const reply = await callPass(input.harness, rubric, call);
    replies.push(reply);
    if (!reply.ok) return { failed: `${call.pass} call failed: ${reply.reason}`, replies };
  }
  return { outputs: replies.flatMap((r) => (r.ok ? [r.output] : [])), replies };
}

/**
 * Four fixed passes over every chapter sheet, then a fifth call on a planted-glow still. A judge that misses the
 * glow is not trusted. Findings that name no listed cell are voided and counted; the rest feed `critiqueScore`.
 */
export async function runSheetCritique(input: SheetCritiqueInput): Promise<SheetCritiqueResult> {
  assertRunnable(input);
  const judge = judgeLabel(input.judge);
  const run = await judgeAll(input, input.rubric ?? readRubric(RUBRIC_FILE));
  const spend = sumSpend(run.replies);
  if ("failed" in run) return { ok: false, judge, reason: run.failed, spend };
  const passes = run.outputs.slice(0, CRITIQUE_PASSES.length).map((reply) => voidOffSheet(reply, input.cells));
  const caught = caughtCanary(run.outputs[CRITIQUE_PASSES.length]!);
  const voided = passes.reduce((sum, p) => sum + p.voided, 0);
  return { ok: true, judge, score: critiqueScore(passes.map((p) => p.reply)), voided, canaryCaught: caught, trusted: caught, spend };
}
