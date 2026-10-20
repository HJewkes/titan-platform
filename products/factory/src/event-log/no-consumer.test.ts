import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** M1a ships emitters only (TP-3095 I7): no recipe or service may read the log until a rung registers a consumer. */
const READS = /\b(readEvents|headSeq)\b/;
const KEY_MODULES = /event-log\/[\w-]+-keys/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Pure: whether a src-relative path is the log itself, a test, or the A17 harness feed, the only places a read may appear. */
function mayRead(path: string): boolean {
  return path.startsWith("event-log/") || path.startsWith("test-support/a17/") || path.endsWith(".test.ts");
}

describe("event log reads", () => {
  it("lets only event-log/ and tests mention readEvents or headSeq", () => {
    const readers = sourceFiles(SRC)
      .map((path) => relative(SRC, path).split(sep).join("/"))
      .filter((path) => !mayRead(path))
      .filter((path) => READS.test(readFileSync(join(SRC, path), "utf8")));

    expect(readers).toEqual([]);
  });

  it("registers no consumer of the CI or repository key derivations outside event-log/ and tests", () => {
    const importers = sourceFiles(SRC)
      .map((path) => relative(SRC, path).split(sep).join("/"))
      .filter((path) => !mayRead(path))
      .filter((path) => KEY_MODULES.test(readFileSync(join(SRC, path), "utf8")));

    expect(importers).toEqual([]);
  });

  it("scans a tree the log's own module is in", () => {
    const paths = sourceFiles(SRC).map((path) => relative(SRC, path).split(sep).join("/"));

    expect(paths).toContain("event-log/event-log.ts");
  });

  it("counts a service file as a reader and exempts the log and tests", () => {
    expect(["serve.ts", "shepherd/x.ts", "event-logs.ts"].filter(mayRead)).toEqual([]);
    expect(["event-log/event-log.ts", "serve.test.ts", "test-support/a17/feed.ts"].every(mayRead)).toBe(true);
    expect(["test-support/leak.ts"].filter(mayRead)).toEqual([]);
  });
});
