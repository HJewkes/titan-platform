import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import { CRITIQUE_PASSES } from "./sheet-critique.js";
import { SHEET_JUDGE, runSheetCritique, type SheetCellRef, type SheetCritiqueInput } from "./sheet-judge.js";

const SHEETS = ["/sheets/sheet-one.png", "/sheets/sheet-two.png"];
const CELLS: SheetCellRef[] = [
  { beat: "b1", t: 1.25 },
  { beat: "b2", t: 4.5 },
];
const PERFECT = { design: 10, clarity: 10, idea: 10, content: 10 };
const GLOW = { cell: { beat: "intro", t: 0 }, problem: "orange halo behind nothing", change: "drop the halo", tags: ["glow-or-gradient"], severity: 4 };

interface Finding {
  cell: SheetCellRef;
  problem: string;
  change: string;
  tags: string[];
  severity: number;
}

type Answer = (pass: string, call: JudgeCall<unknown>) => { findings: Finding[] } | { fail: string };

const passOf = (prompt: string): string => /Pass: (\S+)\n$/.exec(prompt)![1]!;
const isCanary = (call: JudgeCall<unknown>): boolean => call.images?.length === 1 && call.images[0]!.endsWith("canary-glow.png");

/** A judge that answers each call through its own schema, so a reply the real judge could not send fails the test. */
function fakeHarness(answer: Answer, calls: JudgeCall<unknown>[] = []): JudgeHarness {
  return async <T,>(call: JudgeCall<T>): Promise<JudgeReply<T>> => {
    calls.push(call);
    const pass = passOf(call.prompt);
    const got = answer(pass, call);
    const spend = { usd: 0.06, tokensIn: 7000, tokensOut: 200 };
    if ("fail" in got) return { ok: false, reason: got.fail, ...spend };
    return { ok: true, output: call.schema.parse({ pass, findings: got.findings, scores: PERFECT }), ...spend };
  };
}

const catchesCanary: Answer = (_pass, call) => ({ findings: isCanary(call) ? [GLOW] : [] });

function input(harness: JudgeHarness): SheetCritiqueInput {
  return { sheets: SHEETS, cells: CELLS, harness, judge: SHEET_JUDGE, scriptModel: "sonnet", rubric: "rubric" };
}

describe("runSheetCritique", () => {
  it("passes run in fixed order, each carrying every sheet", async () => {
    const calls: JudgeCall<unknown>[] = [];

    const result = await runSheetCritique(input(fakeHarness(catchesCanary, calls)));

    expect(result.ok).toBe(true);
    expect(calls.slice(0, 4).map((c) => passOf(c.prompt))).toEqual([...CRITIQUE_PASSES]);
    for (const call of calls.slice(0, 4)) expect(call.images).toEqual(SHEETS);
    expect(calls).toHaveLength(5);
    expect(isCanary(calls[4]!)).toBe(true);
  });

  it("a finding naming a beat not on the sheet is voided and counted", async () => {
    const offSheet = { cell: { beat: "b9", t: 1.25 }, problem: "invented beat", change: "nothing", tags: [], severity: 5 };
    const onSheet = { cell: { beat: "b2", t: 4.5 }, problem: "label clipped", change: "shorten it", tags: [], severity: 2 };
    const answer: Answer = (pass, call) => (isCanary(call) ? { findings: [GLOW] } : { findings: pass === "evidence" ? [offSheet, onSheet] : [] });

    const result = await runSheetCritique(input(fakeHarness(answer)));

    if (!result.ok) throw new Error(result.reason);
    expect(result.voided).toBe(1);
    expect(result.score.top).toEqual(["4.5s · b2 · label clipped -> shorten it"]);
  });

  it("a missed canary marks the run untrusted", async () => {
    const result = await runSheetCritique(input(fakeHarness(() => ({ findings: [] }))));

    if (!result.ok) throw new Error(result.reason);
    expect(result.canaryCaught).toBe(false);
    expect(result.trusted).toBe(false);
  });

  it("a glow finding caps the overall at 6.5 end to end", async () => {
    const glowOnSheet = { ...GLOW, cell: { beat: "b1", t: 1.3 } };
    const answer: Answer = (pass, call) => (isCanary(call) ? { findings: [GLOW] } : { findings: pass === "polish" ? [glowOnSheet] : [] });

    const result = await runSheetCritique(input(fakeHarness(answer)));

    if (!result.ok) throw new Error(result.reason);
    expect(result.trusted).toBe(true);
    expect(result.score.overall).toBe(6.5);
  });

  it("one failed pass call fails the run with no partial score", async () => {
    const calls: JudgeCall<unknown>[] = [];
    const answer: Answer = (pass, call) => (pass === "hierarchy" ? { fail: "runtime_error: budget" } : catchesCanary(pass, call));

    const result = await runSheetCritique(input(fakeHarness(answer, calls)));

    expect(result).toEqual({ ok: false, judge: "claude-print:opus", reason: "hierarchy call failed: runtime_error: budget", spend: { usd: 0.12, tokensIn: 14000, tokensOut: 400 } });
    expect(calls).toHaveLength(2);
  });

  it("the canary still ships in the published package", async () => {
    const calls: JudgeCall<unknown>[] = [];
    const packageDir = fileURLToPath(new URL("..", import.meta.url));
    const { files } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };

    await runSheetCritique(input(fakeHarness(catchesCanary, calls)));

    const canary = calls[4]!.images![0]!;
    expect(existsSync(canary)).toBe(true);
    expect(files.some((entry) => `${relative(packageDir, canary)}/`.startsWith(`${entry}/`))).toBe(true);
  });

  it("refuses a judge that is the script model", async () => {
    const run = runSheetCritique({ ...input(fakeHarness(catchesCanary)), scriptModel: SHEET_JUDGE.model });

    await expect(run).rejects.toThrow(/must differ from the writer/);
  });
});
