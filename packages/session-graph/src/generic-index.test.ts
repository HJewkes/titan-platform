import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationRef } from "@titan-design/agent-protocol";
import type { CapabilityAssessment, HarnessSourcePort, SessionSourceDescriptor } from "@titan-design/agent-protocol/harness";
import { prefixHash, readJsonLines, readLocatorBytes } from "@titan-design/locator";
import { claudeSourceFromPath, discoverCodexSources, readClaudeObservations, readClaudeText, readCodexObservations, readCodexText, SessionIdentityError, TranscriptParseError } from "@titan-design/session-read";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import * as indexing from "./normalized-index.js";
import { readIndexedText } from "./normalized-query.js";

const dirs: string[] = [];
const graphs: SessionGraph[] = [];
const at = "2026-10-01T00:00:00Z";
const supported = { status: "supported", evidence: "owned synthetic source fixture" } as const;
const unverified = { status: "unverified", reason: "fixture has no finality evidence" } as const;
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "generic-index-")); dirs.push(dir); return dir; };
const graph = (filename = ":memory:") => { const result = openSessionGraph(filename, { normalized: true }); graphs.push(result); return result; };
afterEach(() => { for (const g of graphs.splice(0)) g.db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function index(...args: Parameters<typeof indexing.indexSource>) {
  expect(indexing.indexSource).toBeTypeOf("function");
  return indexing.indexSource(...args);
}
function nativePort(readObservations: HarnessSourcePort["readObservations"], readText: HarnessSourcePort["readText"]): HarnessSourcePort {
  return { capabilities: { discover: supported, locate: supported, observations: supported, text: supported, semanticFinality: unverified },
    async discover() { return []; }, async locate() { return { status: "unavailable", reason: "fixture has no discovery" }; },
    readObservations, readText };
}
function thirdSource(dir: string, namespace = "fixture-host"): SessionSourceDescriptor {
  return { sourceId: "fixture-third:" + namespace, harness: "fixture-third", namespace, format: "fixture-lines-v1", formatVersion: "1",
    path: path.join(dir, "third.jsonl"), conversation: { harness: "fixture-third", namespace, nativeId: "same-id" },
    provenance: { kind: "native", name: "fixture-third" } };
}
const record = (text: string, role: "user" | "assistant" = "assistant", id = "same-id") => JSON.stringify({ id, role, text }) + "\n";
function thirdRecord(value: unknown): { id: string; role: "user" | "assistant"; text: string } {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string" ||
    !("role" in value) || (value.role !== "user" && value.role !== "assistant") || !("text" in value) || typeof value.text !== "string")
    throw new TypeError("malformed synthetic third record");
  return { id: value.id, role: value.role, text: value.text };
}
function thirdPort() {
  const observations: string[] = []; const texts: string[] = [];
  let omitDone = false;
  const port: HarnessSourcePort = {
    capabilities: { discover: supported, locate: supported, observations: supported, text: supported, semanticFinality: unverified },
    async discover() { return []; }, async locate() { return { status: "unavailable", reason: "not discovered" }; },
    async *readObservations(source, options, done) {
      expect(this).toBe(port); expect(options).toEqual({}); observations.push(source.sourceId);
      let offset = 0;
      for await (const line of readJsonLines(source.path, 0, { strictUtf8: true })) {
        let value: { id: string; role: "user" | "assistant"; text: string };
        try { value = thirdRecord(JSON.parse(line.text)); }
        catch (error) { throw new TranscriptParseError(source.path, line.byteOffset, error); }
        if (value.id !== source.conversation.nativeId) throw new SessionIdentityError("fixture foreign identity", "foreign_native_session");
        const evidence = { line: { sourceId: source.sourceId, byteOffset: line.byteOffset, byteLength: line.byteLength,
          contentHash: createHash("sha256").update(line.text).digest("hex"), lineNumber: null, nativeOrdinal: null },
          subrecord: { index: 0, path: ["text"] } };
        yield { kind: "message", id: { sourceId: source.sourceId, byteOffset: line.byteOffset, subrecordIndex: 0 },
          conversation: source.conversation, historyOrigin: null, timestamp: at, role: value.role, item: null, representation: "canonical",
          evidence, content: [{ kind: "text", text: value.text, locator: { source, evidence, selector: { kind: "subrecord-text", path: ["text"] } } }] };
        offset = line.byteOffset + line.byteLength + 1;
      }
      if (!omitDone) done?.({ startByteOffset: 0, resumeBoundary: { byteOffset: offset, prefixHash: await prefixHash(source.path, offset) }, restartedFromZero: false });
    },
    async readText(locator, options) {
      expect(this).toBe(port); expect(options?.sources).toEqual([locator.source]); texts.push(locator.source.sourceId);
      const bytes = await readLocatorBytes(locator.source.path, [0, locator.evidence.line.byteOffset, locator.evidence.line.byteLength]);
      if (createHash("sha256").update(bytes).digest("hex") !== locator.evidence.line.contentHash) return null;
      return thirdRecord(JSON.parse(new TextDecoder().decode(bytes))).text;
    },
  };
  return { port, observations, texts, omitCompletion() { omitDone = true; } };
}
function events(g: SessionGraph) { return g.db.prepare("SELECT * FROM normalized_event ORDER BY transcript_id,byte_offset,subrecord_index").all(); }
function stages(g: SessionGraph) { return g.db.prepare("SELECT name FROM sqlite_temp_master WHERE name GLOB 'stage_*'").all(); }

describe("explicit normalized source indexing", () => {
  it("indexes the actual Codex reader with identical rows, metadata and watermark to the compatibility entry", async () => {
    const dir = temp(); mkdirSync(path.join(dir, "sessions")); const file = path.join(dir, "sessions", "rollout.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "same-id" }, timestamp: at }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "café codexword" }] }, timestamp: at }) + "\n");
    const source = (await discoverCodexSources({ codexHome: dir, namespace: "fixture-host" }))[0]!;
    const old = graph(); const current = graph(); const port = nativePort(readCodexObservations, readCodexText);
    expect(await index(current, source, port)).toEqual(await indexing.indexCodexSource(old, source));
    expect(events(current)).toEqual(events(old));
    const a = current.transcripts.ensure(source.sourceId); const b = old.transcripts.ensure(source.sourceId);
    expect([a.lastOffset, a.prefixHash, a.contentHash, a.fileSize, a.status]).toEqual([b.lastOffset, b.prefixHash, b.contentHash, b.fileSize, b.status]);
    expect(await readIndexedText(current, current.spans.search("codexword")[0]!, { sourcePort: port })).toBe("café codexword");
    expect(await index(current, source, port)).toMatchObject({ status: "unchanged" });
  });
  it("uses the actual Claude reader without changing the legacy Codex entry's format refusal", async () => {
    const dir = temp(); const file = path.join(dir, "same-id.jsonl");
    writeFileSync(file, JSON.stringify({ type: "user", sessionId: "same-id", uuid: "p1", timestamp: at, message: { role: "user", content: "héllo claudeword" } }) + "\n");
    const source = claudeSourceFromPath(file, "fixture-host"); const g = graph(); const port = nativePort(readClaudeObservations, readClaudeText);
    expect(await index(g, source, port)).toMatchObject({ status: "indexed" });
    const hit = g.spans.search("claudeword")[0]!;
    expect(hit.ownerRef).toBe(conversationRef(source.conversation));
    expect(await readIndexedText(g, hit, { sourcePort: port })).toBe("héllo claudeword");
    const refusal = indexing.indexCodexSource(graph(), source);
    await expect(refusal).rejects.toBeInstanceOf(TypeError);
    await expect(refusal).rejects.toThrow("Codex decoder requires a consistent codex-rollout source descriptor");
  });
  it("indexes and reads a third format with scoped identity and both method receivers intact", async () => {
    const source = thirdSource(temp()); writeFileSync(source.path, record("café thirdword 🌍")); const f = thirdPort(); const g = graph();
    expect(await index(g, source, f.port)).toMatchObject({ status: "indexed", observations: 1, conversationRef: conversationRef(source.conversation) });
    const hit = g.spans.search("thirdword")[0]!;
    expect(await readIndexedText(g, hit, { sourcePort: f.port })).toBe("café thirdword 🌍");
    expect(f.observations).toEqual([source.sourceId]); expect(f.texts).toEqual([source.sourceId]);
    expect(stages(g)).toEqual([]);
    expect(await index(g, source, f.port)).toMatchObject({ status: "unchanged" }); expect(events(g)).toHaveLength(1);
    const other = { ...source, sourceId: source.sourceId + ":other", namespace: "other-host", conversation: { ...source.conversation, namespace: "other-host" } };
    expect(await index(g, other, f.port)).toMatchObject({ status: "indexed" });
    expect(new Set(g.spans.search("thirdword").map(span => span.ownerRef)).size).toBe(2);
  });
  it("converges after physical append and reopening, and atomically replaces same-size rewritten spans", async () => {
    const dir = temp(); const source = thirdSource(dir); writeFileSync(source.path, record("obsoleteword")); const f = thirdPort(); const file = path.join(dir, "index.sqlite");
    let g = graph(file); await index(g, source, f.port); g.db.close(); graphs.splice(graphs.indexOf(g), 1);
    appendFileSync(source.path, record("secondword")); g = graph(file); const full = graph();
    await index(g, source, f.port); await index(full, source, f.port); expect(events(g)).toEqual(events(full));
    writeFileSync(source.path, record("replacedword") + record("secondword")); expect(Buffer.byteLength(record("obsoleteword"))).toBe(Buffer.byteLength(record("replacedword")));
    expect(await index(g, source, f.port)).toMatchObject({ status: "indexed" }); expect(g.spans.search("obsoleteword")).toHaveLength(0); expect(g.spans.search("replacedword")).toHaveLength(1);
    expect(stages(g)).toEqual([]);
  });
  it.each(["malformed", "foreign"] as const)("retains prior rows and watermark on %s input after a staged observation", async mode => {
    const source = thirdSource(temp()); writeFileSync(source.path, record("stableword")); const f = thirdPort(); const g = graph(); await index(g, source, f.port);
    const before = events(g); const watermark = g.transcripts.ensure(source.sourceId);
    writeFileSync(source.path, record("replacementword") + (mode === "malformed" ? "{bad}\n" : record("foreignword", "assistant", "other-id")));
    expect(await index(g, source, f.port)).toMatchObject({ status: "quarantined" }); expect(events(g)).toEqual(before);
    const current = g.transcripts.ensure(source.sourceId); expect([current.lastOffset, current.prefixHash, current.contentHash]).toEqual([watermark.lastOffset, watermark.prefixHash, watermark.contentHash]);
    expect(g.spans.search("stableword")).toHaveLength(1); expect(g.spans.search("replacementword")).toHaveLength(0); expect(stages(g)).toEqual([]);
  });
  it("requires completion and rolls back a real database abort without removing old evidence", async () => {
    const source = thirdSource(temp()); writeFileSync(source.path, record("stableword")); const f = thirdPort(); const g = graph(); await index(g, source, f.port);
    const before = events(g); const watermark = g.transcripts.ensure(source.sourceId); writeFileSync(source.path, record("replacementword"));
    const incomplete = thirdPort(); incomplete.omitCompletion();
    await expect(index(g, source, incomplete.port)).rejects.toThrow("resume boundary");
    expect(events(g)).toEqual(before); expect(g.transcripts.ensure(source.sourceId)).toEqual(watermark); expect(stages(g)).toEqual([]);
    g.db.exec("CREATE TRIGGER fail_generic_swap BEFORE INSERT ON normalized_event BEGIN SELECT RAISE(ABORT, 'generic swap failed'); END");
    await expect(index(g, source, f.port)).rejects.toThrow("generic swap failed"); expect(events(g)).toEqual(before); expect(g.transcripts.ensure(source.sourceId)).toEqual(watermark); expect(stages(g)).toEqual([]);
  });
  it.each(["unsupported", "unverified"] as const)("returns typed %s before touching the graph, file or adapter", async status => {
    const source = thirdSource(temp()); const g = graph(); const f = thirdPort();
    const assessment: CapabilityAssessment = { status, reason: "fixture unavailable" };
    f.port.capabilities.observations = assessment;
    const keys = g.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(); const ensure = vi.spyOn(g.transcripts, "ensure"); const read = vi.spyOn(f.port, "readObservations");
    expect(await index(g, source, f.port)).toEqual({ status: "unavailable", conversationRef: conversationRef(source.conversation), observations: 0, assessment });
    expect(read).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); expect(g.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all()).toEqual(keys);
    const inaccessible = new Proxy(g, { get() { throw new Error("unavailable indexing touched the graph"); } });
    expect(await index(inaccessible, source, f.port)).toEqual({ status: "unavailable", conversationRef: conversationRef(source.conversation), observations: 0, assessment });
  });
  it.each(["unsupported", "unverified"] as const)("never falls back from an explicitly %s text capability", async status => {
    const source = thirdSource(temp()); writeFileSync(source.path, record("thirdword")); const f = thirdPort(); const g = graph(); await index(g, source, f.port);
    f.port.capabilities.text = { status, reason: "text unavailable" }; const read = vi.spyOn(f.port, "readText");
    expect(await readIndexedText(g, g.spans.search("thirdword")[0]!, { sourcePort: f.port })).toBeNull(); expect(read).not.toHaveBeenCalled();
  });
  it("preserves prefix and missing-file checks before injected readback, and strips prompt framing", async () => {
    const source = thirdSource(temp()); writeFileSync(source.path, record("<system-reminder>hidden</system-reminder>\nhumanword", "user")); const f = thirdPort(); const g = graph(); await index(g, source, f.port);
    const hit = g.spans.search("humanword")[0]!; expect(await readIndexedText(g, hit, { sourcePort: f.port })).toBe("humanword");
    const calls = f.texts.length; const originalBytes = readFileSync(source.path).byteLength;
    const replacement = record("changedword", "user").trimEnd();
    const rewritten = replacement + " ".repeat(originalBytes - Buffer.byteLength(replacement) - 1) + "\n";
    expect(Buffer.byteLength(rewritten)).toBe(originalBytes); writeFileSync(source.path, rewritten);
    expect(await readIndexedText(g, hit, { sourcePort: f.port })).toBeNull(); expect(f.texts).toHaveLength(calls);
    rmSync(source.path); expect(await readIndexedText(g, hit, { sourcePort: f.port })).toBeNull(); expect(f.texts).toHaveLength(calls);
  });
  it("does not run the native legacy text fallback for any explicitly supplied port", async () => {
    const dir = temp(); const file = path.join(dir, "legacy.jsonl");
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "legacyword" } }); writeFileSync(file, line + "\n");
    const g = graph(); const row = g.transcripts.ensure(file); const id = g.spans.index({ ownerRef: "session:legacy", sourceId: row.sourceId, field: "prompt", byteOffset: 0, byteLength: Buffer.byteLength(line) }, "legacyword");
    const span = { sourceId: row.sourceId, spanId: id, field: "prompt", byteOffset: 0, byteLength: Buffer.byteLength(line) }; const f = thirdPort();
    expect(await readIndexedText(g, span)).toBe("legacyword");
    expect(await readIndexedText(g, span, { homeDir: dir })).toBe("legacyword");
    expect(await readIndexedText(g, span, { sourcePort: f.port })).toBeNull(); expect(f.texts).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(line + "\n");
  });
});
