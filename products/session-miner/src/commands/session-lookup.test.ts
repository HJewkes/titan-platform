import { invokeCommand } from "@titan-design/registry";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveConfig } from "../config.js";
import { createMinerContext, type MinerContext } from "../context.js";
import { createMinerRegistry } from "../registry.js";
import type { FileWriteHit, TaskSessionHit } from "./session-lookup.js";

let dir: string;
let ctx: MinerContext;
let nextOffset = 0;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-lookup-"));
  ctx = createMinerContext(resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, {}));
});
afterEach(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

function transcriptId(key: string): number {
  return ctx.graph().transcripts.ensure(key).sourceId;
}

function signal(sessionId: string, kind: string, filePath: string, toolUseId: string, ts: string, transcript = `${sessionId}.jsonl`): void {
  nextOffset += 10;
  ctx
    .graph()
    .db.prepare("INSERT INTO session_signal (transcript_id, byte_offset, block_index, session_id, ts, signal, detail, tool_use_id) VALUES (?, ?, 0, ?, ?, ?, ?, ?)")
    .run(transcriptId(transcript), nextOffset, sessionId, ts, kind, filePath, toolUseId);
}

function origin(sessionId: string, agentName: string, profile: string): void {
  ctx
    .graph()
    .db.prepare("INSERT INTO session_origin (session_id, origin_system, agent_name, profile, resolved_at) VALUES (?, 'agent-chat', ?, ?, '2026-01-01T00:00:00Z')")
    .run(sessionId, agentName, profile);
}

function ran(sessionId: string, taskId: string, source: string): void {
  ctx.graph().edges.assert({ sourceRef: `session:${sessionId}`, relation: "ran", targetRef: `task:${taskId}`, tValid: "2026-01-02T00:00:00Z", attrs: { source } });
}

async function run<R>(name: string, args: Record<string, unknown>): Promise<R> {
  const cmd = createMinerRegistry().get(name);
  if (!cmd) throw new Error(`unregistered ${name}`);
  const { envelope } = await invokeCommand(cmd, args, ctx);
  expect(envelope.ok).toBe(true);
  return z.custom<R>().parse(envelope.ok ? envelope.data : undefined);
}

describe("session.files", () => {
  it("returns every session that wrote the path, with locators and agent name", async () => {
    signal("s1", "file_write", "src/app.ts", "tu-1", "2026-01-01T01:00:00Z");
    signal("s2", "file_write", "src/app.ts", "tu-2", "2026-01-01T02:00:00Z");
    origin("s1", "alpha", "lite");

    const hits = await run<FileWriteHit[]>("session.files", { path: "src/app.ts" });

    expect(hits).toEqual([
      { sessionId: "s1", ts: "2026-01-01T01:00:00Z", toolUseId: "tu-1", source: "s1.jsonl", byteOffset: 10, agent: "alpha" },
      { sessionId: "s2", ts: "2026-01-01T02:00:00Z", toolUseId: "tu-2", source: "s2.jsonl", byteOffset: 20, agent: null },
    ]);
  });

  it("leaves out a session that only read the path", async () => {
    signal("reader", "file_read", "src/app.ts", "tu-1", "2026-01-01T01:00:00Z");
    signal("writer", "file_write", "src/app.ts", "tu-2", "2026-01-01T02:00:00Z");

    const hits = await run<FileWriteHit[]>("session.files", { path: "src/app.ts" });

    expect(hits.map((h) => h.sessionId)).toEqual(["writer"]);
  });

  it("counts a mirrored signal copy once", async () => {
    signal("s1", "file_write", "src/app.ts", "tu-1", "2026-01-01T01:00:00Z", "a.jsonl");
    signal("s1", "file_write", "src/app.ts", "tu-1", "2026-01-01T01:00:00Z", "b.jsonl");

    const hits = await run<FileWriteHit[]>("session.files", { path: "src/app.ts" });

    expect(hits).toHaveLength(1);
  });

  it("returns an empty list for an unknown path", async () => {
    expect(await run<FileWriteHit[]>("session.files", { path: "src/nope.ts" })).toEqual([]);
  });
});

describe("task.sessions", () => {
  it("returns both sessions joined by ran edges with agent, profile and edge source", async () => {
    origin("s1", "alpha", "lite");
    origin("s2", "beta", "full");
    ran("s1", "DEMO-1", "brief-anchor");
    ran("s2", "DEMO-1", "transcript");
    ran("s3", "DEMO-2", "transcript");

    const hits = await run<TaskSessionHit[]>("task.sessions", { task: "DEMO-1" });

    expect(hits).toEqual([
      { sessionId: "s1", agent: "alpha", profile: "lite", source: "brief-anchor" },
      { sessionId: "s2", agent: "beta", profile: "full", source: "transcript" },
    ]);
  });

  it("returns an empty list for an unknown task", async () => {
    expect(await run<TaskSessionHit[]>("task.sessions", { task: "DEMO-404" })).toEqual([]);
  });
});
