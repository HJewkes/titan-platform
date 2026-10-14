import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerMalformedError, exportLedgerJson, parseLedgerJson, writeLedgerExport } from "./json.js";
import { EMPTY_LEDGER } from "./schema.js";

const FIXTURE = fs.readFileSync(new URL("./fixtures/burndown-ledger.json", import.meta.url), "utf8");

describe("parseLedgerJson and exportLedgerJson", () => {
  it("round-trips the fixture byte-equal with its keys out of schema order", () => {
    const keys = Object.keys(parseLedgerJson(FIXTURE));
    expect(keys.indexOf("brake")).toBeGreaterThan(keys.indexOf("wake"));
    expect(keys[0]).toBe("lastTickAt");

    expect(exportLedgerJson(parseLedgerJson(FIXTURE))).toBe(FIXTURE);
  });

  it("throws LedgerMalformedError on text that is not JSON", () => {
    expect(() => parseLedgerJson("{ not json")).toThrow(LedgerMalformedError);
  });

  it("throws LedgerMalformedError on JSON the schema refuses", () => {
    expect(() => parseLedgerJson(JSON.stringify({ version: 1, claims: [{ taskId: "TX-1" }] }))).toThrow(
      LedgerMalformedError,
    );
  });

  it("ends the export with one newline", () => {
    expect(exportLedgerJson(EMPTY_LEDGER)).toBe('{\n  "version": 1,\n  "claims": []\n}\n');
  });
});

describe("writeLedgerExport", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ledger-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes the export at mode 0600 and leaves no temp file behind", () => {
    const file = path.join(dir, "nested", "burndown.json");

    writeLedgerExport(file, parseLedgerJson(FIXTURE));

    expect(fs.readFileSync(file, "utf8")).toBe(FIXTURE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["burndown.json"]);
  });
});
