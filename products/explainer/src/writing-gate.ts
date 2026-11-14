import type { L0Check, L0Result } from "./eval-l0.js";
import { sentenceLengths, spokenText, type SpokenText } from "./lint-register.js";
import { ruleRow } from "./lint-text.js";
import { writingGatePolicy, type GateSeverity, type WritingGatePolicy } from "./writing-gate-policy.js";

const FIRST_PERSON = /\b(?:i|i['’](?:m|ve|ll|d)|me|my|mine|we|we['’](?:re|ve|ll|d)|us|our|ours)\b/gi;

/** One gate or hallmark row of the writing gate. A null value is one the text cannot carry (no sentence ends). */
export interface GateRow {
  id: string;
  value: number | null;
  threshold: number;
  severity: GateSeverity;
  pass: boolean;
  beats: string[];
}

interface GateBeat {
  id: string;
  spoken: string;
}

interface Shape {
  words: number;
  mean: number | null;
  longShare: number | null;
}

const mean = (xs: readonly number[]): number => xs.reduce((sum, x) => sum + x, 0) / xs.length;

function shapeOf(parsed: SpokenText, longWords: number): Shape {
  const lengths = sentenceLengths(parsed);
  if (!parsed.punctuated || lengths.length === 0) return { words: parsed.words.length, mean: null, longShare: null };
  return { words: parsed.words.length, mean: mean(lengths), longShare: lengths.filter((n) => n > longWords).length / lengths.length };
}

/** A row's severity at this length: every gate row only reports under the policy's minimum words. */
const severityAt = (severity: GateSeverity, words: number, minWords: number): GateSeverity => (words < minWords ? "report-only" : severity);

function judged(id: string, value: number | null, threshold: number, severity: GateSeverity, fails: boolean): GateRow {
  const pass = severity === "report-only" || value === null || !fails;
  return { id, value, threshold, severity, pass, beats: [] };
}

function shortRegisterRow(shape: Shape, policy: WritingGatePolicy): GateRow {
  const row = policy.gate["short-register"];
  const severity = severityAt(row.severity, shape.words, policy.minWords);
  const fails = shape.mean !== null && shape.longShare !== null && shape.mean < row.meanBelow && shape.longShare < row.longShareBelow;
  return judged("writing:short-register", shape.mean, row.meanBelow, severity, fails);
}

function floorRows(shape: Shape, policy: WritingGatePolicy): GateRow[] {
  const { "sentence-mean": meanRow, "long-share": longRow } = policy.gate;
  const longSeverity = severityAt(longRow.severity, shape.words, Math.max(policy.minWords, longRow.minWords));
  return [
    judged("writing:sentence-mean", shape.mean, meanRow.floor, severityAt(meanRow.severity, shape.words, policy.minWords), shape.mean !== null && shape.mean < meanRow.floor),
    judged("writing:long-share", shape.longShare, longRow.floor, longSeverity, shape.longShare !== null && shape.longShare < longRow.floor),
  ];
}

/** Words per beat, standard deviation over the mean; null under 3 beats. */
function beatLengthCv(beats: readonly GateBeat[]): number | null {
  const lengths = beats.map((beat) => spokenText([beat.spoken]).words.length);
  if (lengths.length < 3) return null;
  const m = mean(lengths);
  return m === 0 ? null : Math.sqrt(mean(lengths.map((n) => (n - m) ** 2))) / m;
}

function reportedRows(beats: readonly GateBeat[], parsed: SpokenText, policy: WritingGatePolicy): GateRow[] {
  const firstPerson = (1000 * (parsed.text.match(FIRST_PERSON)?.length ?? 0)) / Math.max(parsed.words.length, 1);
  return [
    judged("writing:first-person", firstPerson, 0, policy.gate["first-person"].severity, false),
    judged("writing:beat-length-cv", beatLengthCv(beats), 0, policy.gate["beat-length-cv"].severity, false),
  ];
}

/** The writing gate rows `eval writing` reports, thresholds and severities from `doctrine/writing-gate.json`. */
export function writingGateRows(beats: readonly GateBeat[], policy: WritingGatePolicy = writingGatePolicy()): GateRow[] {
  const parsed = spokenText(beats.map((beat) => beat.spoken));
  const shape = shapeOf(parsed, policy.longWords);
  return [shortRegisterRow(shape, policy), ...floorRows(shape, policy), ...reportedRows(beats, parsed, policy)];
}

/** A capped row: it fails past `max` at the policy's severity, and a report-only row never fails. */
export function cappedRow(id: string, value: number, cap: { severity: GateSeverity; max: number }, beats: readonly string[]): GateRow {
  const pass = cap.severity === "report-only" || value <= cap.max;
  return { id, value, threshold: cap.max, severity: cap.severity, pass, beats: pass ? [] : [...new Set(beats)] };
}

/** A gate row as an L0 row: report-only becomes a passing warning, since L0 knows only errors and warnings. */
export const gateL0Row = (row: GateRow): L0Result =>
  ruleRow(row.id, { value: row.value ?? 0, threshold: row.threshold, pass: row.pass, beats: row.beats, mode: "heuristic", severity: row.severity === "error" ? "error" : "warning" });

/** Q-V16: a script in the short register (short sentence mean and no long sentences) fails L0. */
export const writingGateCheck: L0Check = ({ script }) => {
  const parsed = spokenText(script.beats.map((beat) => beat.spoken));
  return [gateL0Row(shortRegisterRow(shapeOf(parsed, writingGatePolicy().longWords), writingGatePolicy()))];
};
