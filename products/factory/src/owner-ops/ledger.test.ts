import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerOp } from "@titan-design/owner-queue";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_OPS_LEDGER, ownerOpsLedger, runLogged } from "./ledger.js";

const OP: OwnerOp = { kind: "close-pr", repo: "example-org/example-repo", pr: 7, headSha: "a".repeat(40) };
const NOW = () => Date.parse("2026-10-18T12:00:00.000Z");

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-owner-ops-"));
  dirs.push(dir);
  return dir;
}

const lines = (dir: string): unknown[] =>
  readFileSync(join(dir, OWNER_OPS_LEDGER), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

describe("owner-ops ledger", () => {
  it("has the started line on disk before an effect that throws, and no done line after it", async () => {
    const dir = stateDir();
    const seen: unknown[][] = [];
    const effect = async (): Promise<object> => {
      seen.push(lines(dir));
      throw new Error("synthetic effect failure");
    };

    await expect(runLogged(ownerOpsLedger(dir), { actionId: "act-1", op: OP, now: NOW }, effect)).rejects.toThrow("synthetic effect failure");

    const started = { at: "2026-10-18T12:00:00.000Z", actionId: "act-1", phase: "started", kind: "close-pr", target: { repo: OP.repo, pr: 7, headSha: "a".repeat(40) } };
    expect(seen).toEqual([[started]]);
    expect(lines(dir)).toEqual([started]);
  });

  it("appends done with the effect's result after it returns, keeping earlier lines", async () => {
    const dir = stateDir();
    const ledger = ownerOpsLedger(dir);
    await runLogged(ledger, { actionId: "act-0", op: OP, now: NOW }, async () => ({ outcome: "gone", reason: "synthetic" }));

    const result = await runLogged(ledger, { actionId: "act-1", op: OP, now: NOW }, async () => ({ outcome: "already", runId: "run-1" }));

    expect(result).toEqual({ outcome: "already", runId: "run-1" });
    expect(lines(dir)).toMatchObject([
      { actionId: "act-0", phase: "started" },
      { actionId: "act-0", phase: "done" },
      { actionId: "act-1", phase: "started" },
      { actionId: "act-1", phase: "done", result: { outcome: "already", runId: "run-1" } },
    ]);
  });
});
