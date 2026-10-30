import { bar, fit, formatAge, formatUsd, shortModel } from "./format.js";
import type { AccountStrip, AgentRow, Snapshot } from "./snapshot.js";
import type { UsageWindow } from "./inputs.js";

export type Tone = "plain" | "dim" | "ok" | "warn" | "bad" | "accent";

export interface Segment {
  text: string;
  tone: Tone;
}

export type Line = Segment[];

export interface FleetView {
  header: Line[];
  rows: Line[];
}

/** Two status-line redraws apart: older means the session is idle, not between turns. */
export const STATUS_LINE_STALE_MS = 120_000;
/** The oldest account reading agent-chat's own budget gate trusts. */
export const ACCOUNT_STALE_MS = 15 * 60_000;
/** A feed that has not printed for this long is reported, since every age it shows is then off. */
export const FEED_QUIET_MS = 60_000;

const NAME_WIDTH = 16;
/** Wide enough for `$999.99`, so a figure never runs into the context cell. */
const COST_WIDTH = 7;
const seg = (text: string, tone: Tone = "plain"): Segment => ({ text, tone });

function pctTone(pct: number): Tone {
  if (pct >= 90) return "bad";
  return pct >= 75 ? "warn" : "plain";
}

function windowCells(label: string, window: UsageWindow | null, nowMs: number): Segment[] {
  if (window === null) return [seg(` ${label} —`, "dim")];
  const resets = window.resetsAtMs !== null && window.resetsAtMs > nowMs ? ` ↻${formatAge(window.resetsAtMs - nowMs)}` : "";
  const tone = pctTone(window.usedPct);
  return [seg(` ${label} `), seg(bar(window.usedPct, 5), tone), seg(` ${Math.round(window.usedPct)}%`, tone), seg(resets, "dim")];
}

function accountLine(strip: AccountStrip, nowMs: number): Line {
  const name = [seg(strip.account, "accent"), seg(strip.agents > 0 ? ` ·${strip.agents}` : "", "dim")];
  if (strip.authFail) return [...name, seg("  AUTH-FAIL", "bad")];
  if (strip.readAtMs === null) return [...name, seg("  no reading", "dim")];
  const age = nowMs - strip.readAtMs;
  if (strip.stale || age > ACCOUNT_STALE_MS) return [...name, seg(`  STALE ${formatAge(age)}`, "warn")];
  return [...name, ...windowCells("5h", strip.fiveHour, nowMs), ...windowCells("7d", strip.sevenDay, nowMs)];
}

function summaryLine(snapshot: Snapshot, nowMs: number): Line {
  const count = (presence: AgentRow["presence"]) => snapshot.agents.filter((a) => a.presence === presence).length;
  const slots = snapshot.slots === null ? "slots ?" : `slots ${snapshot.slots.held}/${snapshot.slots.cap}`;
  const age = nowMs - snapshot.atMs;
  const asOf = age > FEED_QUIET_MS ? seg(`  feed quiet ${formatAge(age)}`, "warn") : seg(`  as of ${formatAge(age)}`, "dim");
  return [
    seg("fleet ", "accent"),
    seg(`${count("live")} live`, "ok"),
    seg(` · ${count("detached")} detached · ${count("exited")} exited  `, "dim"),
    seg(slots),
    asOf,
  ];
}

const DOT: Record<AgentRow["presence"], Segment> = {
  live: seg("● ", "ok"),
  detached: seg("◐ ", "warn"),
  exited: seg("○ ", "dim"),
};

function contextCells(row: AgentRow, nowMs: number): Segment[] {
  const context = row.context;
  if (context === null) return [seg(fit("—", 11), "dim")];
  if (context.source === "transcript") return [seg(fit(`${Math.round(context.k)}k tok`, 11))];
  const age = nowMs - context.atMs;
  const text = `${bar(context.pct, 6)}${String(Math.round(context.pct)).padStart(4)}%`;
  return age > STATUS_LINE_STALE_MS ? [seg(text, "dim")] : [seg(text, pctTone(context.pct))];
}

function costCell(row: AgentRow, nowMs: number): Segment {
  if (row.cost === null) return seg(`${" ".repeat(COST_WIDTH)}—`, "dim");
  const stale = nowMs - row.cost.atMs > STATUS_LINE_STALE_MS;
  return seg(` ${formatUsd(row.cost.usd).padStart(COST_WIDTH)}`, stale ? "dim" : "plain");
}

function statusTone(word: string): Tone {
  if (word === "BLOCKED" || word === "NEEDS_CONTEXT") return "bad";
  if (word === "DONE_WITH_CONCERNS") return "warn";
  return word === "DONE" ? "ok" : "plain";
}

function headLine(row: AgentRow, nowMs: number): Line {
  const tone = row.presence === "exited" ? "dim" : "plain";
  const word = row.report?.word ?? "—";
  return [
    DOT[row.presence],
    seg(fit(row.name, NAME_WIDTH), tone),
    seg(` ${fit(shortModel(row.model), 6)}`, "dim"),
    seg(` ${fit(row.account ?? "?", 8)}`, "accent"),
    seg(` ${fit(word, 9)} `, row.report === null ? "dim" : statusTone(word)),
    ...contextCells(row, nowMs),
    costCell(row, nowMs),
  ];
}

function detailLine(row: AgentRow, nowMs: number): Line {
  const parts = [row.task ?? row.profile, row.report?.pr ?? null, row.report === null ? null : `reported ${formatAge(nowMs - row.report.atMs)} ago`];
  return [seg(`  ${parts.filter((part) => part !== null).join(" · ")}`, "dim")];
}

/** The panel as toned text, one entry per terminal line. Ages are taken against `nowMs`, the drawing clock. */
export function fleetView(snapshot: Snapshot, nowMs: number): FleetView {
  const header = [summaryLine(snapshot, nowMs), ...snapshot.accounts.map((strip) => accountLine(strip, nowMs))];
  for (const error of snapshot.errors) header.push([seg(`! ${error}`, "bad")]);
  const rows = snapshot.agents.flatMap((row) => [headLine(row, nowMs), detailLine(row, nowMs)]);
  return { header, rows: rows.length > 0 ? rows : [[seg("No agents on the roster.", "dim")]] };
}
