// The Decisions and ships log's twin answers: synthetic ships and by-rec rows, merged by the page's own pure functions.
import { createHash } from "node:crypto";
import { encodePng } from "@titan-design/png-delta";
import { BY_REC_POLICY_SCHEMA, BY_REC_RESOLVER, BY_REC_ROW_SCHEMA, byRecPolicySchema, type ByRecRow } from "@titan-design/owner-queue";
import { logHeader } from "../log-floor.js";
import { digestLine, logCounts, mergeLog, type LogRow, type ShipInput } from "../log-rows.js";
import type { LogView } from "../log-view.js";
import { answer, type TwinCall } from "./answers.js";
import { TWIN_NOW } from "./clock.js";

const HOUR = 3_600_000;
const iso = (hoursAgo: number): string => new Date(TWIN_NOW - hoursAgo * HOUR).toISOString();
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function ship(pr: number, task: string, hoursAgo: number, approval: ShipInput["approval"], rule?: string): ShipInput {
  return { repo: "orbit/relay", pr, task, url: `https://github.com/orbit/relay/pull/${pr}`, mergedAt: TWIN_NOW - hoursAgo * HOUR, approval, ...(rule && { rule }) };
}

function row(source: ByRecRow["subject"]["source"], id: string, summary: string, mode: ByRecRow["mode"], hoursAgo: number, facts: ByRecRow["facts"], rationale: string): ByRecRow {
  return {
    schema: BY_REC_ROW_SCHEMA, subject: { source, id, summary }, recommendation: { answer: source === "gate" ? "merge" : "keep", by: "relay-reviewer", rationale },
    openedAt: iso(hoursAgo + 24), resolvedAt: iso(hoursAgo), facts, mode, result: mode === "live" ? "resolved" : "would-resolve", resolver: { ...BY_REC_RESOLVER },
  };
}

const SHIPS = [ship(41, "OR-41", 1, "auto-by-rec"), ship(38, "OR-38", 3, "reviewer", "MRG-AU-RV"), ship(36, "OR-36", 6, "owner"), ship(33, "OR-33", 27, "plan", "plan-approval")];

const GATE_ROWS = [
  row("gate", "gate-41", "Merge orbit/relay#41", "live", 1.2, { repo: "orbit/relay", pr: 41, decisionClass: "D2" }, "Reviewer MERGE at head, CI green; the card spacing change matches its baseline."),
  row("gate", "gate-38", "Merge orbit/relay#38", "shadow", 3.5, { repo: "orbit/relay", pr: 38 }, "Reviewer MERGE at head, CI green, no hold."),
];

const CONSOLE_ROWS = [
  row("deposit", "dep-ceiling", "Keep the retry ceiling at 30 s?", "live", 2, {}, "No send has needed more than 12 s this week."),
  row("round", "kiln-schedule-r2#q1", "Which night does the kiln run?", "shadow", 26, { roundId: "kiln-schedule-r2" }, "Tuesday has the lowest load."),
];

const POLICY = byRecPolicySchema.parse({ schema: BY_REC_POLICY_SCHEMA, exclude: [{ field: "category", value: "naming", note: "names stay the owner's" }] });

function view(rows: LogRow[]): LogView {
  const days = [...new Set(rows.map((each) => each.day))].map((date) => ({ date, rows: rows.filter((each) => each.day === date) }));
  const counts = logCounts(rows);
  return { header: logHeader(POLICY, undefined), days, counts, digest: digestLine(counts), gaps: [], readAt: new Date(TWIN_NOW).toISOString() };
}

/** #41 is the visual gate: one changed card, a flat synthetic before and after. */
const FRAMES_41 = { repo: "orbit/relay", pr: 41, pairs: [{ key: "shot-0", label: "relay-card--compact@1280" }] };

function swatch(rgb: readonly [number, number, number]): Buffer {
  const rgba = new Uint8Array(16 * 9 * 4).map((_, at) => (at % 4 === 3 ? 255 : rgb[at % 4]!));
  return encodePng({ width: 16, height: 9, rgba });
}

function frameAnswer(side: "before" | "after", png: Buffer): TwinCall {
  const read = { contentType: "image/png" as const, bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), base64: png.toString("base64") };
  return answer("log.frame", { repo: "orbit/relay", pr: 41, key: "shot-0", side }, read);
}

const ALL = mergeLog({ ships: SHIPS, gateRows: GATE_ROWS, consoleRows: CONSOLE_ROWS, dayOf }).map((each) => (each.key === "orbit/relay#41" ? { ...each, frames: FRAMES_41 } : each));
const TODAY = ALL.filter((each) => each.day === dayOf(TWIN_NOW));

export const LOG_ANSWERS: readonly TwinCall[] = [
  answer("log.list", {}, view(ALL)),
  answer("log.list", { days: 1 }, view(TODAY)),
  frameAnswer("before", swatch([200, 200, 200])),
  frameAnswer("after", swatch([90, 140, 220])),
];
