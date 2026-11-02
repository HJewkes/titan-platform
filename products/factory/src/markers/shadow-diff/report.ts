import type { FactEntry } from "../../registry/entry.js";
import { factRule, type PinClass } from "../../registry/pin-classes.js";
import type { ShadowLogRow } from "./log.js";

const GATED_FAMILIES = ["tree", "diff", "observed"] as const satisfies readonly PinClass[];
type GatedFamily = (typeof GATED_FAMILIES)[number];

const BLOCKING_KINDS: ReadonlySet<string> = new Set(["call-site-orphan", "shadow-error", "budget-exceeded"]);
const BLOCKING_CLASSES: ReadonlySet<string> = new Set(["false-hit", "unmarked"]);
// `unprobed` is a missing probe, which is never a pass.
const BLOCKING_CAUSES: ReadonlySet<string> = new Set(["unclassified", "unprobed"]);

interface FamilyCounts {
  classes: Record<string, number>;
  causes: Record<string, number>;
  /** False-hits that were materially valid but not fully valid: an under-declared material input (R23). */
  materialOnly: number;
}

interface ShadowReport {
  header: { rows: number; firstEntryEnd: string | null; families: GatedFamily[] };
  /** The stable input to F12 (D-M6-01) and D-M3-17. */
  counts: Record<GatedFamily, FamilyCounts>;
  blocking: ShadowLogRow[];
}

const inFamily = (row: ShadowLogRow): row is ShadowLogRow & { family: GatedFamily } => (GATED_FAMILIES as readonly (string | null)[]).includes(row.family);

function isBlocking(row: ShadowLogRow): boolean {
  if (BLOCKING_KINDS.has(row.kind)) return true;
  if (row.class !== null && BLOCKING_CLASSES.has(row.class)) return true;
  return row.class === "pin-differs" && (row.cause === null || BLOCKING_CAUSES.has(row.cause));
}

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

function tally(rows: readonly ShadowLogRow[]): Record<GatedFamily, FamilyCounts> {
  const counts = Object.fromEntries(GATED_FAMILIES.map((family) => [family, { classes: {}, causes: {}, materialOnly: 0 }])) as Record<GatedFamily, FamilyCounts>;
  for (const row of rows) {
    if (!inFamily(row) || row.class === null) continue;
    const family = counts[row.family];
    bump(family.classes, row.class);
    if (row.cause !== null) bump(family.causes, row.cause);
    if (row.class === "false-hit" && row.materialValid === true && row.fullValid === false) family.materialOnly += 1;
  }
  return counts;
}

/**
 * Counts and blocking rows over `[since, now]`. `firstEntryEnd` reads every row passed, not only the window, because the
 * gate asks how long the shadow has been on and a window-clipped answer could never reach the window's own length.
 */
export function shadowReport(rows: readonly ShadowLogRow[], window: { since: number; now: number }): ShadowReport {
  const windowed = rows.filter((row) => Date.parse(row.at) >= window.since && Date.parse(row.at) <= window.now);
  const firstEntryEnd = rows.filter((row) => row.kind === "entry-end").map((row) => row.at).sort()[0] ?? null;
  return {
    header: { rows: windowed.length, firstEntryEnd, families: [...GATED_FAMILIES] },
    counts: tally(windowed),
    blocking: windowed.filter(isBlocking),
  };
}

type FamilyStatus = "pass" | "blocked" | "vacuous";

interface GateResult {
  pass: boolean;
  reasons: string[];
  families: Record<GatedFamily, FamilyStatus>;
}

/** The gated families that some fact entry belongs to; the others are vacuous (O3). */
export function factFamiliesOf(entries: readonly FactEntry[]): Set<PinClass> {
  const families = new Set<PinClass>();
  for (const entry of entries) {
    const rule = factRule(entry.fact);
    if (rule) families.add(rule.pinClass);
  }
  return families;
}

const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((total, n) => total + n, 0);

function describe(row: ShadowLogRow): string {
  const head = typeof row.detail.carry === "object" && row.detail.carry !== null ? (row.detail.carry as { head?: unknown }).head : undefined;
  const cause = row.cause ? ` (${row.cause})` : "";
  return `${row.family ?? "unknown family"} ${row.class ?? row.kind}${cause}: run ${row.runId}${typeof head === "string" ? `, head ${head}` : ""}`;
}

/** Read-only: nothing here turns the shadow off; D-M3-26 does. */
export function shadowGate(report: ShadowReport, options: { windowMs: number; now: number; factFamilies: ReadonlySet<PinClass> }): GateResult {
  const reasons: string[] = [];
  const first = report.header.firstEntryEnd === null ? undefined : Date.parse(report.header.firstEntryEnd);
  if (first === undefined || options.now - first < options.windowMs) reasons.push("coverage: the shadow has not been on for the full window");
  const families = {} as Record<GatedFamily, FamilyStatus>;
  for (const family of GATED_FAMILIES) {
    if (!options.factFamilies.has(family)) {
      families[family] = "vacuous";
      continue;
    }
    const blockers = report.blocking.filter((row) => row.family === family);
    const empty = sum(report.counts[family].classes) === 0;
    families[family] = blockers.length > 0 || empty ? "blocked" : "pass";
    if (empty) reasons.push(`${family}: no compared rows`);
    reasons.push(...blockers.map(describe));
  }
  // An event with no fact entry has no family to excuse it, so it blocks outright.
  reasons.push(...report.blocking.filter((row) => row.family === null).map(describe));
  return { pass: reasons.length === 0, reasons, families };
}
