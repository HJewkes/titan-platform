import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rescoreRun } from "./cli-rescore.js";
import { JOB_SCHEMA } from "./ledger.js";
import { loadReviewQueue } from "./review/cases.js";

const HEAD = "a".repeat(40);
const SESSION = "00000000-0000-4000-8000-000000000001";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bench-rescore-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeCases(): string {
  const tree = join(root, "tree");
  mkdirSync(join(tree, "head", "src"), { recursive: true });
  writeFileSync(join(tree, "head", "src", "gold.ts"), "export const gold = 1;\n");
  const casesDir = join(root, "cases");
  mkdirSync(casesDir);
  const body = { id: "widgets-defect", caseType: "defect", kind: "feature", repo: "acme/widgets", pr: 7, head: HEAD, base: "b".repeat(40), split: "dev", gold: [{ path: "src/gold.ts" }], tree };
  writeFileSync(join(casesDir, "queue.jsonl"), `${JSON.stringify(body)}\n`);
  return casesDir;
}

function writeRun(casesDir: string, message: string): string {
  const [benchCase] = loadReviewQueue(casesDir);
  const runDir = join(root, "run");
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  const row = { schema: JOB_SCHEMA, track: "r", arm: { id: "S-med" }, caseId: benchCase?.id, caseHash: benchCase?.hash, attempt: 1, sessionId: SESSION, outcome: "ok" };
  const infra = { ...row, sessionId: "00000000-0000-4000-8000-000000000002", outcome: "infra" };
  writeFileSync(join(runDir, "jobs.jsonl"), `${JSON.stringify(infra)}\n${JSON.stringify(row)}\n`);
  writeFileSync(join(runDir, "artifacts", `${SESSION}.md`), message);
  writeFileSync(join(runDir, "scores.jsonl"), "stale\n");
  return runDir;
}

describe("bench rescore", () => {
  it("rewrites scores.jsonl from the saved final messages with all three catch levels", async () => {
    const casesDir = writeCases();
    const runDir = writeRun(casesDir, `1. src/gold.ts drops the error.\n\nVerdict: FIX_FIRST\nPR: acme/widgets#7\nHead: ${HEAD}`);

    const count = await rescoreRun({ track: "r", run: runDir, cases: casesDir });

    const rows = readFileSync(join(runDir, "scores.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(count).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ arm: "S-med", caseId: "widgets-defect", attempt: 1, outcome: "ok", result: { caughtVerdict: true, caughtPath: true, caught: false } });
  });
});
