/**
 * `rounds sweep` (TP-3990): runs the structural rule (`round-supersede.ts`) over every round, then proposes the open
 * rounds a decisions file cites as answered or resolved. Prose matching is brittle and hiding a live ask is the worse
 * failure, so a citation is only ever a candidate: a dry run, the default, writes nothing at all, and only `apply`
 * withdraws a candidate, as `answered-elsewhere`. The decisions file is whatever the caller names; there is no default.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { withdrawSuperseded, type SupersedeOptions, type SupersedeOutcome } from "./round-supersede.js";
import { withdrawRound, type WithdrawResult } from "./round-withdraw.js";
import { readQueueRounds, statusOf } from "./rounds.js";

const MAX_DECISIONS_BYTES = 16 * 1024 * 1024;
const CITES_ANSWERED = /\b(answered|resolved)\b/i;

interface SupersededBy {
  by: string;
  targets: SupersedeOutcome[];
}

interface DecisionCandidate {
  id: string;
  /** 1-based line in the decisions file. */
  line: number;
  text: string;
  outcome: WithdrawResult["outcome"] | "would-withdraw" | "refused";
}

export interface SweepReport {
  applied: boolean;
  superseded: SupersededBy[];
  /** Null when no decisions file was named. */
  decisions: { file: string; candidates: DecisionCandidate[] } | null;
  gaps: string[];
}

interface SweepOptions extends SupersedeOptions {
  roundsDir: string;
  decisionsFile: string | null;
}

/** The id must stand alone, so `unit-r1` is not found inside `unit-r10`. */
const mentions = (line: string, id: string): boolean => new RegExp(`(^|[^A-Za-z0-9_-])${id}($|[^A-Za-z0-9_-])`).test(line);

/** The first line that names the round and calls it answered or resolved, or null. */
function decisionCitation(lines: readonly string[], id: string): { line: number; text: string } | null {
  const at = lines.findIndex((line) => CITES_ANSWERED.test(line) && mentions(line, id));
  const text = lines[at];
  return text === undefined ? null : { line: at + 1, text: text.trim() };
}

async function readDecisions(file: string): Promise<string[]> {
  const unreadable = () => failure(`sweep refused: the decisions file ${file} could not be read`, EXIT.NOINPUT);
  const stats = await stat(file).catch(() => Promise.reject(unreadable()));
  if (!stats.isFile() || stats.size > MAX_DECISIONS_BYTES) throw unreadable();
  return (await readFile(file, "utf8").catch(() => Promise.reject(unreadable()))).split(/\r?\n/);
}

async function sweepSupersedes(options: SweepOptions): Promise<{ superseded: SupersededBy[]; gaps: string[] }> {
  const { rounds, gaps } = await readQueueRounds({ dir: options.roundsDir });
  const superseded: SupersededBy[] = [];
  for (const { id, manifest } of rounds) {
    if (manifest.supersedes !== undefined) superseded.push({ by: id, targets: await withdrawSuperseded(options.roundsDir, id, manifest.supersedes, options) });
  }
  return { superseded, gaps };
}

async function openRoundIds(roundsDir: string): Promise<string[]> {
  const { rounds } = await readQueueRounds({ dir: roundsDir });
  const open = await Promise.all(rounds.map(async ({ id }) => ((await statusOf(path.join(roundsDir, id))) === "open" ? id : null)));
  return open.filter((id) => id !== null);
}

async function settle(roundsDir: string, id: string, { apply, now }: SupersedeOptions): Promise<DecisionCandidate["outcome"]> {
  if (!apply) return "would-withdraw";
  return (await withdrawRound(roundsDir, id, "answered-elsewhere", now).catch(() => null))?.outcome ?? "refused";
}

async function sweepDecisions(lines: readonly string[], options: SweepOptions): Promise<DecisionCandidate[]> {
  const candidates: DecisionCandidate[] = [];
  for (const id of await openRoundIds(options.roundsDir)) {
    const cited = decisionCitation(lines, id);
    if (cited !== null) candidates.push({ id, ...cited, outcome: await settle(options.roundsDir, id, options) });
  }
  return candidates;
}

/** The decisions file is read before anything is written, so one that cannot be read refuses the whole sweep. */
export async function sweepRounds(options: SweepOptions): Promise<SweepReport> {
  const resolved = { ...options, roundsDir: path.resolve(options.roundsDir) };
  const file = resolved.decisionsFile;
  const lines = file === null ? null : await readDecisions(file);
  const { superseded, gaps } = await sweepSupersedes(resolved);
  const decisions = file === null || lines === null ? null : { file, candidates: await sweepDecisions(lines, resolved) };
  return { applied: options.apply, superseded, decisions, gaps };
}
