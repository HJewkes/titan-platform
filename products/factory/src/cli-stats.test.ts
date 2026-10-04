import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { openFactoryHost } from "./host.js";
import { factoryRoutes, factoryWorkflows } from "./workflows.js";

function capture(): { out: string[]; err: string[]; io: Parameters<typeof runCli>[1] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: {} } };
}

describe("shepherd stats verb", () => {
  it("prints an empty report for a ledger with no runs", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const { out, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats", "--json"], io);

    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual([]);
  });

  it("refuses a malformed date", async () => {
    const { err, io } = capture();

    const code = await runCli(["--db", ":memory:", "shepherd", "stats", "--from", "yesterday"], io);

    expect(code).toBe(2);
    expect(err.join("")).toContain("YYYY-MM-DD");
  });
});
