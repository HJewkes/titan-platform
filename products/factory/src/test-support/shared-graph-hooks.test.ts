import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The factory project runs isolate:false, so a helper module loads once per worker and its top-level hooks register in
 * the first test file that imports it only. Hosts such a hook closed then outlived later files, and their 5 ms gate polls
 * re-armed on a later file's fake clock, so advancing it by hours spun until the 30 s test timeout (TP-4515).
 */
const TOP_LEVEL_HOOK = /^(?:afterEach|beforeEach|afterAll|beforeAll)\(/m;
const src = fileURLToPath(new URL("..", import.meta.url));

function helperModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return helperModules(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("a factory helper module shared across test files", () => {
  it("registers no top-level hook, so its cleanup runs for every importing file", () => {
    const offenders = helperModules(src).filter((path) => TOP_LEVEL_HOOK.test(readFileSync(path, "utf8")));

    expect(offenders.map((path) => relative(src, path))).toEqual([]);
  });
});
