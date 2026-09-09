import { invokeCommand } from "@titan-design/registry";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveConfig, type MinerConfig } from "../config.js";
import { createMinerContext, type MinerContext } from "../context.js";
import { drainIngest } from "./drain.js";
import { playbookAdd, playbookRecall, playbookReflect, playbookStatus, type BulletView, type ReflectResponse } from "./playbook.js";
import { refresh } from "./refresh.js";

const REPO = path.join(os.tmpdir(), "titan-playbook-fixture-repo");
mkdirSync(path.join(REPO, ".git"), { recursive: true });
writeFileSync(path.join(REPO, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/demo.git\n');

const base = (f: Record<string, unknown>) => ({ sessionId: "s1", cwd: REPO, gitBranch: "main", ...f });
const assistant = (ts: string, content: unknown[]) =>
  base({ type: "assistant", timestamp: ts, message: { role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content } });
const toolResult = (ts: string, id: string, text: string, error = false) =>
  base({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: text }] } });

const LINES = [
  base({ type: "ai-title", aiTitle: "Fix the flaky suite", timestamp: "2026-07-01T00:00:00Z" }),
  base({ type: "user", uuid: "p1", timestamp: "2026-07-01T00:00:01Z", message: { role: "user", content: "the vitest suite is flaky" } }),
  assistant("2026-07-01T00:00:02Z", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }]),
  toolResult("2026-07-01T00:00:03Z", "t1", "FAIL src/a.test.ts\nTypeError: Cannot read properties of undefined (reading 'x')", true),
  assistant("2026-07-01T00:00:04Z", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test" } }]),
  toolResult("2026-07-01T00:00:05Z", "t2", "FAIL src/b.test.ts\nTypeError: Cannot read properties of undefined (reading 'y')", true),
  assistant("2026-07-01T00:00:06Z", [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: `${REPO}/src/a.ts` } }]),
  toolResult("2026-07-01T00:00:07Z", "t3", "ok"),
];

let dir: string;
let config: MinerConfig;
let ctx: MinerContext;

function makeContext(options: Parameters<typeof createMinerContext>[1] = {}): MinerContext {
  return createMinerContext(config, options);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-playbook-"));
  const corpus = path.join(dir, "corpus", "proj");
  mkdirSync(corpus, { recursive: true });
  writeFileSync(path.join(corpus, "s1.jsonl"), LINES.map((l) => JSON.stringify(l)).join("\n") + "\n");
  config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, {});
  ctx = makeContext();
});

afterEach(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = <A, R>(cmd: Parameters<typeof invokeCommand<MinerContext>>[0], args: A, on: MinerContext = ctx) =>
  invokeCommand(cmd, args, on) as Promise<{ envelope: { ok: boolean; data?: R; error?: string }; exitCode: number }>;

describe("playbook commands", () => {
  it("adds a rule, recalls it by topic, and reports it in status", async () => {
    const added = await run<Record<string, unknown>, { report: { added: string[] } }>(playbookAdd, {
      content: "Pin the npm major in release jobs",
      category: "ci",
      tags: ["release"],
    });
    expect(added.envelope.data!.report.added).toHaveLength(1);

    const recalled = await run<Record<string, unknown>, { bullets: BulletView[] }>(playbookRecall, { query: "npm release" });
    expect(recalled.envelope.data!.bullets.map((b) => b.content)).toEqual(["Pin the npm major in release jobs"]);
    expect(recalled.envelope.data!.bullets[0]).toMatchObject({ category: "ci", maturity: "candidate" });

    const st = await run<Record<string, never>, { total: number; byMaturity: Record<string, number> }>(playbookStatus, {});
    expect(st.envelope.data).toMatchObject({ total: 1, byMaturity: { candidate: 1 }, blocked: 0 });
  });

  it("stamps provenance from the miner's own session ref and byte offset", async () => {
    await run(refresh, {});
    await run(playbookAdd, { content: "Rerun the suite before blaming the test", session: "s1" });
    const bullet = ctx.playbook().list()[0]!;
    expect(bullet.sourceSessions).toEqual([{ sessionRef: "session:s1", byteOffset: 0 }]);
  });

  it("keeps an unknown session out of the provenance rather than inventing an offset", async () => {
    await run(playbookAdd, { content: "x", session: "ghost" });
    expect(ctx.playbook().list()[0]!.sourceSessions).toEqual([{ sessionRef: "session:ghost" }]);
  });

  it("folds a restatement into feedback instead of a second rule", async () => {
    await run(playbookAdd, { content: "Always run the linter before pushing a branch" });
    const second = await run<Record<string, unknown>, { report: { added: string[]; reinforced: string[] } }>(playbookAdd, {
      content: "always run the linter before pushing a branch",
    });
    expect(second.envelope.data!.report).toMatchObject({ added: [], reinforced: [expect.any(String)] });
    expect(ctx.playbook().list()).toHaveLength(1);
  });

  it("records an anti-pattern and returns it separately from the rules", async () => {
    await run(playbookAdd, { content: "Force-push a shared branch to fix history", negative: true });
    const recalled = await run<Record<string, unknown>, { bullets: BulletView[]; antiPatterns: BulletView[] }>(playbookRecall, { query: "force-push history" });
    expect(recalled.envelope.data!.bullets).toEqual([]);
    expect(recalled.envelope.data!.antiPatterns).toHaveLength(1);
  });
});

describe("playbook over the CLI", () => {
  it("adds with comma-separated tags and recalls through the command line", async () => {
    const out: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: () => undefined, env: {} };
    const argv = ["--json", "--state", config.stateDir, "--corpus", config.corpusRoot];
    expect(await runCli([...argv, "playbook", "add", "Pin npm to 11 in release jobs", "--tag", "ci,release"], io)).toBe(0);
    out.length = 0;
    expect(await runCli([...argv, "playbook", "recall", "npm release"], io)).toBe(0);
    const envelope = JSON.parse(out.join("")) as { ok: boolean; data: { bullets: BulletView[] } };
    expect(envelope.data.bullets[0]).toMatchObject({ content: "Pin npm to 11 in release jobs", tags: ["ci", "release"] });
  });
});

describe("playbook.reflect", () => {
  it("builds a diary from the session subgraph with graph-derived labels and applies nothing by default", async () => {
    await run(refresh, {});
    await run(drainIngest, {});
    const reflected = await run<Record<string, unknown>, ReflectResponse>(playbookReflect, { session: "s1" });
    const data = reflected.envelope.data!;
    expect(data.applied).toBe(false);
    expect(data.outcome).toMatchObject({ status: "failure", errorCount: 2, distinctErrors: 1, prsMerged: 0 });
    expect(data.diary).toContain("# Session session:s1");
    expect(data.diary).toContain("Fix the flaky suite");
    expect(data.diary).toContain("## Recurring errors");
    expect(ctx.playbook().list()).toEqual([]);
  });

  it("exits 66 for a session that is not indexed", async () => {
    expect((await run(playbookReflect, { session: "nope" })).exitCode).toBe(66);
  });

  it("applies a supplied reflector's deltas with curator-stamped provenance", async () => {
    await run(refresh, {});
    const seen: string[] = [];
    const reflector = async (input: { diary: string; iteration: number }) => {
      seen.push(input.diary);
      return input.iteration === 1 ? [{ type: "add", content: "Read the error before rerunning the same command", tags: ["debug"] }] : [];
    };
    const withReflector = makeContext({ reflector });
    try {
      const reflected = await run<Record<string, unknown>, ReflectResponse>(playbookReflect, { session: "s1", dryRun: false }, withReflector);
      expect(reflected.envelope.data!.applied).toBe(true);
      expect(reflected.envelope.data!.added).toHaveLength(1);
      expect(seen[0]).toContain("# Session session:s1");
      const bullet = withReflector.playbook().list()[0]!;
      expect(bullet.content).toBe("Read the error before rerunning the same command");
      expect(bullet.sourceSessions).toEqual([{ sessionRef: "session:s1", byteOffset: 0 }]);
    } finally {
      withReflector.close();
    }
  });

  it("reports invalid reflector output as a warning instead of failing", async () => {
    await run(refresh, {});
    const withReflector = makeContext({ reflector: async () => [{ type: "add" }] });
    try {
      const reflected = await run<Record<string, unknown>, ReflectResponse>(playbookReflect, { session: "s1", dryRun: false }, withReflector);
      expect(reflected.envelope.ok).toBe(true);
      expect(reflected.envelope.data!.added).toEqual([]);
      expect(withReflector.warnings.join(" ")).toContain("rejected");
    } finally {
      withReflector.close();
    }
  });

  it("leaves the session graph untouched: the playbook is strictly downstream", async () => {
    await run(refresh, {});
    const countRows = () => {
      const g = ctx.graph();
      const q = (sql: string) => (g.db.prepare(sql).get() as { n: number }).n;
      return { facts: q("SELECT COUNT(*) AS n FROM fact"), edges: q("SELECT COUNT(*) AS n FROM edge"), sessions: q("SELECT COUNT(*) AS n FROM session") };
    };
    const before = countRows();
    await run(playbookAdd, { content: "Something the graph must not learn about", session: "s1" });
    await run(playbookReflect, { session: "s1" });
    expect(countRows()).toEqual(before);
  });
});
