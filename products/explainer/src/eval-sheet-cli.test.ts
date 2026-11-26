import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli, type EvalCliDeps } from "./eval-cli.js";
import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const GLOW = { cell: { beat: "intro", t: 0 }, problem: "halo behind nothing", change: "drop the halo", tags: ["glow-or-gradient"], severity: 1 };
const finding = (beat: string, t: number, severity: number) => ({ cell: { beat, t }, problem: `problem ${beat}`, change: `change ${beat}`, tags: [], severity });

interface Fake {
  score: number;
  findings: ReturnType<typeof finding>[];
  seesCanary: boolean;
}

const isCanary = (call: JudgeCall<unknown>): boolean => call.images?.length === 1 && call.images[0]!.endsWith("canary-glow.png");

/** Answers every call through its own schema; the first pass carries the findings, the rest none. */
function fakeHarness({ score, findings, seesCanary }: Fake): JudgeHarness {
  return async <T,>(call: JudgeCall<T>): Promise<JudgeReply<T>> => {
    const pass = /Pass: (\S+)\n$/.exec(call.prompt)![1]!;
    const own = pass === "first-glance" ? findings : [];
    const reply = { pass, findings: isCanary(call) && seesCanary ? [GLOW] : own, scores: { design: score, clarity: score, idea: score, content: score } };
    return { ok: true, output: call.schema.parse(reply), usd: 0.06, tokensIn: 100, tokensOut: 10 };
  };
}

let dir: string;
let logs: string[];
let errors: string[];

function sheetDir(withCells = true): string {
  const sheets = join(dir, "sheets");
  mkdirSync(sheets);
  writeFileSync(join(sheets, "sheet-one.png"), ONE_PIXEL_PNG);
  if (withCells) {
    const cells = [{ beat: "b1", t: 1 }, { beat: "b2", t: 2 }, { beat: "b3", t: 3 }, { beat: "b4", t: 4 }];
    writeFileSync(join(sheets, "cells.json"), JSON.stringify({ sheets: [{ chapter: "one", file: "sheet-one.png", cells: [] }], cells }));
  }
  return sheets;
}

const run = (fake: Fake, ...extra: string[]): Promise<number> => {
  const deps: EvalCliDeps = { harness: () => fakeHarness(fake) };
  return runEvalCli(["eval", "sheet", "--sheets", sheetDir(), ...extra], deps);
};

const GOOD: Fake = { score: 8, findings: [], seesCanary: true };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-sheet-cli-"));
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));
});
afterEach(() => vi.restoreAllMocks());

describe("explainer eval sheet", () => {
  it("a sheet dir scores and prints the top three", async () => {
    const findings = [finding("b1", 1, 2), finding("b2", 2, 5), finding("b3", 3, 4), finding("b4", 4, 3)];

    const code = await run({ ...GOOD, findings });

    expect(code).toBe(0);
    expect(logs).toContain("sheet:overall\tpass\twarning\t8.0 (min 7.0, not enforced)");
    expect(logs).toContain("sheet:caps\tpass\treport\tnone");
    expect(logs.filter((line) => line.startsWith("top "))).toEqual(["top 1\t2s · b2 · problem b2 -> change b2", "top 2\t3s · b3 · problem b3 -> change b3", "top 3\t4s · b4 · problem b4 -> change b4"]);
    expect(logs).toContain("usd 0.30");
  });

  it("a run below --min-overall exits 1", async () => {
    const code = await run({ ...GOOD, score: 5 }, "--min-overall", "7");

    expect(code).toBe(1);
    expect(logs).toContain("sheet:overall\tfail\twarning\t5.0 (min 7.0)");
  });

  it("a missing cells.json is a usage error", async () => {
    const deps: EvalCliDeps = { harness: () => fakeHarness(GOOD) };

    const code = await runEvalCli(["eval", "sheet", "--sheets", join(dir, "empty")], deps);

    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/no readable cells\.json/);
  });

  it("an untrusted run exits 1 and says why", async () => {
    const code = await run({ ...GOOD, seesCanary: false });

    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/untrusted: the judge missed the planted glow/);
  });
});
