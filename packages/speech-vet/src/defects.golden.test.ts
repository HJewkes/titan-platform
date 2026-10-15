import { readFileSync } from "node:fs";
import { TranscriptSchema } from "@titan-design/speech-stt";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { scanNumber } from "./defect-numbers.js";
import { confirmDefects, detectDefects, type Defect } from "./defects.js";

const DefectRecord = z.object({
  kind: z.enum(["substitution", "omission", "low_confidence"]),
  expected: z.string(),
  heard: z.string(),
  severity: z.number(),
  causes: z.array(z.enum(["number", "stylized_elongation", "unusual_word", "chunk_boundary", "muddy_audio"])),
  audioStart: z.number().optional(),
  audioEnd: z.number().optional(),
  context: z.string(),
});
const Records = { on: z.array(DefectRecord), off: z.array(DefectRecord) };
const Golden = z.object({
  cases: z.array(z.object({ id: z.string(), expected: z.string(), transcript: TranscriptSchema, ...Records })),
  confirm: z.array(
    z.object({ id: z.string(), expected: z.string(), base: TranscriptSchema, confirm: TranscriptSchema, ...Records }),
  ),
  scanNumber: z.array(
    z.object({ norms: z.array(z.string()), i: z.number(), value: z.string().nullable(), end: z.number() }),
  ),
});

const golden = Golden.parse(
  JSON.parse(readFileSync(new URL("./fixtures/defects.golden.json", import.meta.url), "utf8")),
);

const ON = { confidence: true };

// Severity is compared with toEqual, not toBeCloseTo: the golden stores Python's unrounded floats.
describe("detectDefects against the audiobook's defects.py", () => {
  it.each(golden.cases.map((c) => [c.id, c] as const))("%s, signal A on, equals the full-transcript record", (_, c) => {
    const found: Defect[] = detectDefects(c.expected, c.transcript, ON);
    expect(found).toEqual(c.on);
  });

  // Mutation caught: reading probabilities or segments with the flag off fails every case whose on and off records differ.
  it.each(golden.cases.map((c) => [c.id, c] as const))("%s, flag off, equals the stripped-transcript record", (_, c) => {
    expect(detectDefects(c.expected, c.transcript)).toEqual(c.off);
  });
});

describe("confirmDefects against the audiobook's confirm_defects", () => {
  it.each(golden.confirm.map((c) => [c.id, c] as const))("%s, signal A on", (_, c) => {
    const base = detectDefects(c.expected, c.base, ON);
    expect(confirmDefects(base, c.expected, c.confirm, ON)).toEqual(c.on);
  });

  it.each(golden.confirm.map((c) => [c.id, c] as const))("%s, flag off", (_, c) => {
    const base = detectDefects(c.expected, c.base);
    expect(confirmDefects(base, c.expected, c.confirm)).toEqual(c.off);
  });
});

describe("scanNumber against the audiobook's _scan_number", () => {
  it.each(golden.scanNumber.map((row) => [row.norms.join(" "), row] as const))("%s", (_, row) => {
    const [value, end] = scanNumber(row.norms, row.i);
    expect([value === null ? null : value.toString(), end]).toEqual([row.value, row.end]);
  });
});
