import type * as ChildProcess from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { EXIT } from "../../cli.js";
import type { ShadowRow } from "./row.js";
import { enabledRules, fakeRpc, readRows, selectedBet, shadowHome, shadowTickCli, task } from "./tick.test-helpers.js";

/*
 * The shadow dispatcher may never spawn, message or start an agent (TP-5755 PLAN 4, row S2). Three proofs: no file of the
 * dispatcher's decision path imports a launch path, a full enabled tick calls no child process and no agent-chat runner,
 * and the row kind has no `dispatched` member to write. The one outward message, a lane's ready-stock refill request, goes
 * through the CLI's injected `refillSend`, so no fenced file imports how it is sent.
 */

const childProcess = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("node:child_process", async (original) => {
  const real = await original<typeof ChildProcess>();
  const recorded = Object.fromEntries(
    Object.entries(real).map(([name, value]: [string, unknown]) => [name, typeof value === "function" ? (...args: unknown[]): unknown => (childProcess.calls.push(name), Reflect.apply(value, real, args)) : value]),
  );
  return { ...recorded, default: recorded };
});

const ELIGIBILITY = fileURLToPath(new URL("..", import.meta.url));
const SRC = fileURLToPath(new URL("../..", import.meta.url));

/** The decision path's files today and the ones later slices add; a pattern with no file yet matches nothing. */
const FENCED = [/^shadow\/.+\.ts$/, /^intake.*\.ts$/, /^upkeep.*\.ts$/, /^landed.*\.ts$/, /^stop-.*\.ts$/, /^sheets\/.+\.ts$/];

const LAUNCH_PATHS = [/^@titan-design\/agent-dispatch$/, /agent-chat-implementer/, /shepherd\/agents(\.js)?$/, /^(node:)?child_process$/];

const IMPORT = /(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function filesUnder(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]));
}

/** Pure: each value import of a launch path in one source; a type-only import cannot run anything. */
function launchImports(source: string): string[] {
  return [...source.matchAll(IMPORT)].filter(([, typeOnly, from, dynamic]) => typeOnly === undefined && LAUNCH_PATHS.some((path) => path.test(from ?? dynamic ?? ""))).map(([, , from, dynamic]) => from ?? dynamic ?? "");
}

const isTest = (path: string): boolean => /\.test(-helpers)?\.ts$/.test(basename(path));

/** Pure: the relative value-import specifiers of one source; a type-only import loads nothing at run time. */
function localImports(source: string): string[] {
  return [...source.matchAll(IMPORT)].filter(([, typeOnly]) => typeOnly === undefined).map(([, , from, dynamic]) => from ?? dynamic ?? "").filter((spec) => spec.startsWith("."));
}

const isFenced = (file: string): boolean => {
  const path = relative(ELIGIBILITY, file);
  return !path.startsWith("..") && FENCED.some((pattern) => pattern.test(path)) && !isTest(path);
};

function localTargets(file: string): string[] {
  return localImports(readFileSync(file, "utf8")).map((spec) => resolve(dirname(file), spec.replace(/\.js$/, ".ts"))).filter((target) => existsSync(target));
}

/** Whether `start` or any module it reaches through local value imports value-imports a launch path. */
function reachesLaunchPath(start: string, memo: Map<string, boolean>): boolean {
  const cached = memo.get(start);
  if (cached !== undefined) return cached;
  const seen = new Set<string>();
  const queue = [start];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (launchImports(readFileSync(file, "utf8")).length > 0) return memo.set(start, true).get(start)!;
    queue.push(...localTargets(file));
  }
  return memo.set(start, false).get(start)!;
}

/** The first import out of the fenced set whose target can reach a launch path, as `from -> to` relative to src. */
function boundaryEdges(fenced: string[]): string[] {
  const memo = new Map<string, boolean>();
  const edges = new Set<string>();
  const seen = new Set<string>();
  const queue = [...fenced];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const target of localTargets(file)) {
      if (isFenced(target)) queue.push(target);
      else if (reachesLaunchPath(target, memo)) edges.add(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
    }
  }
  return [...edges].sort();
}

/*
 * Ratchet (TP-6157): each entry is an edge from the fenced set into a module that can still reach a launch path. TP-6157
 * decouples the decision path; the list must reach empty. A new edge fails the test, and so does an entry that no longer
 * leads anywhere forbidden, so the list only shrinks.
 */
const ALLOWED_BOUNDARY_EDGES: string[] = [
  "eligibility/intake-signals.ts -> shepherd/watch-rows.ts", // TP-6157
  "eligibility/landed-signals.ts -> shepherd/view.ts", // TP-6157
  "eligibility/shadow/rule-file.ts -> config.ts", // TP-6157
  "eligibility/shadow/tick.ts -> config.ts", // TP-6157
  "eligibility/shadow/tick.ts -> eligibility/command.ts", // TP-6157
  "eligibility/shadow/tick.ts -> eligibility/lane-signals.ts", // TP-6157
  "eligibility/stop-signals.ts -> shepherd/view.ts", // TP-6157
  "eligibility/stop-signals.ts -> shepherd/wake.ts", // TP-6157
  "eligibility/upkeep-signals.ts -> eligibility/gh-api-read.ts", // TP-6157
  "eligibility/upkeep-signals.ts -> shepherd/view.ts", // TP-6157
];

describe("launchImports", () => {
  it("flags value imports of each launch path, dynamic and re-exports included, and ignores type-only ones", () => {
    const source = [
      'import { spawn } from "node:child_process";',
      'import { runImplementer } from "../../dispatch/agent-chat-implementer.js";',
      'export { launch } from "../../shepherd/agents.js";',
      'const x = await import("@titan-design/agent-dispatch");',
      'import type { DispatchError } from "@titan-design/agent-dispatch";',
      'import { readFileSync } from "node:fs";',
    ].join("\n");

    expect(launchImports(source)).toEqual(["node:child_process", "../../dispatch/agent-chat-implementer.js", "../../shepherd/agents.js", "@titan-design/agent-dispatch"]);
  });
});

describe("localImports", () => {
  it("keeps relative value imports and drops type-only and package ones", () => {
    const source = ['import { a } from "./a.js";', 'import type { B } from "./b.js";', 'export { c } from "../c.js";', 'import { d } from "node:fs";', 'const e = await import("./e.js");'].join("\n");

    expect(localImports(source)).toEqual(["./a.js", "../c.js", "./e.js"]);
  });
});

describe("shadow dispatcher fence", () => {
  afterEach(() => void vi.useRealTimers());

  it("no file of the decision path imports a launch path", () => {
    const fenced = filesUnder(ELIGIBILITY).filter((path) => FENCED.some((pattern) => pattern.test(path)) && !isTest(path));
    const offenders = fenced.flatMap((path) => launchImports(readFileSync(join(ELIGIBILITY, path), "utf8")).map((hit) => `${path} ${hit}`));

    expect(fenced).toEqual(expect.arrayContaining(["shadow/tick.ts", "shadow/command.ts", "shadow/providers.ts"]));
    expect(offenders).toEqual([]);
  });

  it("no module reachable from the decision path through value imports imports a launch path", () => {
    const fenced = filesUnder(ELIGIBILITY).filter((path) => FENCED.some((pattern) => pattern.test(path)) && !isTest(path));
    const edges = boundaryEdges(fenced.map((path) => join(ELIGIBILITY, path)));

    expect(edges.filter((edge) => !ALLOWED_BOUNDARY_EDGES.includes(edge))).toEqual([]);
    expect(ALLOWED_BOUNDARY_EDGES.filter((edge) => !edges.includes(edge))).toEqual([]);
  });

  it("a full enabled tick calls no child process and no agent-chat runner", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-18T12:00:00Z") });
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));
    const rpc = fakeRpc({ tasks: [task(1), task(2, { bet: undefined })], bets: [selectedBet(1, 1, ["alpha/AL-1"])] });
    const runner = vi.fn(async () => {
      throw new Error("spawn attempted");
    });

    const { code } = await shadowTickCli(home, rpc.fetch, {}, [], { planner: { run: runner } });

    expect(code).toBe(EXIT.OK);
    expect(readRows(home.shadowDir)[0]!.rows.map((row) => row.kind)).toEqual(["wake", "refused", "would-dispatch"]);
    expect(childProcess.calls).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("a row kind is wake, would-dispatch or refused, and never dispatched", () => {
    expectTypeOf<ShadowRow["kind"]>().toEqualTypeOf<"wake" | "would-dispatch" | "refused">();
  });
});
