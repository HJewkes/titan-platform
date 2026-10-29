import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STAGE_VERSIONS } from "./stage-spec.js";

describe("STAGE_VERSIONS", () => {
  it("keeps one stage per line so a version bump is a one-line diff", () => {
    const source = readFileSync(new URL("./stage-spec.ts", import.meta.url), "utf8");

    const body = /export const STAGE_VERSIONS[^=]*= \{\n([\s\S]*?)\n\};/.exec(source)?.[1] ?? "";
    const lines = body.split("\n");

    expect(lines).toHaveLength(Object.keys(STAGE_VERSIONS).length);
    for (const line of lines) expect(line).toMatch(/^ {2}\w+: "[^"]+",$/);
  });
});
