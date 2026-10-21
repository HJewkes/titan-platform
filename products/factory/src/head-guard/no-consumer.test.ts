import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** M1a ships emitters only (TP-3097 I10): nothing outside head-guard/ reads the epoch until a rung registers a consumer. */
const READS = /\breadEpoch\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Pure: whether a src-relative path is the guard itself or a test, the only places a read may appear. */
function mayRead(path: string): boolean {
  return path.startsWith("head-guard/") || path.endsWith(".test.ts");
}

describe("head epoch reads", () => {
  it("lets only head-guard/ and tests mention readEpoch", () => {
    const readers = sourceFiles(SRC)
      .map((path) => relative(SRC, path).split(sep).join("/"))
      .filter((path) => !mayRead(path))
      .filter((path) => READS.test(readFileSync(join(SRC, path), "utf8")));

    expect(readers).toEqual([]);
  });

  it("scans a tree the epoch store is in", () => {
    const paths = sourceFiles(SRC).map((path) => relative(SRC, path).split(sep).join("/"));

    expect(paths).toContain("head-guard/epoch-store.ts");
  });

  it("counts a service file as a reader and exempts the guard and tests", () => {
    expect(["serve.ts", "shepherd/x.ts", "head-guards.ts"].filter(mayRead)).toEqual([]);
    expect(["head-guard/guard.ts", "serve.test.ts"].every(mayRead)).toBe(true);
  });
});
