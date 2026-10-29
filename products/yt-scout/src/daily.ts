import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { appendRow, writeCase, type StepRow } from "./step-rows.js";

const ASKER = "yt-scout";
const DAILY_KEY = "yt-scout-daily";
const VERDICTS = ["over", "under", "miss", "bad-why"] as const;
type Verdict = (typeof VERDICTS)[number];
const isVerdict = (s: string): s is Verdict => VERDICTS.some((v) => v === s);
const Marker = z.object({ itemId: z.string() });

export interface DailyCard {
  id: string;
  title: string;
  sourceName: string;
  durationMinutes: number | null;
  partial: boolean;
  actionable: number;
  novelty: number;
  evidence: number;
  total: number;
  summary: string;
  techniques: { ts: string; what: string }[];
  prompt_sha: string;
  model: string;
  transcriptPath: string;
  inputSha: string;
  digestPath?: string;
}

export interface DailyStats {
  failed: number;
  spendUsd: number;
}

export interface ConsoleResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `titan-console <args>`; the real one shells out, tests record the calls. */
export type ConsoleRunner = (args: string[], stdin?: string) => Promise<ConsoleResult>;

export interface DailyDeps {
  runner: ConsoleRunner;
  /** Cards scored in the last 24 h. */
  cards(): Promise<DailyCard[]>;
  /** Any card by id, since yesterday's picks were scored outside today's window. */
  findCard(id: string): Promise<DailyCard | undefined>;
  stats(): Promise<DailyStats>;
  /** The owner's answer text to the item filed under `depositId`, if any. */
  readAnswer(depositId: string): Promise<string | undefined>;
  casesDir: string;
  rowsDir: string;
  stateDir: string;
  runId: string;
  workflowVersion: string;
  now?: () => Date;
}

type DailyOutcome = { outcome: "filed"; itemId: string } | { outcome: "skip"; reason?: "already-filed"; itemId?: string };

export function rankCards(cards: DailyCard[]): DailyCard[] {
  return [...cards].sort((a, b) => b.total - a.total || b.actionable - a.actionable || b.evidence - a.evidence || a.id.localeCompare(b.id));
}

function pickCards(ranked: DailyCard[], top: number): DailyCard[] {
  return ranked.filter((c, i) => i < top || c.digestPath !== undefined);
}

function seconds(ts: string): number | undefined {
  const m = /^\[?(?:(\d+):)?(\d+):(\d{2})\]?$/.exec(ts);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

function renderPick(n: number, c: DailyCard): string[] {
  const top = c.techniques[0];
  const why = top ? `${c.summary} ${top.what}` : c.summary;
  const length = c.durationMinutes === null ? "" : `, ${c.durationMinutes} min`;
  const t = top ? seconds(top.ts) : undefined;
  const link = `https://youtu.be/${c.id}${t === undefined ? "" : `?t=${t}`}`;
  return [`${n}. ${c.title} (${c.sourceName}${length}, ${c.total}/15) – ${why}`, `   ${link}${c.digestPath ? `  digest: ${c.digestPath}` : ""}`];
}

export function renderDeposit(day: string, cards: DailyCard[], stats: DailyStats, top = 3): Record<string, unknown> {
  const picks = pickCards(rankCards(cards), top);
  const digested = picks.filter((c) => c.digestPath !== undefined).length;
  const lines = [
    ...picks.flatMap((c, i) => renderPick(i + 1, c)),
    "",
    `Also scored: ${cards.length - picks.length}. Failed: ${stats.failed}. Spend: $${stats.spendUsd.toFixed(2)}.`,
    "Reply 'over <id>', 'under <id>', 'miss <id>' or 'bad-why <id>' to file an eval case.",
  ];
  return {
    depositId: depositIdFor(day),
    asker: ASKER,
    kind: "know",
    door: "two-way",
    summary: `AI video scout ${day.slice(5)}: ${picks.length} picks of ${cards.length} new (${digested} digested)`,
    context: lines.join("\n"),
    unblocksNow: "your read of today's AI video picks; reply 'over <id>' to file an eval case",
    keys: [DAILY_KEY, `${DAILY_KEY}-${day}`],
  };
}

const depositIdFor = (day: string): string => `${ASKER}-${day}`;

export function parseAnswer(text: string): { verdict: Verdict; id: string }[] {
  const found: { verdict: Verdict; id: string }[] = [];
  for (const line of text.split("\n")) {
    const m = new RegExp(`^\\s*(${VERDICTS.join("|")})\\s+([A-Za-z0-9_-]{11})\\b`, "i").exec(line);
    const verdict = m?.[1]?.toLowerCase();
    if (m && verdict !== undefined && isVerdict(verdict)) found.push({ verdict, id: m[2]! });
  }
  return found;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const previousDay = (day: string): string => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000));

async function filesCasesFromAnswer(deps: DailyDeps, yesterday: string): Promise<void> {
  const answer = await deps.readAnswer(depositIdFor(yesterday));
  if (answer === undefined) return;
  for (const { verdict, id } of parseAnswer(answer)) {
    const card = await deps.findCard(id);
    if (!card) continue;
    writeCase(deps.casesDir, {
      step: "score",
      video_id: id,
      label: verdict,
      inputs: { transcript_path: card.transcriptPath, transcript_sha256: card.inputSha, title: card.title, partial: card.partial },
      prompt_sha: card.prompt_sha,
      model: card.model,
      output: { actionable: card.actionable, novelty: card.novelty, evidence: card.evidence, total: card.total, summary: card.summary },
    });
  }
}

function dailyRow(deps: DailyDeps, startedAt: Date, outcome: "ok" | "skip"): StepRow {
  return {
    v: 1,
    run_id: deps.runId,
    workflow_version: deps.workflowVersion,
    video_id: "",
    source: null,
    step: "daily",
    attempt: 1,
    started_at: startedAt.toISOString(),
    ms: (deps.now?.() ?? new Date()).getTime() - startedAt.getTime(),
    outcome,
    error_class: null,
    model: "",
    prompt_sha: "",
    rubric_sha: "",
    input_sha: "",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_estimate: true,
    output_path: null,
  };
}

async function consoleOrThrow(deps: DailyDeps, args: string[], stdin?: string): Promise<string> {
  const res = await deps.runner(args, stdin);
  if (res.code !== 0) throw new Error(`titan-console ${args.slice(0, 2).join(" ")} exited ${res.code}: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

const markerFile = (deps: DailyDeps, day: string): string => path.join(deps.stateDir, `daily-${day}.json`);

export async function runDaily(deps: DailyDeps): Promise<DailyOutcome> {
  const startedAt = (deps.now ?? (() => new Date()))();
  const day = dayOf(startedAt);
  const marker = markerFile(deps, day);
  if (existsSync(marker)) {
    appendRow(deps.rowsDir, dailyRow(deps, startedAt, "skip"));
    return { outcome: "skip", reason: "already-filed", itemId: Marker.parse(JSON.parse(readFileSync(marker, "utf8"))).itemId };
  }
  await filesCasesFromAnswer(deps, previousDay(day));
  const cards = await deps.cards();
  if (cards.length === 0) {
    appendRow(deps.rowsDir, dailyRow(deps, startedAt, "skip"));
    return { outcome: "skip" };
  }
  const deposit = renderDeposit(day, cards, await deps.stats());
  await consoleOrThrow(deps, ["inbox", "withdraw-matching", "--as", ASKER, "--actor", ASKER, "--key", DAILY_KEY, "--reason", "obsolete"]);
  const itemId = await consoleOrThrow(deps, ["inbox", "file", "-"], JSON.stringify(deposit));
  mkdirSync(deps.stateDir, { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ itemId })}\n`);
  appendRow(deps.rowsDir, dailyRow(deps, startedAt, "ok"));
  return { outcome: "filed", itemId };
}
