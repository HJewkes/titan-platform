import { describe, expect, it } from "vitest";
import { SHEPHERD_ENTRY } from "./fixtures.js";
import {
  measurementAuditSchema,
  metricsEntrySchema,
  validateEntry,
} from "./index.js";

const clone = <T>(value: T): T => structuredClone(value);

describe("validateEntry", () => {
  it("accepts the Shepherd entry on write and on read", () => {
    expect(validateEntry(SHEPHERD_ENTRY, "write")).toEqual({
      ok: true,
      entry: SHEPHERD_ENTRY,
    });
    expect(validateEntry(SHEPHERD_ENTRY, "read").ok).toBe(true);
  });

  it("rejects an entry missing a required field, naming the path", () => {
    const entry: Record<string, unknown> = clone(SHEPHERD_ENTRY);
    delete entry.owner;
    const result = validateEntry(entry, "read");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("owner");
  });

  it("rejects a nested missing field", () => {
    const entry = clone(SHEPHERD_ENTRY);
    delete (entry.metrics[0] as Partial<(typeof entry.metrics)[0]>).family;
    expect(validateEntry(entry, "read").ok).toBe(false);
  });

  it("keeps an unknown future field on read and refuses it on write", () => {
    const entry = { ...clone(SHEPHERD_ENTRY), futureField: { a: 1 } };
    entry.metrics[0] = {
      ...entry.metrics[0]!,
      futureMetricKey: true,
    } as (typeof entry.metrics)[0];

    const read = validateEntry(entry, "read");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.entry).toMatchObject({ futureField: { a: 1 } });
      expect(read.entry.metrics[0]).toMatchObject({ futureMetricKey: true });
    }
    expect(validateEntry(entry, "write").ok).toBe(false);
  });

  it("refuses an unknown schema id", () => {
    expect(
      validateEntry({ ...SHEPHERD_ENTRY, schema: "titan.metrics/v9" }, "read")
        .ok
    ).toBe(false);
  });

  it("validates a measurement audit report by its schema id", () => {
    const report = {
      schema: "titan.measurement-audit/v1",
      system: "shepherd",
      mode: "initial",
      at: "2026-10-08T00:00:00.000Z",
      codeRev: "0000000",
      inputs: {
        system: "shepherd",
        codeRoots: ["src"],
        stores: [],
        surfaces: [],
        owner: "titan-coord",
        mode: "initial",
      },
      inventory: { data: {}, emitters: {} },
      purpose: "Merge PRs",
      users: ["owner"],
      questions: [{ id: 1, text: "Is it up?", answerable: "partly" }],
      metrics: [
        {
          ...SHEPHERD_ENTRY.metrics[0]!,
          baseline: { value: null, n: 0, error: "timeout" },
        },
      ],
      counts: { proposed: 1, Y: 0, P: 1, N: 0, slices: 1 },
      gaps: [
        {
          rank: 1,
          metric: ["shepherd.availability.service_up"],
          slice: { title: "t", done_when: "d", estimate: 2 },
        },
      ],
      reports: SHEPHERD_ENTRY.reports,
      extra: {},
    };
    expect(measurementAuditSchema.safeParse(report).success).toBe(true);
    expect(validateEntry(report, "write").ok).toBe(true);
    expect(
      validateEntry({ ...report, counts: { proposed: 1 } }, "read").ok
    ).toBe(false);
    expect(metricsEntrySchema.safeParse(report).success).toBe(false);
  });
});
