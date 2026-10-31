import { gunzipSync, gzipSync } from "node:zlib";
import { isRecord } from "@titan-design/rpc-protocol/narrow";

/** Under GitHub's 1 MB per-job output limit, leaving room for the base job's second report. */
export const MAX_ENCODED_BYTES = 900_000;
export const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
const MAX_FAILURE_CHARS = 2048;
const MAX_ERROR_CHARS = 512;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** `reported` marks an error the exec side wrote itself, as opposed to a report that failed to arrive or decode. */
export type DecodedReport =
  | { ok: true; report: { testResults: unknown[] } }
  | { ok: false; error: string; reported: boolean };

export interface DecodeOptions {
  maxBytes?: number;
}

type UnknownRecord = Record<string, unknown>;

function pick(source: UnknownRecord, keys: readonly string[]): UnknownRecord {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function compactAssertion(assertion: unknown): UnknownRecord {
  if (!isRecord(assertion)) return {};
  const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
  const failureMessages = messages.filter((message) => typeof message === "string").map((message: string) => message.slice(0, MAX_FAILURE_CHARS));
  return { ...pick(assertion, ["fullName", "ancestorTitles", "title", "status"]), failureMessages };
}

function compactFile(file: unknown): UnknownRecord {
  if (!isRecord(file)) return {};
  const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
  return { ...pick(file, ["name", "status"]), assertionResults: assertions.map(compactAssertion) };
}

function pack(value: object): string {
  return gzipSync(JSON.stringify({ v: 1, ...value })).toString("base64");
}

/** A vitest JSON report reduced to the fields the classifier reads, gzipped and base64-encoded: no space, no newline. */
export function encodeReport(report: unknown): string {
  const files = isRecord(report) && Array.isArray(report.testResults) ? report.testResults : [];
  return pack({ testResults: files.map(compactFile) });
}

/** An encoded marker saying this side produced no report, carrying why; the judge turns it into a verdict error. */
export function encodeError(error: string): string {
  return pack({ error: error.slice(0, MAX_ERROR_CHARS) });
}

function inflate(text: string, maxBytes: number): unknown {
  if (text.length === 0) throw new Error("missing report");
  if (text.length > maxBytes) throw new Error(`report over ${maxBytes} bytes`);
  if (!BASE64.test(text)) throw new Error("report is not base64");
  const json = gunzipSync(Buffer.from(text, "base64"), { maxOutputLength: MAX_INFLATED_BYTES }).toString("utf-8");
  return JSON.parse(json);
}

type Envelope = { ok: true; payload: UnknownRecord } | { ok: false; error: string; reported: boolean };

function readEnvelope(payload: unknown): Envelope {
  if (!isRecord(payload) || payload.v !== 1) return { ok: false, error: "report has no v1 envelope", reported: false };
  if (typeof payload.error === "string") return { ok: false, error: payload.error.slice(0, MAX_ERROR_CHARS), reported: true };
  return { ok: true, payload };
}

function readPayload(raw: unknown): DecodedReport {
  const envelope = readEnvelope(raw);
  if (!envelope.ok) return envelope;
  const payload = envelope.payload;
  if (!Array.isArray(payload.testResults)) return { ok: false, error: "report has no testResults", reported: false };
  return { ok: true, report: { testResults: payload.testResults } };
}

/** Decodes one encoded report under an encoded and an inflated byte cap; anything missing, oversized or malformed is an error, never a throw. */
export function decodeReport(text: string | undefined, options: DecodeOptions = {}): DecodedReport {
  try {
    return readPayload(inflate((text ?? "").trim(), options.maxBytes ?? MAX_ENCODED_BYTES));
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, error: `report inflates past ${MAX_INFLATED_BYTES} bytes`, reported: false };
    return { ok: false, error: error instanceof Error ? error.message : "report is not readable", reported: false };
  }
}

/** One mutation's run on the mutants side: `built` false means its rebuild failed and `report` is absent. */
export interface MutantRun {
  spec: string;
  name: string;
  built: boolean;
  report?: unknown;
}

export interface MutantsReport {
  /** The merge base with the head's tests overlaid, run once before any mutation. */
  baseline: unknown;
  runs: MutantRun[];
}

/** `skipped` marks a mutants side that chose not to run: no spec in the diff, or a diff with source paths. */
export type DecodedMutants =
  | { ok: true; skipped: string }
  | { ok: true; skipped?: undefined; baseline: { testResults: unknown[] }; runs: MutantRun[] }
  | { ok: false; error: string; reported: boolean };

function compactReport(report: unknown): { testResults: UnknownRecord[] } {
  const files = isRecord(report) && Array.isArray(report.testResults) ? report.testResults : [];
  return { testResults: files.map(compactFile) };
}

function compactRun(run: MutantRun): UnknownRecord {
  const out: UnknownRecord = { spec: run.spec, name: run.name, built: run.built };
  if (run.built) out.report = compactReport(run.report);
  return out;
}

/** The mutants side's one combined report: the baseline and each mutation's run, encoded like `encodeReport`. */
export function encodeMutantsReport(report: MutantsReport): string {
  return pack({ baseline: compactReport(report.baseline), runs: report.runs.map(compactRun) });
}

/** An encoded marker saying the mutants side had nothing to run, carrying why. */
export function encodeMutantsSkipped(reason: string): string {
  return pack({ skipped: reason.slice(0, MAX_ERROR_CHARS) });
}

function testResultsOf(value: unknown): { testResults: unknown[] } | null {
  return isRecord(value) && Array.isArray(value.testResults) ? { testResults: value.testResults } : null;
}

function readRun(value: unknown): MutantRun | null {
  if (!isRecord(value) || typeof value.spec !== "string" || typeof value.name !== "string" || typeof value.built !== "boolean") return null;
  if (!value.built) return { spec: value.spec, name: value.name, built: false };
  const report = testResultsOf(value.report);
  return report === null ? null : { spec: value.spec, name: value.name, built: true, report };
}

// A run named twice could pair either copy with the spec, so a duplicate makes the whole report unreadable.
function readRuns(value: unknown): MutantRun[] | null {
  if (!Array.isArray(value)) return null;
  const runs = value.map(readRun).filter((run): run is MutantRun => run !== null);
  if (runs.length !== value.length) return null;
  const keys = new Set(runs.map((run) => JSON.stringify([run.spec, run.name])));
  return keys.size === runs.length ? runs : null;
}

function readMutantsPayload(raw: unknown): DecodedMutants {
  const envelope = readEnvelope(raw);
  if (!envelope.ok) return envelope;
  const record = envelope.payload;
  if (typeof record.skipped === "string") return { ok: true, skipped: record.skipped.slice(0, MAX_ERROR_CHARS) };
  const baseline = testResultsOf(record.baseline);
  const runs = readRuns(record.runs);
  if (baseline === null || runs === null) return { ok: false, error: "mutants report is malformed", reported: false };
  return { ok: true, baseline, runs };
}

/** Decodes the mutants side's report under the same caps as `decodeReport`; anything malformed is an error, never a throw. */
export function decodeMutantsReport(text: string | undefined, options: DecodeOptions = {}): DecodedMutants {
  try {
    return readMutantsPayload(inflate((text ?? "").trim(), options.maxBytes ?? MAX_ENCODED_BYTES));
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, error: `report inflates past ${MAX_INFLATED_BYTES} bytes`, reported: false };
    return { ok: false, error: error instanceof Error ? error.message : "report is not readable", reported: false };
  }
}
