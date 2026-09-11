import type { Json } from "./text.js";
import { asObject } from "./text.js";
import type { RecentObservedValue, RecentSessionReadError } from "./recent-types.js";
import type { RecentSourceLine } from "./recent-tail.js";

export function parseRecentRecord(line: RecentSourceLine, errors: RecentSessionReadError[]): Json | null {
  try {
    const value = asObject(JSON.parse(line.raw));
    if (!value) throw new TypeError("record is not an object");
    return value;
  } catch (error) {
    errors.push({ kind: "malformed_record", reason: messageOf(error), evidence: line.evidence });
    return null;
  }
}

export function observed(value: string, line: RecentSourceLine): RecentObservedValue<string> {
  return { status: "observed", value, evidence: line.evidence };
}

export function unknownValue(truncatedBefore: boolean, malformed: boolean): RecentObservedValue<string> {
  if (truncatedBefore) return { status: "unknown", reason: "outside_window" };
  if (malformed) return { status: "unknown", reason: "malformed_records" };
  return { status: "unknown", reason: "not_reported" };
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncate(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  if (maxChars === 1) return "…";
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

export function renderedValue(value: unknown): string {
  if (typeof value === "string") return oneLine(value);
  if (Array.isArray(value)) return value.map(renderedValue).filter(Boolean).join(" ");
  const object = asObject(value);
  if (object && typeof object.text === "string") return oneLine(object.text);
  try {
    return oneLine(JSON.stringify(value) ?? "");
  } catch {
    return "[unrenderable value]";
  }
}

export function withNativeOrdinal(line: RecentSourceLine, record: Json): RecentSourceLine {
  const ordinal = record.ordinal;
  if (typeof ordinal !== "number" || !Number.isFinite(ordinal)) return line;
  return { ...line, evidence: { ...line.evidence, nativeOrdinal: ordinal } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
