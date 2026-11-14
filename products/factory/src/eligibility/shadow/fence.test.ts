import type * as ChildProcess from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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

describe("shadow dispatcher fence", () => {
  afterEach(() => void vi.useRealTimers());

  it("no file of the decision path imports a launch path", () => {
    const fenced = filesUnder(ELIGIBILITY).filter((path) => FENCED.some((pattern) => pattern.test(path)) && !isTest(path));
    const offenders = fenced.flatMap((path) => launchImports(readFileSync(join(ELIGIBILITY, path), "utf8")).map((hit) => `${path} ${hit}`));

    expect(fenced).toEqual(expect.arrayContaining(["shadow/tick.ts", "shadow/command.ts", "shadow/providers.ts"]));
    expect(offenders).toEqual([]);
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
