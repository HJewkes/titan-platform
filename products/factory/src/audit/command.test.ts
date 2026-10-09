import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../cli.js";
import { AUDIT_INPUT, fakeAuditPorts } from "../test-support/audit.js";
import { auditRoutes } from "./routes.js";
import { measurementAuditWorkflow } from "./workflow.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function inputFile(input: object): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-cli-"));
  dirs.push(dir);
  const path = join(dir, "shepherd.json");
  writeFileSync(path, JSON.stringify(input));
  return path;
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { stdout: (text) => void (out += text), stderr: (text) => void (err += text), env: {} };
  const deps = { workflows: [measurementAuditWorkflow()], routes: auditRoutes(fakeAuditPorts()), host: { gatePollMs: 5 } };
  const code = await runCli(["--db", ":memory:", ...argv], io, deps);
  return { code, out, err };
}

describe("titan-factory audit", () => {
  it("runs the audit up to the owner's review gate and prints the counts and the resolve command", async () => {
    const { code, out } = await cli(["audit", "shepherd", "--input", inputFile(AUDIT_INPUT)]);

    expect(code).toBe(0);
    expect(out).toMatch(/measurement-audit shepherd: paused/);
    expect(out).toContain("44 metrics: 20 Y, 16 P, 8 N; 12 slices");
    expect(out).toMatch(/titan-factory gate resolve \S+ audit-review --json/);
  });

  it("refuses an input file written for another area", async () => {
    const { code, err } = await cli(["audit", "agent-chat", "--input", inputFile(AUDIT_INPUT)]);

    expect(code).toBe(2);
    expect(err).toContain('input is for "shepherd", not "agent-chat"');
  });
});
