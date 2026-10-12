import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeReport, encodeError, encodeReport, MAX_INFLATED_BYTES } from "./transport.js";

const REPORT = {
  numTotalTests: 1,
  testResults: [
    {
      name: "src/math.test.ts",
      status: "failed",
      message: "dropped",
      assertionResults: [
        { fullName: "math adds", ancestorTitles: ["math"], title: "adds", status: "failed", duration: 3, failureMessages: ["x".repeat(5000)] },
      ],
    },
  ],
};

describe("report transport", () => {
  it("round-trips only the fields the classifier reads, trimming each failure message", () => {
    const decoded = decodeReport(encodeReport(REPORT));

    expect(decoded).toEqual({
      ok: true,
      report: {
        testResults: [
          {
            name: "src/math.test.ts",
            status: "failed",
            assertionResults: [{ fullName: "math adds", ancestorTitles: ["math"], title: "adds", status: "failed", failureMessages: ["x".repeat(2048)] }],
          },
        ],
      },
    });
  });

  it("encoded output contains no space or newline", () => {
    const spaced = { testResults: [{ name: "a b.test.ts", assertionResults: [{ title: "a\nb c", failureMessages: ["fix-proof/v1 {}\n"] }] }] };

    expect(encodeReport(spaced)).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("decode refuses an inflated report over the cap", () => {
    const bomb = gzipSync(JSON.stringify({ v: 1, testResults: [], pad: " ".repeat(MAX_INFLATED_BYTES) })).toString("base64");

    expect(decodeReport(bomb)).toEqual({ ok: false, error: `report inflates past ${MAX_INFLATED_BYTES} bytes`, reported: false });
  });

  it("decode refuses an encoded report over the byte cap", () => {
    expect(decodeReport(encodeReport(REPORT), { maxBytes: 16 })).toMatchObject({ ok: false, error: "report over 16 bytes" });
  });

  it("decode calls a missing or non-base64 report an error, not a throw", () => {
    expect(decodeReport(undefined)).toMatchObject({ ok: false, error: "missing report", reported: false });
    expect(decodeReport("fix-proof/v1 {}")).toMatchObject({ ok: false, error: "report is not base64" });
    expect(decodeReport(Buffer.from("not gzip").toString("base64"))).toMatchObject({ ok: false, reported: false });
  });

  it("an error marker decodes as the side's own error", () => {
    expect(decodeReport(encodeError("base: build failed (exit 3)"))).toEqual({ ok: false, error: "base: build failed (exit 3)", reported: true });
  });
});
