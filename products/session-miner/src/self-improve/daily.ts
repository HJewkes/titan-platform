import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mapItems, type MapResult, type WorkflowContext, type WorkflowFn } from "@titan-design/workflow";
import { z } from "zod";
import { isRecord } from "@titan-design/rpc-protocol/narrow";
import type { PromptFamily } from "./families.js";

export const DAILY_WORKFLOW = "self-improve-daily";
export const SUMMARY_FILE = "summary.json";

/** The shell runner's layout: the family prompt, a separator line, then the chunk. */
const TEMPLATE = "{{SI_PROMPT}}\n\nINPUT FOLLOWS.\n\n{{SI_CHUNK}}";

export interface ChunkFile {
  family: string;
  /** The file name without `.txt`; written on every row as `_chunk`. */
  name: string;
  path: string;
}

interface ClassifyItem {
  chunk: string;
  text: string;
  /** Of the prompt and the chunk, so editing either re-runs that chunk and nothing else. */
  hash: string;
}

const perFamily = z.record(z.string(), z.number());

export const DailySummarySchema = z.object({
  rows: perFamily,
  unparsed: perFamily,
  cost: perFamily,
  skipped: z.array(z.object({ chunk: z.string(), reason: z.string() })),
  failed: z.array(z.object({ chunk: z.string(), error: z.string() })),
  spentUsd: z.number(),
});

export type DailySummary = z.infer<typeof DailySummarySchema>;

interface FamilyOutcome {
  family: PromptFamily;
  map: MapResult<ClassifyItem>;
}

/** `<family>_<n>.txt` files of the known families, sorted by file name as the shell collector sorted its results. */
export function listChunks(dir: string, families: readonly PromptFamily[]): ChunkFile[] {
  const ids = new Set(families.map((family) => family.id));
  return readdirSync(dir)
    .filter((file) => file.endsWith(".txt"))
    .sort()
    .flatMap((file) => {
      const name = file.slice(0, -".txt".length);
      const family = name.replace(/_\d+$/, "");
      return family !== name && ids.has(family) ? [{ family, name, path: path.join(dir, file) }] : [];
    });
}

export function promptPath(promptsDir: string, family: PromptFamily): string {
  return path.join(promptsDir, `${family.id}.md`);
}

/** Classifies every chunk once per run; a replay after a kill reuses each finished chunk from the record. */
export function dailyWorkflow(families: readonly PromptFamily[]): WorkflowFn {
  return async (ctx) => {
    const param = (key: string) => ctx.param(key) ?? "";
    const chunks = listChunks(param("chunks"), families);
    let remainingUsd = Number(param("maxBudgetUsd"));
    const outcomes: FamilyOutcome[] = [];
    for (const family of families) {
      const files = chunks.filter((chunk) => chunk.family === family.id);
      if (files.length === 0) continue;
      const prompt = readFileSync(promptPath(param("prompts"), family), "utf8").trimEnd();
      const map = await classifyFamily(ctx, family, prompt, files.map((file) => chunkItem(prompt, file)), remainingUsd);
      remainingUsd -= map.spentUsd;
      outcomes.push({ family, map });
    }
    writeOutputs(param("out"), outcomes);
  };
}

function chunkItem(prompt: string, file: ChunkFile): ClassifyItem {
  const text = readFileSync(file.path, "utf8");
  const hash = createHash("sha256").update(prompt).update("\0").update(text).digest("hex").slice(0, 16);
  return { chunk: file.name, text, hash };
}

/** Holds back one call's ceiling, so a launch never starts that could carry the run past its budget. */
function classifyFamily(ctx: WorkflowContext, family: PromptFamily, prompt: string, items: ClassifyItem[], remainingUsd: number): Promise<MapResult<ClassifyItem>> {
  return mapItems(ctx, `${family.id}:classify`, items, (item, stepId, step) => step.dispatch(stepId, TEMPLATE, { vars: { SI_PROMPT: prompt, SI_CHUNK: item.text } }), {
    key: (item) => `${item.chunk}:${item.hash}`,
    budgetUsd: remainingUsd - family.callBudgetUsd,
  });
}

/** An answer that is not a `{ rows }` object counts as one unparsed row; a row its family schema refuses counts as one. */
export function parseRows(output: string | undefined, family: PromptFamily): { rows: Record<string, unknown>[]; unparsed: number } {
  const answer = parseJson(output);
  if (!isRecord(answer) || !Array.isArray(answer.rows)) return { rows: [], unparsed: 1 };
  const rows = answer.rows.filter((row): row is Record<string, unknown> => family.row.safeParse(row).success);
  return { rows, unparsed: answer.rows.length - rows.length };
}

function parseJson(output: string | undefined): unknown {
  try {
    return JSON.parse(output ?? "");
  } catch {
    return undefined;
  }
}

function writeOutputs(outDir: string, outcomes: FamilyOutcome[]): void {
  mkdirSync(outDir, { recursive: true });
  const summary: DailySummary = { rows: {}, unparsed: {}, cost: {}, skipped: [], failed: [], spentUsd: 0 };
  for (const { family, map } of outcomes) {
    const rows = familyRows(family, map, summary);
    if (rows.length > 0) writeFileSync(path.join(outDir, `${family.id}.jsonl`), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  }
  writeFileSync(path.join(outDir, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
}

/** Model keys stay in the order the model sent them, with `_chunk` last. */
function familyRows(family: PromptFamily, map: MapResult<ClassifyItem>, summary: DailySummary): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  let unparsed = 0;
  for (const { item, result } of map.results) {
    const parsed = parseRows(result.output, family);
    rows.push(...parsed.rows.map((row) => ({ ...row, _chunk: item.chunk })));
    unparsed += parsed.unparsed;
  }
  summary.rows[family.id] = rows.length;
  summary.unparsed[family.id] = unparsed;
  summary.cost[family.id] = Math.round(map.spentUsd * 1000) / 1000;
  summary.spentUsd = Math.round((summary.spentUsd + map.spentUsd) * 1e6) / 1e6;
  summary.skipped.push(...map.skipped.map(({ item }) => ({ chunk: item.chunk, reason: map.stoppedBy ?? "unknown" })));
  summary.failed.push(...map.failed.map(({ item, error }) => ({ chunk: item.chunk, error })));
  return rows;
}
