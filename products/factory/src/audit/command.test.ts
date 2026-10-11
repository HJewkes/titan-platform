import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../cli.js";
import { AUDIT_INPUT, fakeAuditPorts, type FakeAuditPorts } from "../test-support/audit.js";
import { auditRoutes } from "./routes.js";
import { measurementAuditWorkflow } from "./workflow.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-cli-"));
  dirs.push(dir);
  return dir;
}

function inputFile(input: object): string {
  const path = join(tempDir(), "shepherd.json");
  writeFileSync(path, JSON.stringify(input));
  return path;
}

async function cli(argv: string[], ports: FakeAuditPorts = fakeAuditPorts(), db = ":memory:"): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { stdout: (text) => void (out += text), stderr: (text) => void (err += text), env: {} };
  const deps = { workflows: [measurementAuditWorkflow()], routes: auditRoutes(ports), host: { gatePollMs: 5 }, presence: async () => undefined };
  const code = await runCli(["--db", db, ...argv], io, deps);
  return { code, out, err };
}

describe("titan-factory audit", () => {
  it("runs the audit up to the owner's review gate and prints the counts and the resolve command", async () => {
    const { code, out } = await cli(["audit", "shepherd", "--input", inputFile(AUDIT_INPUT), "--out", "/reports/shepherd.json"]);

    expect(code).toBe(0);
    expect(out).toMatch(/measurement-audit shepherd: paused/);
    expect(out).toContain("44 metrics: 20 Y, 16 P, 8 N; 12 slices");
    expect(out).toMatch(/titan-factory gate resolve \S+ audit-review --json/);
    expect(out).toContain("then titan-factory resume writes the report to /reports/shepherd.json");
  });

  it("writes the report to --out when a later resume publishes it after the owner's review", async () => {
    const ports = fakeAuditPorts();
    const db = join(tempDir(), "factory.sqlite3");
    const audited = await cli(["audit", "shepherd", "--input", inputFile(AUDIT_INPUT), "--out", "/reports/shepherd.json"], ports, db);
    const runId = /run (\S+) measurement-audit/.exec(audited.out)![1]!;

    await cli(["gate", "resolve", runId, "audit-review", "--json", '{"decision":"publish"}'], ports, db);
    const resumed = await cli(["resume"], ports, db);

    expect(resumed.out).toContain(`resumed ${runId} measurement-audit: completed`);
    expect(JSON.parse(ports.written.get("/reports/shepherd.json")!)).toMatchObject({ schema: "titan.measurement-audit/v1", system: "shepherd" });
  });

  it("refuses to start an audit without --out, since nothing would show the published report", async () => {
    const ports = fakeAuditPorts();
    const { code, err } = await cli(["audit", "shepherd", "--input", inputFile(AUDIT_INPUT)], ports);

    expect(code).toBe(2);
    expect(err).toContain("--out <file>");
    expect(ports.written.size).toBe(0);
  });

  it("refuses an input file written for another area", async () => {
    const { code, err } = await cli(["audit", "agent-chat", "--input", inputFile(AUDIT_INPUT), "--out", "/reports/agent-chat.json"]);

    expect(code).toBe(2);
    expect(err).toContain('input is for "shepherd", not "agent-chat"');
  });
});
