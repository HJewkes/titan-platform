import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveConfig, type MinerConfig } from "../config.js";
import { createMinerContext } from "../context.js";
import { assignmentFaults, graphFaults, parseAssignments, type DataQualityReport, type GraphFacts } from "./data-quality.js";
import { seedEventsDb, seedInsightGraph } from "./fixture.js";

let dir: string;
let config: MinerConfig;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-data-quality-"));
  env = { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), []) };
  config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, env);
  const ctx = createMinerContext(config);
  seedInsightGraph(ctx.graph().db);
  ctx.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NEWEST_REQUEST = "2026-09-10T03:01:00Z";

async function dataQuality(flags: string[]): Promise<{ code: number; answer: DataQualityReport; text: string }> {
  const run = async (format: string[]) => {
    let stdout = "";
    const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env };
    const code = await runCli(["--state", config.stateDir, "--corpus", config.corpusRoot, ...format, "insights", "data-quality", ...flags], io);
    return { code, stdout };
  };
  const json = await run(["--json"]);
  const text = await run([]);
  return { code: json.code, answer: (JSON.parse(json.stdout) as { data: { answer: DataQualityReport } }).data.answer, text: text.stdout };
}

function assignment(overrides: Record<string, unknown>): string {
  return JSON.stringify({ seat: "coord-a", agent: "impl-beta", task: "T-1", kind: "feature", initiative: "demo", outcome: "merged", value: null, pr: "acme/widget#1", ts: null, ...overrides });
}

describe("insights data-quality on the graph", () => {
  it("reports no faults on a fresh, priced, fully indexed graph", async () => {
    const { code, answer, text } = await dataQuality(["--until", "2026-09-10T03:31:00Z"]);

    expect(code).toBe(0);
    expect(answer.faults).toEqual([]);
    expect(answer.newestRequest).toBe(NEWEST_REQUEST);
    expect(text).toContain("no faults");
  });

  it("flags a graph whose newest request trails --until by more than the default 60 minutes", async () => {
    const { answer } = await dataQuality(["--until", "2026-09-10T04:31:00Z"]);

    expect(answer.faults).toMatchObject([{ fault: "graph-stale", severity: "error" }]);
  });

  it("honours --max-lag", async () => {
    expect((await dataQuality(["--until", "2026-09-10T04:31:00Z", "--max-lag", "120"])).answer.faults).toEqual([]);
  });

  it("flags a discovered transcript the graph never indexed", async () => {
    const project = path.join(config.corpusRoot, "-tmp-demo");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "11111111-1111-1111-1111-111111111111.jsonl"), "");
    try {
      const { answer } = await dataQuality(["--until", "2026-09-10T03:31:00Z"]);

      expect(answer.faults).toMatchObject([{ fault: "transcripts-unindexed", severity: "warn" }]);
      expect(answer.coverage.transcriptsDiscovered).toBe(1);
    } finally {
      rmSync(config.corpusRoot, { recursive: true, force: true });
    }
  });

  it("checks an --assignments file against the schema, the outcome set and the graph", async () => {
    const file = path.join(dir, "assignments.jsonl");
    const lines = [assignment({}), assignment({ agent: undefined }), "not json", assignment({ outcome: "merged-ish", agent: "ghost-1" }), ""];
    writeFileSync(file, lines.join("\n"));

    const { answer } = await dataQuality(["--until", "2026-09-10T03:31:00Z", "--assignments", file]);

    expect(answer.faults.map((f) => f.fault)).toEqual(["assignment-invalid", "assignment-outcome-unknown", "agent-unmatched"]);
    expect(answer.faults[0]!.evidence).toMatch(/^2 lines .*: 2, 3$/);
    expect(answer.faults[1]!.evidence).toBe('"merged-ish" x1');
    expect(answer.faults[2]!.evidence).toContain("ghost-1");
  });
});

const FRESH: GraphFacts = {
  asOf: "2026-09-10T02:00:00.000Z",
  maxLagMinutes: 60,
  newestRequest: "2026-09-10T01:30:00.000Z",
  unindexed: [],
  report: { coverage: { transcriptsIndexed: 1, transcriptsDiscovered: 1, facetBacklog: 0 }, unpricedModels: [] },
};

describe("graph faults", () => {
  it.each([
    ["30 min", "2026-09-10T01:30:00.000Z", []],
    ["90 min", "2026-09-10T00:30:00.000Z", ["graph-stale"]],
    ["no request at all", null, ["graph-stale"]],
  ])("treats a newest request %s before asOf by the lag", (_case, newestRequest, faults) => {
    expect(graphFaults({ ...FRESH, newestRequest }).map((f) => f.fault)).toEqual(faults);
  });

  it("flags a facet backlog and each unpriced model with requests", () => {
    const report = { coverage: { ...FRESH.report.coverage, facetBacklog: 3 }, unpricedModels: [{ model: "claude-haiku-9-9", requests: 4, tokens: 10 }] };

    const faults = graphFaults({ ...FRESH, report });

    expect(faults).toMatchObject([
      { fault: "facet-backlog", severity: "warn" },
      { fault: "unpriced-model", severity: "error", evidence: "4 requests on claude-haiku-9-9" },
    ]);
  });
});

describe("assignment faults", () => {
  const known = new Set(["merged", "done"]);

  it("counts a line missing its agent once without throwing", () => {
    const file = parseAssignments([assignment({ agent: undefined }), assignment({})].join("\n"));

    expect(file.invalidLines).toEqual([1]);
    expect(file.assignments).toHaveLength(1);
  });

  it("flags a free-text or null outcome but not a known one", () => {
    const file = parseAssignments([assignment({ outcome: "merged" }), assignment({ outcome: "merged-ish" }), assignment({ outcome: null })].join("\n"));

    const faults = assignmentFaults(file, known, []);

    expect(faults).toMatchObject([{ fault: "assignment-outcome-unknown", evidence: '"(null)" x1, "merged-ish" x1' }]);
  });

  it("accepts an outcome the caller adds to the known set", () => {
    const file = parseAssignments(assignment({ outcome: "parked" }));

    expect(assignmentFaults(file, new Set([...known, "parked"]), [])).toEqual([]);
  });
});
