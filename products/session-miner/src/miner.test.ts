import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { invokeCommand } from "@titan-design/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { drainIngest, drainTemplates } from "./commands/drain.js";
import { refresh } from "./commands/refresh.js";
import { search } from "./commands/search.js";
import { sessionList, sessionShow } from "./commands/sessions.js";
import { status } from "./commands/status.js";
import { resolveConfig, type MinerConfig } from "./config.js";
import { createMinerContext, type MinerContext } from "./context.js";
import { startMiner } from "./serve.js";

const REPO = path.join(os.tmpdir(), "titan-miner-fixture-repo");
mkdirSync(path.join(REPO, ".git"), { recursive: true });
writeFileSync(path.join(REPO, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/demo.git\n');

const base = (f: Record<string, unknown>) => ({ sessionId: "s1", cwd: REPO, gitBranch: "main", ...f });
const assistant = (ts: string, content: unknown[]) =>
  base({ type: "assistant", timestamp: ts, message: { role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content } });
const toolResult = (ts: string, id: string, text: string, error = false) =>
  base({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: text }] } });

const LINES = [
  base({ type: "ai-title", aiTitle: "Fix the flaky suite", timestamp: "2026-07-01T00:00:00Z" }),
  base({ type: "user", uuid: "p1", timestamp: "2026-07-01T00:00:01Z", message: { role: "user", content: "the vitest suite in packages/registry is flaky" } }),
  assistant("2026-07-01T00:00:02Z", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }]),
  toolResult("2026-07-01T00:00:03Z", "t1", "FAIL src/a.test.ts\nTypeError: Cannot read properties of undefined (reading 'x')\n  at Object.<anonymous> (src/a.test.ts:10:5)", true),
  assistant("2026-07-01T00:00:04Z", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test" } }]),
  toolResult("2026-07-01T00:00:05Z", "t2", "FAIL src/b.test.ts\nTypeError: Cannot read properties of undefined (reading 'y')\n  at Object.<anonymous> (src/b.test.ts:22:9)", true),
  assistant("2026-07-01T00:00:06Z", [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: `${REPO}/src/a.ts` } }]),
  toolResult("2026-07-01T00:00:07Z", "t3", "ok"),
  assistant("2026-07-01T00:00:08Z", [{ type: "text", text: "fixed the undefined access" }]),
];

let dir: string;
let config: MinerConfig;
let ctx: MinerContext;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-"));
  const corpus = path.join(dir, "corpus", "proj");
  mkdirSync(corpus, { recursive: true });
  writeFileSync(path.join(corpus, "s1.jsonl"), LINES.map((l) => JSON.stringify(l)).join("\n") + "\n");
  config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, {});
  ctx = createMinerContext(config);
});
afterEach(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = <A, R>(cmd: Parameters<typeof invokeCommand<MinerContext>>[0], args: A) => invokeCommand(cmd, args, ctx) as Promise<{ envelope: { ok: boolean; data?: R; error?: string }; exitCode: number }>;

describe("session-miner commands", () => {
  it("refreshes, reports status, lists and shows sessions, and searches with locators that read back", async () => {
    const refreshed = await run(refresh, {});
    expect(refreshed.envelope).toMatchObject({ ok: true, data: { indexed: 1, facts: LINES.length } });

    const st = await run<Record<string, never>, { sessions: number; transcripts: Record<string, number>; edges: number }>(status, {});
    expect(st.envelope.data).toMatchObject({ sessions: 1, transcripts: { ok: 1 } });
    expect(st.envelope.data!.edges).toBeGreaterThan(0);

    const list = await run<{ limit: number }, { sessionId: string; title: string | null }[]>(sessionList, { limit: 5 });
    expect(list.envelope.data).toEqual([expect.objectContaining({ sessionId: "s1", title: "Fix the flaky suite" })]);

    const shown = await run<{ id: string }, { turns: unknown[]; edges: { relation: string }[]; usage: unknown[] }>(sessionShow, { id: "s1" });
    expect(shown.envelope.data!.turns).toHaveLength(1);
    expect(shown.envelope.data!.edges.map((e) => e.relation)).toContain("touched");
    expect((await run(sessionShow, { id: "nope" })).exitCode).toBe(66);

    const found = await run<{ query: string; limit: number }, { hits: { ref: string; sources: string[]; excerpt: string | null; locator: unknown }[]; degraded: unknown[] }>(search, { query: "flaky vitest", limit: 5 });
    expect(found.envelope.data!.degraded).toEqual([]);
    const top = found.envelope.data!.hits[0]!;
    expect(top.ref).toBe("session:s1");
    expect(top.sources).toContain("fts");
    expect(top.locator).not.toBeNull();
    expect(top.excerpt).toContain("flaky");
  });

  it("clusters recurring tool errors into one template and persists the clusterer across runs", async () => {
    await run(refresh, {});
    const first = await run<{ limit?: number }, { candidates: number; clustered: number; newTemplates: number; templates: number }>(drainIngest, {});
    expect(first.envelope.data).toMatchObject({ candidates: 2, clustered: 2, newTemplates: 1, templates: 1 });

    const again = await run<{ limit?: number }, { candidates: number }>(drainIngest, {});
    expect(again.envelope.data!.candidates).toBe(0);

    const templates = await run<{ limit: number }, { maskedSignature: string; occurrenceCount: number }[]>(drainTemplates, { limit: 5 });
    expect(templates.envelope.data![0]).toMatchObject({ occurrenceCount: 2 });
    expect(templates.envelope.data![0]!.maskedSignature).toContain("TypeError");
  });
});

describe("cli", () => {
  it("runs a registry command with --json and maps flags through the schema", async () => {
    const out: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: () => undefined, env: {} };
    const code = await runCli(["--json", "--state", config.stateDir, "--corpus", config.corpusRoot, "refresh", "--limit", "1"], io);
    expect(code).toBe(0);
    const envelope = JSON.parse(out.join("")) as { ok: boolean; data: { indexed: number } };
    expect(envelope).toMatchObject({ ok: true, data: { indexed: 1 } });
    expect(await runCli(["--state", config.stateDir, "session", "show", "missing"], io)).toBe(66);
    expect(await runCli(["definitely-not-a-command"], io)).toBe(64);
  });
});

describe("daemon", () => {
  it("serves the registry over /rpc and lists MCP tools on an ephemeral port", async () => {
    await run(refresh, {});
    const handle = await startMiner(config, { port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/rpc/status`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; data: { sessions: number } };
      expect(body).toMatchObject({ ok: true, data: { sessions: 1 } });
      const health = (await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()) as { sessions?: number };
      expect(health.sessions).toBe(1);
      const bad = await fetch(`http://127.0.0.1:${handle.port}/rpc/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 5 }) });
      expect(bad.status).toBe(400);
    } finally {
      await handle.close();
    }
  });
});
