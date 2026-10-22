import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pathTouches } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { SHEPHERD_CLASS_RULES } from "./g10-class-rules.js";
import { adversaryTouches } from "./signoffs.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const TOPS = ["packages", "products", "apps"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", "fixtures", "test-support"]);
const SOURCE = /\.(ts|tsx|mts|cts)$/;
const NOT_SOURCE = /(\.(test|d)\.[a-z]+|\.test-helpers\.ts|test-fixture\.ts)$/;

/**
 * Where a gate's resolver gets its class or reaches the store (TP-4052): a resolver-shaped literal (`class` and
 * `channel` in one object), a `class` written in a file that handles `GateResolver`, or a call into a resolve sink.
 */
const RESOLVE_SITE = [
  /\{[^{}]*\bclass:[^{}]*\bchannel:[^{}]*\}/,
  /\{[^{}]*\bchannel:[^{}]*\bclass:[^{}]*\}/,
  /\.(gates|store)\.resolve\(/,
  /\.runtime\.signal\(/,
  /\bresolveGate\(/,
];
const TYPED_CLASS = /\bclass:/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE.test(entry.name) && !NOT_SOURCE.test(entry.name) ? [path] : [];
  });
}

const isResolveSite = (text: string): boolean => RESOLVE_SITE.some((site) => site.test(text)) || (text.includes("GateResolver") && TYPED_CLASS.test(text));

const resolveSites = (): string[] =>
  TOPS.flatMap((top) => sourceFiles(join(ROOT, top)))
    .filter((path) => isResolveSite(readFileSync(path, "utf8")))
    .map((path) => relative(ROOT, path));

const isHeld = (path: string): boolean => adversaryTouches(pathTouches([{ path }], SHEPHERD_CLASS_RULES)).length > 0;

describe("every place a gate resolver is built or resolved", () => {
  const sites = resolveSites();

  it("is held g10-adversary, so a new resolve path cannot land without an adversary review", () => {
    expect(sites.filter((path) => !isHeld(path))).toEqual([]);
  });

  it.each([
    "products/factory/src/gate-resolve.ts",
    "products/factory/src/gate-answer-rpc.ts",
    "products/factory/src/gate-batch.ts",
    "products/factory/src/gate-notify.ts",
    "products/factory/src/console-action/outcome.ts",
    "products/factory/src/shepherd/round-ship-sweep.ts",
    "packages/queue-mirror/src/hitl.ts",
    "apps/console/server/inbox-actions.ts",
  ])("finds the known resolver site %s", (path) => {
    expect(sites).toContain(path);
  });

  it("does not count a resolver built only in a test file", () => {
    expect(sites.filter((path) => path.endsWith(".test.ts"))).toEqual([]);
  });
});
