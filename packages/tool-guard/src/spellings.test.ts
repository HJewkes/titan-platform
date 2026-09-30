import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPELLINGS } from "./spellings.js";

const FAMILY_TESTS = new URL("./families/", import.meta.url);

function familyTestText(): string {
  const files = readdirSync(FAMILY_TESTS).filter((f) => f.endsWith(".test.ts"));
  return files.map((f) => readFileSync(new URL(f, FAMILY_TESTS), "utf8")).join("\n");
}

describe("SPELLINGS", () => {
  it("has a fixture naming every spelling id in the family tests", () => {
    const text = familyTestText();

    const untested = Object.keys(SPELLINGS).filter((id) => !text.includes(`"${id}"`));

    expect(untested).toEqual([]);
  });
});
