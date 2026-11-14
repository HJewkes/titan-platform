import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { laneClaims, parseLedgerJson } from "@titan-design/dispatch-ledger";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { z } from "zod";

/*
 * The compare's reads (TP-5755 S9): shadow day files, the agent-chat events database and the burndown ledger. Every
 * read is read-only; the events database is opened `readonly`, so even a bug here cannot write, migrate or vacuum it.
 * The spawn shape mirrors session-miner's `read-events.ts`, which is another product's source and so is not imported.
 */

const RowLane = z.object({ initiative: z.string(), tag: z.string().nullable().catch(null) });

/** Tolerant on purpose: later slices add fields and reason codes, and none of them may break the compare. */
const ShadowRowIn = z.looseObject({
  kind: z.string(),
  wake: z.string(),
  at: z.string(),
  lane: RowLane.optional(),
  task: z.string().nullable().optional(),
  stage: z.string().optional(),
  codes: z.array(z.string()).optional(),
  rank: z.number().optional(),
  bet: z.string().optional(),
  basis: z.string().optional(),
  relaxed: z.array(z.string()).optional().catch(undefined),
});

export type ShadowRowRead = z.infer<typeof ShadowRowIn>;

export interface ShadowDayRead {
  rows: ShadowRowRead[];
  /** Lines that were not JSON or lacked `kind`, `wake` or `at`; counted so a damaged file is visible. */
  badLines: number;
}

const priorDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function parseLine(line: string): ShadowRowRead | undefined {
  try {
    const parsed = ShadowRowIn.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readDayFile(file: string): ShadowDayRead {
  if (!existsSync(file)) return { rows: [], badLines: 0 };
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  const rows = lines.map(parseLine).filter((row) => row !== undefined);
  return { rows, badLines: lines.length - rows.length };
}

/** The day's rows and the day before's, so a spawn just after midnight still has a latest prior wake. */
export function readShadowDays(dir: string, day: string): { day: ShadowDayRead; prior: ShadowDayRead } {
  return { day: readDayFile(join(dir, `${day}.jsonl`)), prior: readDayFile(join(dir, `${priorDay(day)}.jsonl`)) };
}

/** `$AGENT_CHAT_HOME`, else `~/.agent-chat`, as `cli-scorecard.ts` resolves it. */
export function agentChatHome(env: NodeJS.ProcessEnv): string {
  return env.AGENT_CHAT_HOME || join(env.HOME || homedir(), ".agent-chat");
}

export function openEventsDb(file: string): Db {
  return openDatabase(file, { readonly: true, foreignKeys: false });
}

const SpawnRecord = z.object({ ts: z.number(), target: z.string().nullable(), meta: z.string().nullable() });

const SpawnMeta = z.looseObject({
  task: z.string().min(1).optional().catch(undefined),
  role: z.string().optional().catch(undefined),
  briefing: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
});

export interface SpawnRead {
  ts: number;
  name: string | null;
  task: string | null;
  role: string | null;
  briefing: string | null;
}

function parseMeta(meta: string | null): z.infer<typeof SpawnMeta> {
  try {
    const parsed = SpawnMeta.safeParse(JSON.parse(meta ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The operator's spawns in `[fromMs, toMs)`, keyed on the row's `actor`: `meta.launched_by` is null on recent rows. */
export function readOperatorSpawns(db: Db, operator: string, fromMs: number, toMs: number): SpawnRead[] {
  const sql = "SELECT ts, target, meta FROM events WHERE kind = 'agent_spawned' AND actor = ? AND ts >= ? AND ts < ? ORDER BY ts, id";
  return db
    .prepare(sql)
    .all(operator, fromMs, toMs)
    .map((raw) => {
      const record = SpawnRecord.parse(raw);
      const meta = parseMeta(record.meta);
      return { ts: record.ts, name: meta.name ?? record.target, task: meta.task ?? null, role: meta.role ?? null, briefing: meta.briefing || null };
    });
}

export interface LedgerPick {
  task: string;
  at: number;
}

/** Lane claims the operator's seat holds, as canonical keys; an absent ledger reads as none. */
export function readLedgerPicks(file: string, operator: string): LedgerPick[] {
  if (!existsSync(file)) return [];
  return laneClaims(parseLedgerJson(readFileSync(file, "utf8")))
    .filter((claim) => claim.seat === operator)
    .map((claim) => ({ task: `${claim.initiative}/${claim.taskId}`, at: Date.parse(claim.spawnedAt) }));
}
