import { gunzipSync, gzipSync } from "node:zlib";

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

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function readPayload(payload: unknown): DecodedReport {
  if (!isRecord(payload) || payload.v !== 1) return { ok: false, error: "report has no v1 envelope", reported: false };
  if (typeof payload.error === "string") return { ok: false, error: payload.error.slice(0, MAX_ERROR_CHARS), reported: true };
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
