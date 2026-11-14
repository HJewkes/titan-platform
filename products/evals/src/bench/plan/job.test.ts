import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOB_SCHEMA, type JobRow } from "../ledger.js";
import type { PlanCase } from "./cases.js";
import { finalText, planPrompt, planTrack, PLAN_TOOLS } from "./job.js";

const line = (id: string, blocks: object[], extra: object = {}) => JSON.stringify({ type: "assistant", message: { id, content: blocks }, ...extra });

describe("finalText", () => {
  it("returns the last assistant message's text, joined across its streamed lines", () => {
    const transcript = [
      line("m1", [{ type: "text", text: "early thoughts" }]),
      line("m2", [{ type: "text", text: "The plan." }]),
      line("m2", [{ type: "tool_use", name: "Read" }]),
      line("m2", [{ type: "text", text: "```json\n{}\n```" }]),
      line("m3", [{ type: "text", text: "side chain" }], { isSidechain: true }),
      "{torn",
    ].join("\n");

    expect(finalText(transcript)).toBe("The plan.\n```json\n{}\n```");
  });
});

describe("planPrompt", () => {
  it("briefs title and done-when only, and ends asking for the fenced slice block", () => {
    const prompt = planPrompt({ title: "Add a parser", doneWhen: "parse() reads x" });

    expect(prompt).toContain("Task: Add a parser\nDone when: parse() reads x");
    expect(prompt.trimEnd()).toMatch(/```json\n\{"slices":\[\{"title".*"owns".*"estimate".*"tests".*\}\]\}\n```$/);
  });
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bench-plan-job-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const planCase: PlanCase = { id: "TP-7", hash: "h", stratum: { pool: "single", kind: "feature" }, title: "Add x", doneWhen: "x works", kind: "feature", pool: "single", baseSha: "b", landed: [{ pr: 9, mergeSha: "f".repeat(40), title: "Add x (#9)" }], slicesLanded: 1, packages: ["packages/x"], topDirs: ["packages"] };
const arm = { id: "H-high", model: "claude-haiku-5-5", effort: "high" as const };

describe("planTrack", () => {
  it("seeds a one-commit workspace, saves the plan under the run dir, and deletes the workspace on cleanup", async () => {
    const casesDir = join(root, "cases");
    mkdirSync(join(casesDir, "trees", "TP-7", "packages", "x"), { recursive: true });
    writeFileSync(join(casesDir, "trees", "TP-7", "CLAUDE.md"), "rules");
    writeFileSync(join(casesDir, "trees", "TP-7", "packages", "x", "a.ts"), "export {};");
    const runDir = join(root, "run");
    const plugin = planTrack({ casesDir, runDir });
    const jobDir = join(runDir, "jobs", "j1");
    mkdirSync(jobDir, { recursive: true });

    const prepared = await plugin.prepare(planCase, arm, jobDir);
    const transcript = join(root, "t.jsonl");
    writeFileSync(transcript, line("m1", [{ type: "text", text: '```json\n{"slices":[{"title":"a","owns":["packages/x/**"]}]}\n```' }]));
    const row: JobRow = {
      schema: JOB_SCHEMA, track: "p", arm, caseId: "TP-7", caseHash: "h", block: 0, stratum: null, attempt: 1, sessionId: "s1", transcript,
      startedAt: "", endedAt: "", seconds: 1, exit: { code: 0, timedOut: false }, outcome: "ok", tokens: null, listUsd: null, effortSeen: null, modelSeen: null,
    };
    const scored = await plugin.score(row, planCase, prepared);
    await plugin.cleanup(planCase, arm, prepared);

    expect(prepared.allowedTools).toEqual(PLAN_TOOLS);
    expect(prepared.timeoutSecs).toBe(1200);
    expect(prepared.appendSystemPromptFile).toBe(join(prepared.cwd, "CLAUDE.md"));
    expect(scored.result).toMatchObject({ parse: "ok", slicesPlanned: 1, sliceError: 0, fileRecall: 1, planFile: "plans/s1.md" });
    expect(readFileSync(join(runDir, "plans", "s1.md"), "utf8")).toContain('"owns":["packages/x/**"]');
    expect(existsSync(prepared.cwd)).toBe(false);
  });
});
