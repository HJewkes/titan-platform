import type { GateRecord } from "@titan-design/hitl";
import { badOutcomes, OUTCOME_WINDOW_MS, type OutcomeFacts } from "./audit-facts.js";
import type { JudgeVerdict } from "./audit-judge.js";

/** One sampled decision with everything the report says about it. */
export interface AuditItem {
  gate: GateRecord;
  class: string | undefined;
  prUrl: string | undefined;
  question: string;
  facts: OutcomeFacts;
  judge: JudgeVerdict;
}

export interface AuditHeader {
  week: string;
  seed: number;
  /** Owner-resolved gates in the week, before sampling. */
  population: number;
}

const HOUR_MS = 3_600_000;
const NO_CLASS = "unclassed";

export function waitHoursOf(gate: GateRecord): number {
  return Math.round(((Date.parse(gate.resolvedAt ?? gate.createdAt) - Date.parse(gate.createdAt)) / HOUR_MS) * 10) / 10;
}

function incidentsText(incidents: OutcomeFacts["incidents"]): string {
  if (incidents === "unknown") return "incidents unknown (none linked to merges yet)";
  return incidents.length === 0 ? "no linked incident" : `${incidents.length} incident(s): ${incidents.map((incident) => incident.at).join(", ")}`;
}

/** A window still open is reported as what was seen so far; only a closed window with every fact read is clean. */
function outcomeLine(item: AuditItem): string {
  const { facts } = item;
  const bad = badOutcomes(facts);
  const until = new Date(Date.parse(item.gate.resolvedAt ?? item.gate.createdAt) + OUTCOME_WINDOW_MS).toISOString();
  const status = !facts.windowClosed
    ? `window open until ${until}; ${bad.length > 0 ? `so far: ${bad.join(", ")}` : "nothing bad yet"}`
    : bad.length > 0
      ? `BAD: ${bad.join(", ")}`
      : facts.incidents === "unknown"
        ? "no revert or red main; incidents unknown"
        : "clean";
  return `- outcome (72 h): ${status}`;
}

function factsLine({ facts }: AuditItem): string {
  const merge = facts.merged ? `merged ${facts.mergeSha}` : "not merged";
  return `- facts: ${merge} · reverted ${facts.reverted ? "yes" : "no"} · main red ${facts.mainRed ? "yes" : "no"} · ${incidentsText(facts.incidents)}`;
}

function judgeLine({ judge }: AuditItem): string {
  return "unavailable" in judge ? `- judge: judge unavailable: ${judge.unavailable}` : `- judge: ${judge.stamp}: ${judge.note}`;
}

function itemBlock(item: AuditItem, index: number): string[] {
  const { gate } = item;
  const by = gate.resolvedBy ? `${gate.resolvedBy.class} ${gate.resolvedBy.id} via ${gate.resolvedBy.channel}` : "unrecorded";
  return [
    `### ${index + 1}. ${gate.id}`,
    "",
    `- class: ${item.class ?? NO_CLASS}${item.prUrl ? ` · PR: ${item.prUrl}` : ""}`,
    `- question: ${item.question}`,
    `- answer: ${item.facts.decision ?? "(no decision field)"} · by ${by} · waited ${waitHoursOf(gate)} h`,
    factsLine(item),
    outcomeLine(item),
    judgeLine(item),
    "",
  ];
}

/** Per class, the bad outcomes the sample found; the weekly report holds a demotion for any class listed here. */
export function badByClass(items: readonly AuditItem[]): Map<string, string[]> {
  const classes = new Map<string, string[]>();
  for (const item of items) {
    const bad = badOutcomes(item.facts);
    if (bad.length > 0) classes.set(item.class ?? NO_CLASS, [...(classes.get(item.class ?? NO_CLASS) ?? []), ...bad]);
  }
  return classes;
}

function summary(items: readonly AuditItem[]): string[] {
  const bad = [...badByClass(items)].sort(([a], [b]) => a.localeCompare(b));
  const open = items.filter((item) => !item.facts.windowClosed).length;
  return [
    "## Bad outcomes by class",
    "",
    ...(bad.length === 0 ? ["- none found in the sample"] : bad.map(([cls, outcomes]) => `- ${cls}: ${outcomes.join(", ")}`)),
    ...(open > 0 ? [`- ${open} item(s) still inside the 72 h window; rerun with --force after it closes`] : []),
    "",
  ];
}

/** The weekly audit file: header, one block per sampled decision, then the bad outcomes per class. */
export function renderAudit(header: AuditHeader, items: readonly AuditItem[]): string {
  return [
    `# Owner gate audit ${header.week}`,
    "",
    `- seed: ${header.seed} (sha256 of the week; the same week draws the same sample)`,
    `- owner-resolved gates in the week: ${header.population}; sampled: ${items.length}`,
    "",
    "## Sample",
    "",
    ...(items.length === 0 ? ["No owner-resolved gate in this week.", ""] : items.flatMap(itemBlock)),
    ...summary(items),
  ].join("\n");
}
