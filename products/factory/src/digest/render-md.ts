import type { WaitingGate } from "../shepherd/waiting.js";
import type { FrictionDay } from "../shepherd/owner-friction.js";
import type { Ask, DigestModel, FlowStats, PoolLine, ProofFixture } from "./model.js";
import type { RankedDigest } from "./rank.js";

export const WORD_LIMIT = 400;
export const FULL_COMMAND = "titan-factory digest run --full";
const ASK_WORDS = 12;
const REASON_WORDS = 10;

export const wordCount = (text: string): number => text.split(/\s+/).filter((word) => word !== "").length;

function clip(text: string, words: number): string {
  const parts = text.split(/\s+/).filter((word) => word !== "");
  return parts.length <= words ? parts.join(" ") : `${parts.slice(0, words).join(" ")} ...`;
}

function age(since: string, now: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(since)) / 60_000));
  if (Number.isNaN(minutes)) return "unknown age";
  return minutes < 120 ? `${minutes}m` : minutes < 2880 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
}

const percent = (value: number | undefined): string => (value === undefined ? "?" : `${Math.round(value)}%`);

/** The busiest fresh pool, for the headline; a stale reading says nothing about now. */
function busiestPool(spend: readonly PoolLine[]): PoolLine | undefined {
  return spend.filter((p) => !p.stale && p.sevenDay !== undefined).sort((a, b) => b.sevenDay! - a.sevenDay!)[0];
}

export function deterministicHeadline(d: RankedDigest): string {
  const parts = [`${d.totals.needsYou} need you`, `${d.totals.merged} merged`, `${d.totals.stuck} stuck`];
  const pool = busiestPool(d.spend);
  if (pool) parts.push(`${pool.pool} pool ${percent(pool.sevenDay)} of week`);
  return parts.join(", ");
}

function section(title: string, lines: string[], empty: string): string[] {
  return ["", `## ${title}`, ...(lines.length > 0 ? lines : [empty])];
}

function askLine(ask: Ask, i: number): string {
  const parts = [clip(ask.text, ASK_WORDS), ...(ask.evidence ? [`evidence: ${ask.evidence}`] : []), ...(ask.command ? [`\`${ask.command}\``] : [])];
  return `${i + 1}. ${parts.join(" | ")}${ask.since ? ` | waiting since ${ask.since}` : ""} (${ask.source})`;
}

function needsYou(d: RankedDigest): string[] {
  const lines = d.needsYou.map(askLine);
  return section(`Needs you (${d.totals.needsYou})`, lines, "Nothing.");
}

function frictionLines(day: FrictionDay | undefined): string[] {
  if (day === undefined) return [];
  const waits = day.kinds.map((k) => `${k.kind} ${k.medianHours}/${k.maxHours}`);
  const wait = waits.length > 0 ? `Owner wait (median/max hours): ${waits.join(", ")}` : "Owner wait: none";
  return section("Owner friction", [`Owner touches ${day.day}: ${day.ownerTouches}`, wait], "");
}

function waitingLines(gates: readonly WaitingGate[] | undefined): string[] {
  if (gates === undefined) return [];
  return section("Waiting on you, oldest first", gates.map((g) => `- ${g.ageHours}h ${g.gateId} ${g.repo}#${g.pr}`), "");
}

function flowLines(flow: FlowStats | undefined): string[] {
  if (flow === undefined) return [];
  const p50 = flow.taskToMergeP50Hours === undefined ? "none" : `${flow.taskToMergeP50Hours}h`;
  const missing = flow.missing > 0 ? ` (${flow.missing} of ${flow.merged} merges missing a task date)` : "";
  const none = flow.unmeasured > 0 ? "not measured, the roster gives no end time for non-live implementers" : "none";
  const rate = flow.mergesPerSlotHour === undefined ? none : `${flow.mergesPerSlotHour} (${flow.merged} merges, ${flow.implementerHours} hours)`;
  return section("Flow", [`- Task to merge p50: ${p50}${missing}`, `- Merges per implementer slot-hour: ${rate}`], "");
}

function proofFixtureLines(fixtures: DigestModel["proofFixtures"], now: string): string[] {
  if (fixtures === undefined) return [];
  const line = (f: ProofFixture): string => `- ${f.ref}: ${f.gates.length > 0 ? f.gates.map((gate) => clip(gate, REASON_WORDS)).join("; ") : "no pending gate"} (${age(f.since, now)})`;
  return section("Proof fixtures (not counted above)", fixtures.map(line), "");
}

function body(d: RankedDigest): string[] {
  const spend = d.spend.map((p) => `- ${p.pool}: week ${percent(p.sevenDay)}, 5h ${percent(p.fiveHour)}${p.stale ? " (stale)" : ""}`);
  return [
    ...needsYou(d),
    ...section(`Merged (${d.totals.merged})`, d.merged.map((m) => `- ${m.ref}: ${clip(m.title, REASON_WORDS)}`), "Nothing merged."),
    ...section(`Stuck (${d.totals.stuck})`, d.stuck.map((s) => `- ${s.ref}: ${clip(s.reason, REASON_WORDS)} (${age(s.since, d.generatedAt)})`), "Nothing stuck."),
    ...section("Seats", d.seats.map((s) => `- ${s.seat}: ${s.dispatches} dispatches, $${s.usd.toFixed(2)}`), "No seats in the seat book."),
    ...section("Spend", spend, "No pool readings."),
    ...proofFixtureLines(d.proofFixtures, d.generatedAt),
    ...waitingLines(d.waiting),
    ...flowLines(d.flow),
    ...frictionLines(d.friction),
    ...(d.gaps.length > 0 ? section("Gaps", d.gaps.map((gap) => `- ${clip(gap, REASON_WORDS)}`), "") : []),
  ];
}

/** Sections in reading order; anything a cap hid is one closing line that names the command showing it. */
export function renderMarkdown(d: RankedDigest): string {
  const lines = [`# Owner digest ${d.slot.date} ${d.slot.hour}:00`, "", deterministicHeadline(d), "", `Since ${d.since}.`, ...body(d)];
  if (d.overflow > 0) lines.push("", `and ${d.overflow} more: \`${FULL_COMMAND}\``);
  return `${lines.join("\n")}\n`;
}
