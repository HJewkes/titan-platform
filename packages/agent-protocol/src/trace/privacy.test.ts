import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  REDACTED_LOCAL_VALUE,
  TRACE_FIELD_PRIVACY,
  TraceArtifactSchema,
  TraceAttemptSchema,
  TraceCallSchema,
  TraceCostSchema,
  TraceGateSchema,
  TraceRunSchema,
  parseTraceRecord,
  redactTraceRecord,
  type TracePrivacyScope,
} from "./index.js";

const FIXTURES = new URL("../../fixtures/trace/v1/doc-run.jsonl", import.meta.url);
const docRun = readFileSync(FIXTURES, "utf8").trim().split("\n").map((line) => parseTraceRecord(JSON.parse(line)));
const find = (id: string) => docRun.find((record) => record.id === id)!;
const digestOf = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

type Def = { type: string; shape?: Record<string, z.ZodType>; innerType?: z.ZodType; element?: z.ZodType; options?: z.ZodType[] };
const defOf = (schema: z.ZodType) => (schema as unknown as { def: Def }).def;

function leafPaths(schema: z.ZodType, prefix = ""): string[] {
  const def = defOf(schema);
  if (def.type === "optional" || def.type === "nullable") return leafPaths(def.innerType!, prefix);
  if (def.type === "union") return [...new Set(def.options!.flatMap((option) => leafPaths(option, prefix)))];
  if (def.type === "array") return leafPaths(def.element!, `${prefix}[]`);
  if (def.type === "record") return [`${prefix}.*`];
  if (def.type !== "object") return [prefix];
  return Object.entries(def.shape!).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

function schemasByScope(): Record<TracePrivacyScope, z.ZodType> {
  const [commit, pr, file] = defOf(TraceArtifactSchema).options!;
  return { run: TraceRunSchema, attempt: TraceAttemptSchema, call: TraceCallSchema, gate: TraceGateSchema, cost: TraceCostSchema, "artifact.commit": commit!, "artifact.pr": pr!, "artifact.file": file! };
}

describe("trace field privacy", () => {
  it("classifies every schema leaf and names no field the schema lacks", () => {
    for (const [scope, schema] of Object.entries(schemasByScope())) {
      expect(Object.keys(TRACE_FIELD_PRIVACY[scope as TracePrivacyScope]).sort(), scope).toEqual(leafPaths(schema).sort());
    }
  });

  it("drops local text, span content hashes and correlation values", async () => {
    const run = await redactTraceRecord(find("3f1c2a9e-0000-4000-8000-000000000001"), { publicRepos: [] });
    expect(run).not.toHaveProperty("error");
    expect(run.correlations).toEqual({ "factory.task": REDACTED_LOCAL_VALUE });
    const attempt = await redactTraceRecord(find("workflow:3f1c2a9e-0000-4000-8000-000000000001:draft:0:0"), { publicRepos: [] });
    expect(attempt).not.toHaveProperty("error");
    expect(attempt).toMatchObject({ outcome: "failed", runnerRef: digestOf("runner-a") });
    const gate = await redactTraceRecord(find("3f1c2a9e-0000-4000-8000-000000000001/owner-review"), { publicRepos: [] });
    expect(gate).not.toHaveProperty("reason");
    expect(gate).toMatchObject({ verdict: "revise", decidedBy: "human:owner" });
    const call = await redactTraceRecord(find("call:claude-code:host-a:conv-1:toolu_07"), { publicRepos: [] });
    expect(call.span).toEqual({ sourceId: digestOf("src-1"), byteOffset: 18234, byteLength: 911 });
    expect(call).toMatchObject({ name: "Edit", conversation: digestOf("conversation:claude-code:host-a:conv-1") });
  });

  it("digests repo-bound fields unless the repo is public", async () => {
    const file = docRun.find((record) => record.kind === "artifact" && record.artifactKind === "file")!;
    const hidden = await redactTraceRecord(file, { publicRepos: ["acme/other"] });
    expect(hidden).toMatchObject({ repo: digestOf("acme/docs"), path: digestOf("site/guide.md"), lines: [{ lineStart: digestOf("40"), lineEnd: digestOf("58") }] });
    const shown = await redactTraceRecord(file, { publicRepos: ["acme/docs"] });
    expect(shown).toMatchObject({ repo: "acme/docs", path: "site/guide.md", lines: [{ lineStart: 40, lineEnd: 58 }] });
  });

  it("drops MCP tool names and digests agent actors", async () => {
    const call = find("call:claude-code:host-a:conv-1:toolu_07");
    const mcp = await redactTraceRecord({ ...call, name: "mcp__acme__lookup" } as unknown as typeof call, { publicRepos: [] });
    expect(mcp).not.toHaveProperty("name");
    const gate = find("3f1c2a9e-0000-4000-8000-000000000001/owner-review");
    const byAgent = await redactTraceRecord({ ...gate, decidedBy: "agent:agent-a" } as unknown as typeof gate, { publicRepos: [] });
    expect(byAgent.decidedBy).toBe(digestOf("agent:agent-a"));
  });

  it("drops keys that carry no privacy class", async () => {
    const attempt = find("workflow:3f1c2a9e-0000-4000-8000-000000000001:draft:0:1");
    const redacted = await redactTraceRecord({ ...attempt, note: "private" } as unknown as typeof attempt, { publicRepos: [] });
    expect(redacted).not.toHaveProperty("note");
  });
});
