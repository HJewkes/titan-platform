import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const guardDir = dirname(fileURLToPath(import.meta.url));
const srcDir = dirname(guardDir);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("head-guard classifier isolation", () => {
  it("has no consumer outside head-guard/", () => {
    const consumers = sourceFiles(srcDir)
      .filter((file) => !file.startsWith(guardDir))
      .filter((file) => /from\s+["'][^"']*head-guard\/classify/.test(readFileSync(file, "utf8")))
      .map((file) => relative(srcDir, file));
    expect(consumers).toEqual([]);
  });

  it("imports nothing, so it can do no I/O", () => {
    const source = readFileSync(join(guardDir, "classify.ts"), "utf8");
    expect(source).not.toMatch(/^import\s/m);
  });
});
