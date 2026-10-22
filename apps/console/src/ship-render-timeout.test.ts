import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Ship round files render the whole App per test; loaded full-suite CI runs pushed one past vitest's 5 s default
// twice (TP-3866, TP-3937). The guard is a timeout on every describe in each file, so a new describe cannot drop it.
const SHIP_RENDER_FILES = ["rounds-ship.test.tsx", "rounds-ship-tabs.test.tsx", "rounds-ship-prs.test.tsx"];
const MIN_TIMEOUT_MS = 30_000;

const source = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const describeLines = (text: string): string[] => text.split("\n").filter((line) => line.startsWith("describe("));

describe("Ship round tests that render the whole App", () => {
  it.each(SHIP_RENDER_FILES)("%s gives every describe the render timeout", (file) => {
    const text = source(file);
    const lines = describeLines(text);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => !line.includes("{ timeout: RENDER_TIMEOUT_MS }"))).toEqual([]);
  });

  it.each(SHIP_RENDER_FILES)("%s sets the render timeout to at least 30 s", (file) => {
    const declared = /const RENDER_TIMEOUT_MS = ([\d_]+);/.exec(source(file))?.[1];

    expect(Number(declared?.replaceAll("_", ""))).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
  });
});
