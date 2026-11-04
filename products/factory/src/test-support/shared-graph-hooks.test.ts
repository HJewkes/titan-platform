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
/**
 * An injected `sleep` that arms a timer but takes no signal: a step polling on it never sees `host.close()` abort it, so
 * the loop outlives its file and its tick lands on a later file's fake clock (TP-4539, land-base's base-wait).
 */
const SIGNAL_DEAF_SLEEP = /sleep:\s*(?:async\s*)?\(\s*(?:\w+\s*(?::[^,)]*)?)?\)\s*=>[^,\n]*\bsetTimeout\(/;
const src = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, keep);
    return keep(entry.name) ? [path] : [];
  });
}

const offendersOf = (paths: string[], pattern: RegExp) => paths.filter((path) => pattern.test(readFileSync(path, "utf8"))).map((path) => relative(src, path));

describe("a factory helper module shared across test files", () => {
  it("registers no top-level hook, so its cleanup runs for every importing file", () => {
    const helpers = sourceFiles(src, (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name));

    expect(offendersOf(helpers, TOP_LEVEL_HOOK)).toEqual([]);
  });
});

describe("a factory test file in a shared worker", () => {
  it("injects no sleep that arms a timer without the step's signal, so close() ends every poll", () => {
    const tests = sourceFiles(src, (name) => /\.test\.tsx?$/.test(name));

    expect(offendersOf(tests, SIGNAL_DEAF_SLEEP)).toEqual([]);
  });
});
