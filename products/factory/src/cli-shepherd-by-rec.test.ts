import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BY_REC_ROW_SCHEMA, type ByRecRow } from "@titan-design/owner-queue";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerShepherdByRec } from "./cli-shepherd-by-rec.js";
import { appendByRecRow, byRecLogPath } from "./shepherd/by-rec-log.js";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function row(id: string, hoursAgo: number): ByRecRow {
  return {
    schema: BY_REC_ROW_SCHEMA,
    subject: { source: "gate", id, summary: `Merge o/r#1 (${id})` },
    recommendation: { answer: "merge", by: "rv-synthetic", rationale: "synthetic" },
    openedAt: new Date(NOW - (hoursAgo + 24) * 3_600_000).toISOString(),
    resolvedAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    facts: { head: "synthetic" },
    mode: "shadow",
    result: "would-resolve",
    resolver: { class: "automation", id: "auto-by-rec" },
  };
}

async function byRec(args: string[], rows: ByRecRow[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "factory-by-rec-cli-"));
  dirs.push(dir);
  for (const each of rows) appendByRecRow(byRecLogPath(dir), each);
  let out = "";
  const program = new Command();
  registerShepherdByRec(program, { stdout: (text) => void (out += text), stderr: () => undefined, env: {} }, () => join(dir, "factory.sqlite3"), () => NOW);
  await program.parseAsync(["node", "cli", "by-rec", ...args]);
  return out;
}

describe("shepherd by-rec", () => {
  it("prints every row as JSON, oldest first", async () => {
    const out = JSON.parse(await byRec(["--json"], [row("run-1/approve-merge", 30), row("run-2/approve-merge", 2)]));

    expect(out.rows.map((each: ByRecRow) => each.subject.id)).toEqual(["run-1/approve-merge", "run-2/approve-merge"]);
  });

  it("keeps only rows resolved inside --since", async () => {
    const out = JSON.parse(await byRec(["--json", "--since", "6h"], [row("run-1/approve-merge", 30), row("run-2/approve-merge", 2)]));

    expect(out.rows.map((each: ByRecRow) => each.subject.id)).toEqual(["run-2/approve-merge"]);
  });

  it("says so when the log is empty or missing", async () => {
    expect(await byRec([], [])).toBe("no auto-by-rec rows\n");
  });
});
