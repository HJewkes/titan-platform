import type { WorkflowRun } from "@titan-design/workflow";
import { FollowUpSchema, type FollowUp } from "@titan-design/review-panel";
import { z } from "zod";
import { parseIsoMs } from "../time-iso.js";
import { inRange, isoWeek, payloadOf, stepName, type StatsRange } from "./stats.js";

interface NitRow {
  /** An ISO week such as `2026-W46`, or `before` / `after` for the nit policy's cutoff. */
  label: string;
  /** Verdicts whose text the ledger kept: a FIX_FIRST's findings; a MERGE's text lives with the reviewer, not here. */
  verdicts: number;
  textChars: number;
  nitChars: number;
  /** `nitChars / textChars` to three places; null when no verdict text was kept. */
  share: number | null;
  /** Low-severity follow-ups that read as cosmetic, from every verdict, kept text or not. */
  cosmeticFollowUps: number;
}

interface NitStats {
  weeks: NitRow[];
  policy: NitRow[];
}

/** The day TP-6471's nit policy (#3856) merged: verdicts from then on are `after`. */
export const NIT_POLICY_MERGED = "2026-11-15T09:36:29Z";

const NIT_HEADING = /\b(nits?|pre-?existing|cosmetic)\b/i;
const HEADING_LINE = /^\s*(#{1,6}\s|\*\*[^*]+\*\*:?\s*$|[A-Za-z][\w /-]*:\s*$)/;
const COSMETIC = /\b(typos?|wording|naming|renam\w*|comments?|whitespace|formatting|style|cosmetic|nits?)\b/i;

/** Characters of `text` under a heading that names nits, pre-existing behaviour or cosmetics, up to the next heading. */
function nitChars(text: string): number {
  let inNit = false;
  let total = 0;
  for (const line of text.split(/(?<=\n)/)) {
    if (HEADING_LINE.test(line)) inNit = NIT_HEADING.test(line);
    if (inNit) total += line.length;
  }
  return total;
}

const isCosmetic = (item: FollowUp): boolean => item.severity === "low" && COSMETIC.test(`${item.title} ${item.doneWhen}`);

interface Verdict {
  at: number;
  text?: string;
  followUps: FollowUp[];
}

function verdictsOf(run: WorkflowRun): Verdict[] {
  return Object.entries(run.stepResults).flatMap(([key, result]) => {
    const payload = payloadOf(result);
    if (stepName(key) !== "sh-await-verdict" || payload.kind !== "verdict") return [];
    const followUps = z.array(FollowUpSchema).safeParse(payload.followUps);
    return [{ at: parseIsoMs(result.completedAt), ...(typeof payload.text === "string" && { text: payload.text }), followUps: followUps.success ? followUps.data : [] }];
  });
}

const emptyRow = (label: string): NitRow => ({ label, verdicts: 0, textChars: 0, nitChars: 0, share: null, cosmeticFollowUps: 0 });

function add(row: NitRow, verdict: Verdict): void {
  if (verdict.text !== undefined) {
    row.verdicts++;
    row.textChars += verdict.text.length;
    row.nitChars += nitChars(verdict.text);
  }
  row.cosmeticFollowUps += verdict.followUps.filter(isCosmetic).length;
}

const finish = (row: NitRow): NitRow => ({ ...row, share: row.textChars === 0 ? null : Math.round((row.nitChars / row.textChars) * 1000) / 1000 });

/** Per ISO week, and before and after `cutoffMs`: the share of verdict text under nit headings and the cosmetic low follow-ups filed. */
export function nitStats(runs: readonly WorkflowRun[], cutoffMs: number, range: StatsRange = {}): NitStats {
  const weeks = new Map<string, NitRow>();
  const policy = { before: emptyRow("before"), after: emptyRow("after") };
  for (const verdict of runs.flatMap(verdictsOf)) {
    if (!inRange(verdict.at, range)) continue;
    const week = isoWeek(verdict.at);
    const row = weeks.get(week) ?? emptyRow(week);
    weeks.set(week, row);
    add(row, verdict);
    add(verdict.at < cutoffMs ? policy.before : policy.after, verdict);
  }
  const seen = [policy.before, policy.after].filter((row) => row.verdicts > 0 || row.cosmeticFollowUps > 0);
  return { weeks: [...weeks.values()].sort((a, b) => a.label.localeCompare(b.label)).map(finish), policy: seen.map(finish) };
}

/** The human lines for `shepherd stats --nits`. */
export function formatNits({ weeks, policy }: NitStats): string[] {
  if (weeks.length === 0) return ["no verdicts in range"];
  const share = (row: NitRow): string => (row.share === null ? "n/a" : `${Math.round(row.share * 1000) / 10}%`);
  const line = (row: NitRow): string => `${row.label}  verdicts with text ${row.verdicts}  nit share ${share(row)}  cosmetic low follow-ups ${row.cosmeticFollowUps}`;
  return ["nit share of verdict text per ISO week:", ...weeks.map(line), "", "nit policy (TP-6471) before and after:", ...policy.map(line)];
}
