import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCases } from "./samples-cases.js";

const SHA = "a".repeat(64);
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function caseFile(name: string, split: string, inputs: Record<string, string> = { spine: SHA, facts: SHA }): string {
  const file = path.join(dir, "cases", `${name}.json`);
  writeFileSync(file, JSON.stringify({ schema: "titan.case/v1", id: name, unit: { id: "explainer-script", version: "1.0.0" }, input: { inputs }, split }));
  return file;
}

function setup(): void {
  dir = mkdtempSync(path.join(tmpdir(), "samples-cases-"));
  mkdirSync(path.join(dir, "cases"));
}

describe("loadCases", () => {
  it("reads a cases directory in name order and keeps the asked split", () => {
    setup();
    caseFile("b-dev", "dev");
    caseFile("a-dev", "dev");
    caseFile("c-holdout", "holdout");

    expect(loadCases([path.join(dir, "cases")], "dev")).toEqual([{ name: "a-dev", inputs: { spine: SHA, facts: SHA } }, { name: "b-dev", inputs: { spine: SHA, facts: SHA } }]);
  });

  it("keeps every split when none is asked, and reads single files", () => {
    setup();

    expect(loadCases([caseFile("a", "dev"), caseFile("b", "holdout")], undefined).map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("refuses an input that is not a full sha, a repeated id, and an empty selection", () => {
    setup();
    const short = caseFile("short", "dev", { spine: "abc" });

    expect(() => loadCases([short], undefined)).toThrow("is not a titan.case/v1 file");
    expect(() => loadCases([caseFile("a", "dev"), caseFile("a", "dev")], undefined)).toThrow("two cases share an id: a, a");
    expect(() => loadCases([caseFile("h", "holdout")], "dev")).toThrow('no case in split "dev"');
  });
});
