import type { CompareReport } from "./compare.js";

/*
 * The day's `## <day>` section of COMPARE.md. A re-run replaces its own section in place, so the file holds one section
 * per day however often the compare runs.
 */

const pct = (rate: number | null): string => (rate === null ? "n/a" : `${Math.round(rate * 100)}%`);

/** Top reason codes behind operator-only picks, most frequent first, ties by code. */
function topReasonCodes(report: CompareReport, limit = 5): [string, number][] {
  const counts = new Map<string, number>();
  for (const entry of report.operatorOnly) for (const code of entry.codes.length > 0 ? entry.codes : [entry.shadowVerdict]) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit);
}

function headline(report: CompareReport): string {
  if (report.wakes === 0) return "No shadow wakes on this day: nothing to compare.";
  if (report.unreadableWakes === report.wakes) return `Shadow could not read the plan store on ${report.unreadableWakes} of ${report.wakes} wakes: no agreement is reported, because the shadow judged nothing.`;
  const { inTopK, of, k, unjudged } = report.agreement;
  const unread = report.unreadableWakes > 0 ? ` Shadow could not read the plan store on ${report.unreadableWakes} of ${report.wakes} wakes.` : "";
  const blind = unjudged > 0 ? ` ${unjudged} of ${of} picks came before any wake or at an unreadable one, so the shadow could not judge them.` : "";
  return `Agreement ${pct(report.agreement.rate)} (${inTopK} of ${of} operator picks in the shadow's top ${k}).${unread}${blind}`;
}

function operatorLine(report: CompareReport): string {
  const { counts, source } = report.operator;
  const found = `${counts.found} spawns found (${counts.withTask} with meta.task, ${counts.withoutTask} without)`;
  const dropped = `${counts.excludedByRole} excluded by role, ${counts.unresolved} unresolved, ${counts.outOfScope} outside the lanes`;
  return `- Operator \`${report.operator.seat}\`: ${found}, ${dropped}; ${report.operator.spawns} picks (${source.eventsDb} events, ${source.ledger} ledger).`;
}

function laneLines(report: CompareReport): string[] {
  return report.perLane.map((lane) => `  - ${lane.lane}: n=${lane.n}, in top K ${lane.inTopK}, agreement ${pct(lane.rate)}, would-dispatch ${lane.wouldDispatch}`);
}

export function renderSection(report: CompareReport): string {
  const codes = topReasonCodes(report);
  const lines = [
    `## ${report.day}`,
    "",
    headline(report),
    "",
    `- Wakes: ${report.wakes} (${report.unreadableWakes} unreadable)${report.badLines > 0 ? `, ${report.badLines} unparseable row(s)` : ""}`,
    operatorLine(report),
    `- Shadow-only picks: ${report.shadowOnly.length}. Operator-only picks: ${report.operatorOnly.length}.`,
    `- Strict vs relaxed would-dispatch: ${report.strictVsRelaxed.wouldDispatchStrict} vs ${report.strictVsRelaxed.wouldDispatchRelaxed}.`,
    "- Per lane:",
    ...laneLines(report),
    `- Top reason codes for operator-only picks: ${codes.length === 0 ? "none" : codes.map(([code, n]) => `\`${code}\` ${n}`).join(", ")}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** The file with the day's section replaced, or appended when the day has none yet. */
export function upsertSection(markdown: string, day: string, section: string): string {
  const parts = markdown.split(/^(?=## )/m);
  const at = parts.findIndex((part) => part.startsWith(`## ${day}\n`) || part === `## ${day}`);
  if (at >= 0) {
    parts[at] = `${section}\n`;
    return parts.join("").replace(/\n+$/, "\n");
  }
  const head = markdown === "" ? "# Dispatcher shadow vs operator\n\n" : `${markdown.replace(/\n+$/, "")}\n\n`;
  return `${head}${section}`;
}
