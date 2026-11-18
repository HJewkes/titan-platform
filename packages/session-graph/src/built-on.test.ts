import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { PR_HEAD_MIGRATION_NAME } from "./pr-head-schema.js";
import { refreshCorpus } from "./refresh.js";
import { MIGRATIONS } from "./schema.js";

let dir: string;
let repo: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-built-on-"));
  repo = path.join(dir, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeFileSync(path.join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/demo.git\n');
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const line = (fields: Record<string, unknown>) => ({ sessionId: "s1", cwd: repo, gitBranch: "feat/current", ...fields });
const call = (id: string, command: string) =>
  line({
    type: "assistant", timestamp: "2026-07-01T00:00:01Z", requestId: `req-${id}`,
    message: { role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  });
const created = (id: string, number: number) =>
  line({
    type: "user", timestamp: "2026-07-01T00:00:02Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `https://github.com/acme/demo/pull/${number}` }] },
    toolUseResult: { gitOperation: { pr: { action: "created", number, url: `https://github.com/acme/demo/pull/${number}` } } },
  });
const failed = (id: string) =>
  line({
    type: "user", timestamp: "2026-07-01T00:00:02Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "a pull request already exists" }] },
  });

async function index(lines: unknown[]): Promise<void> {
  const absolutePath = path.join(dir, "s1.jsonl");
  writeFileSync(absolutePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const transcript: DiscoveredTranscript = { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account: null };
  await refreshCorpus(graph, [transcript]);
}

const builtOn = () =>
  graph.db.prepare("SELECT source_ref, target_ref, t_valid, attrs FROM edge WHERE relation = 'built_on' AND t_expired IS NULL ORDER BY source_ref").all();

describe("built_on edges (TP-80)", () => {
  it("links a created PR to the --head branch, keeping --base on the edge", async () => {
    await index([call("t1", "gh pr create --head feat/x --base develop --title 'Add x'"), created("t1", 12)]);

    expect(builtOn()).toEqual([
      { source_ref: "pr:acme/demo#12", target_ref: "branch:demo/feat/x", t_valid: "2026-07-01T00:00:01Z", attrs: '{"base":"develop"}' },
    ]);
  });

  it("reads the short -H form", async () => {
    await index([call("t1", "gh pr create -H feat/short --fill"), created("t1", 13)]);

    expect(builtOn()).toMatchObject([{ source_ref: "pr:acme/demo#13", target_ref: "branch:demo/feat/short", attrs: null }]);
  });

  it("uses the checked-out branch when the create names no head", async () => {
    await index([call("t1", "gh pr create --base main --title t"), created("t1", 14)]);

    expect(builtOn()).toMatchObject([{ source_ref: "pr:acme/demo#14", target_ref: "branch:demo/feat/current", attrs: '{"base":"main"}' }]);
  });

  it("writes no edge for a create that failed", async () => {
    await index([call("t1", "gh pr create --head feat/x --base main --title t"), failed("t1")]);

    expect(builtOn()).toEqual([]);
  });

  it("keeps one live edge however many passes reconcile it", async () => {
    await index([call("t1", "gh pr create --head feat/x --title t"), created("t1", 12)]);
    await refreshCorpus(graph, []);

    expect(builtOn()).toHaveLength(1);
  });
});

describe("migration 16", () => {
  it("adds the head, base and call time to a version 15 graph's pr_create_observation", () => {
    const file = path.join(dir, "graph.sqlite3");
    const db = openDatabase(file);
    runMigrations(db, MIGRATIONS.slice(0, 15));
    db.close();

    const migrated = openSessionGraph(file);
    const columns = migrated.db.prepare<[], { name: string }>("SELECT name FROM pragma_table_info('pr_create_observation')").all().map((c) => c.name);
    migrated.db.close();

    expect(columns).toEqual(expect.arrayContaining(["head_ref", "base", "created_at"]));
    expect(PR_HEAD_MIGRATION_NAME).toBe("pr create head branch");
  });
});
