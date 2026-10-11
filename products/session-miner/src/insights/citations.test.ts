import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { verifyCitationsCommand } from "../commands/verify-citations.js";
import { resolveConfig, type MinerConfig } from "../config.js";
import { createMinerContext } from "../context.js";
import { findingSchema, verifyCitations, type Citation, type CitationRunner, type Finding } from "./citations.js";
import { FIXTURE_WINDOW, seedEventsDb, seedInsightGraph } from "./fixture.js";

const ANSWER = { totals: { usd: 100, sessions: 3 }, byRole: [{ role: "worker:implementer", model: "claude-opus-5-5" }], "a/b": 1 };

function finding(citations: Partial<Citation>[], overrides: Partial<Finding> = {}): Finding {
  return findingSchema.parse({
    id: "F1",
    claim: "implementers spend most",
    falsifier: "reviewers outspend implementers in the same window",
    citations: citations.map((c) => ({ question: "spend-by-action", args: { since: "2026-09-10" }, field: "/totals/usd", value: 100, ...c })),
    ...overrides,
  });
}

function fakeRunner(answers: Record<string, unknown> = { "spend-by-action": ANSWER }): CitationRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = async (question: string) => {
    calls.push(question);
    return question in answers ? { answer: answers[question] } : undefined;
  };
  return Object.assign(run, { calls });
}

async function statuses(citations: Partial<Citation>[], run: CitationRunner = fakeRunner()): Promise<string[]> {
  const report = await verifyCitations([finding(citations)], run);
  return report.findings[0]!.citations.map((c) => c.status);
}

describe("verifyCitations", () => {
  it("accepts a number within 1 percent of the re-run and rejects one 2 percent off", async () => {
    expect(await statuses([{ value: 100.9 }, { value: 98 }])).toEqual(["ok", "mismatch"]);
  });

  it("honours a citation's own tolerance", async () => {
    expect(await statuses([{ value: 98, tolerance: 0.05 }])).toEqual(["ok"]);
  });

  it("matches strings exactly and reports the actual value on a mismatch", async () => {
    const report = await verifyCitations([finding([{ field: "/byRole/0/model", value: "claude-opus-5-5" }, { field: "/byRole/0/role", value: "worker" }])], fakeRunner());

    expect(report.findings[0]!.citations.map((c) => [c.status, c.actual])).toEqual([
      ["ok", "claude-opus-5-5"],
      ["mismatch", "worker:implementer"],
    ]);
  });

  it("reports a pointer that resolves to nothing as missing-field", async () => {
    expect(await statuses([{ field: "/totals/nope" }, { field: "/byRole/7/model" }])).toEqual(["missing-field", "missing-field"]);
  });

  it("unescapes ~1 in a pointer token", async () => {
    expect(await statuses([{ field: "/a~1b", value: 1 }])).toEqual(["ok"]);
  });

  it("reports an unregistered question as unknown-question instead of throwing", async () => {
    expect(await statuses([{ question: "no-such-question" }])).toEqual(["unknown-question"]);
  });

  it("reports a failed run as error with its message", async () => {
    const report = await verifyCitations([finding([{}])], async () => Promise.reject(new Error("events db not found")));

    expect(report.findings[0]!.citations[0]).toMatchObject({ status: "error", detail: "events db not found" });
  });

  it("runs a question once for citations sharing its args, and again for different args", async () => {
    const run = fakeRunner();

    await verifyCitations(
      [finding([{}, { field: "/totals/sessions", value: 3, args: { since: "2026-09-10" } }]), finding([{ args: { since: "2026-09-09" } }], { id: "F2" })],
      run,
    );

    expect(run.calls).toEqual(["spend-by-action", "spend-by-action"]);
  });

  it("marks the report and the finding not ok when any citation is not ok", async () => {
    const report = await verifyCitations([finding([{}]), finding([{}, { value: 1 }], { id: "F2" })], fakeRunner());

    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.ok)).toEqual([true, false]);
  });
});

describe("findingSchema", () => {
  const base = { id: "F1", claim: "c", falsifier: "f", citations: [{ question: "q", field: "/x", value: 1 }] };

  it.each([
    ["an empty falsifier", { falsifier: "" }],
    ["a blank falsifier", { falsifier: "   " }],
    ["no citation", { citations: [] }],
    ["a field that is not a JSON pointer", { citations: [{ question: "q", field: "x", value: 1 }] }],
  ])("rejects a finding with %s", (_case, overrides) => {
    expect(findingSchema.safeParse({ ...base, ...overrides }).success).toBe(false);
  });

  it("defaults a citation's args to an empty object", () => {
    expect(findingSchema.parse(base).citations[0]!.args).toEqual({});
  });
});

describe("insights verify-citations", () => {
  let dir: string;
  let config: MinerConfig;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-citations-"));
    env = { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), []) };
    config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, env);
    const ctx = createMinerContext(config);
    seedInsightGraph(ctx.graph().db);
    ctx.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function findingsFile(name: string, sessions: number): string {
    const file = path.join(dir, name);
    const args = { "--since": FIXTURE_WINDOW.since, "--until": FIXTURE_WINDOW.until, "agent-prefix": "rev-" };
    const citations = [{ question: "spend-by-action", args, field: "/totals/sessions", value: sessions }];
    writeFileSync(file, JSON.stringify([{ id: "F1", claim: "one reviewer session", falsifier: "more than one", citations }]));
    return file;
  }

  async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const io = { stdout: (t: string) => void (stdout += t), stderr: (t: string) => void (stderr += t), env };
    const code = await runCli(["--state", config.stateDir, "--corpus", config.corpusRoot, ...args], io);
    return { code, stdout, stderr };
  }

  it("exits zero when every citation re-runs to the cited value", async () => {
    const { code, stdout } = await cli(["--json", "insights", "verify-citations", "--findings", findingsFile("good.json", 1)]);

    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(stdout).data).toMatchObject({ ok: true, findings: [{ id: "F1", citations: [{ status: "ok", actual: 1 }] }] });
  });

  it("exits non-zero and names the mismatch when a citation does not re-run", async () => {
    const { code, stdout, stderr } = await cli(["insights", "verify-citations", "--findings", findingsFile("bad.json", 2)]);

    expect(code).not.toBe(EXIT.OK);
    expect(stdout + stderr).toContain("F1: mismatch spend-by-action /totals/sessions cited 2, actual 1");
  });

  it("is refused off the CLI, since it reads a local file", async () => {
    const ctx = createMinerContext(config);
    const { exitCode } = await invokeCommand(verifyCitationsCommand, { findings: path.join(dir, "good.json") }, ctx);
    ctx.close();

    expect(exitCode).toBe(EXIT.DATAERR);
  });
});
