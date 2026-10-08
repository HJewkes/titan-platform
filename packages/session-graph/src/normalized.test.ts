import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { conversationRef } from "@titan-design/agent-protocol";
import { discoverCodexSources } from "@titan-design/session-read";
import { openDatabase, runMigrations, SpanFtsTables } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionGraph } from "./graph.js";
import { MIGRATIONS } from "./schema.js";
import { indexCodexSource } from "./normalized-index.js";
import {
  countNormalizedEvents, countNormalizedSessions, hasNormalizedTables, normalizedConversationDetail, normalizedErrorFacts, normalizedSessions,
  normalizedSourcePath, normalizedUsage, readIndexedText,
} from "./normalized-query.js";
import { resolveConversationAlias } from "./normalized-schema.js";
import { mkdirSync } from "node:fs";

const directories: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "titan-normalized-")); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir,{ recursive:true,force:true }); });
const line = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: "2026-09-11T12:00:00Z", payload }) + "\n";
const header = line("session_meta", { id:"same-id", session_id:"root-tree", cwd:"/scratch", cli_version:"test" }) + line("turn_context", { turn_id:"turn-1",model:"test-model",cwd:"/scratch" });
const message = (text: string) => line("response_item", { type:"message",role:"assistant",content:[{type:"output_text",text}] });
function fixture() { const dir=temp();mkdirSync(path.join(dir,"sessions")); const file=path.join(dir,"sessions","rollout.jsonl");writeFileSync(file,header+message("café obsoleteword"));return {dir,file}; }

describe("additive migration", () => {
  it("preserves old rows and field-specific workspace provenance with pruned sources, with a usable backup", async () => {
    const dir=temp(); const file=path.join(dir,"graph.sqlite"); const backup=path.join(dir,"before.sqlite");
    const db=openDatabase(file);runMigrations(db,MIGRATIONS.filter(m=>m.version<3));
    db.prepare("INSERT INTO session(session_id,transcript_id) VALUES (?,?)").run("same-id",1);
    db.prepare("INSERT INTO fact(transcript_id,byte_offset,byte_length,event_type,ts,seq,session_id) VALUES (1,10,40,'user','t',0,'same-id')").run();
    const spans=new SpanFtsTables(db);spans.index({ownerRef:"session:same-id",field:"body",sourceId:1,byteOffset:1,byteLength:2},"workspace record");
    spans.index({ownerRef:"session:same-id",field:"prompt",sourceId:1,byteOffset:10,byteLength:40},"transcript record");
    spans.index({ownerRef:"session:workspace-only",field:"body",sourceId:2,byteOffset:0,byteLength:2},"workspace only");
    await db.backup(backup);const before=db.prepare("SELECT * FROM fact").all();db.close();
    const graph=openSessionGraph(file);
    try {
      expect(graph.db.prepare("SELECT * FROM fact").all()).toEqual(before);
      expect(graph.spans.search("record").map(s=>s.field).sort()).toEqual(["body","prompt"]);
      expect(resolveConversationAlias(graph.db,"session:same-id")).toBe("conversation:claude-code:legacy:same-id");
      expect(resolveConversationAlias(graph.db,"session:workspace-only")).toBeNull();
      const old=openDatabase(backup);expect(old.prepare("SELECT * FROM fact").all()).toEqual(before);expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversation'").get()).toBeUndefined();old.close();
    } finally {graph.db.close();}
  });
});

describe("normalized ingestion", () => {
  it("scopes native IDs, reads Unicode excerpts, and does not duplicate unchanged observations", async () => {
    const {dir}=fixture();const source=(await discoverCodexSources({codexHome:dir,namespace:"host"}))[0]!;const graph=openSessionGraph(":memory:");
    try {
      expect(await indexCodexSource(graph,source)).toMatchObject({status:"indexed"});
      const ref=conversationRef(source.conversation);expect(ref).toBe("conversation:codex:host:same-id");
      const hit=graph.spans.search("obsoleteword")[0]!;expect(hit.ownerRef).toBe(ref);expect(await readIndexedText(graph,hit)).toBe("café obsoleteword");
      const before=graph.db.prepare("SELECT count(*) AS n FROM normalized_event").get();
      expect(await indexCodexSource(graph,source)).toMatchObject({status:"unchanged"});expect(graph.db.prepare("SELECT count(*) AS n FROM normalized_event").get()).toEqual(before);
      expect(normalizedSessions(graph)).toEqual([expect.objectContaining({harness:"codex",nativeId:"same-id",cwd:"/scratch",commitCount:null,pushCount:null})]);
    } finally {graph.db.close();}
  });
  it("atomically replaces rewritten text and retains prior rows when malformed or missing", async () => {
    const {dir,file}=fixture();const source=(await discoverCodexSources({codexHome:dir,namespace:"host"}))[0]!;const graph=openSessionGraph(":memory:");
    try {
      await indexCodexSource(graph,source);writeFileSync(file,header+message("replacementword"));
      expect(await indexCodexSource(graph,source)).toMatchObject({status:"indexed"});expect(graph.spans.search("obsoleteword")).toHaveLength(0);expect(graph.spans.search("replacementword")).toHaveLength(1);
      appendFileSync(file,"{malformed}\n");expect(await indexCodexSource(graph,source)).toMatchObject({status:"quarantined"});expect(graph.spans.search("replacementword")).toHaveLength(1);
      rmSync(file);expect(await indexCodexSource(graph,source)).toMatchObject({status:"missing"});expect(await readIndexedText(graph,graph.spans.search("replacementword")[0]!)).toBeNull();
    } finally {graph.db.close();}
  });
  it("quarantines a rollout whose session_meta names another conversation", async () => {
    const {dir,file}=fixture();const source=(await discoverCodexSources({codexHome:dir,namespace:"host"}))[0]!;const graph=openSessionGraph(":memory:");
    try {
      appendFileSync(file,line("session_meta",{id:"other-id"}));
      expect(await indexCodexSource(graph,source)).toMatchObject({status:"quarantined",reason:expect.stringContaining("does not match")});
    } finally {graph.db.close();}
  });
  it("propagates a store error raised during the swap and leaves the watermark unchanged", async () => {
    const {dir,file}=fixture();const source=(await discoverCodexSources({codexHome:dir,namespace:"host"}))[0]!;const graph=openSessionGraph(":memory:");
    try {
      await indexCodexSource(graph,source);const before=graph.transcripts.ensure(source.sourceId);
      writeFileSync(file,header+message("replacementword"));
      graph.db.exec("CREATE TRIGGER fail_swap BEFORE INSERT ON normalized_event BEGIN SELECT RAISE(ABORT, 'swap failed'); END");
      await expect(indexCodexSource(graph,source)).rejects.toThrow("swap failed");
      expect(graph.transcripts.ensure(source.sourceId)).toEqual(before);expect(graph.spans.search("obsoleteword")).toHaveLength(1);
    } finally {graph.db.close();}
  });
  it("converges after append/restart and preserves same-line usage subrecords", async () => {
    const {dir,file}=fixture();const source=(await discoverCodexSources({codexHome:dir,namespace:"host"}))[0]!;
    const graph=openSessionGraph(path.join(dir,"incremental.sqlite"));
    await indexCodexSource(graph,source);graph.db.close();
    const tokens={input_tokens:10,output_tokens:4,total_tokens:14};
    appendFileSync(file,line("token_usage_record",{response_id:"r1",usage:tokens,thread_token_usage:tokens,turn_token_usage:tokens}));
    const incremental=openSessionGraph(path.join(dir,"incremental.sqlite"));const full=openSessionGraph(":memory:");
    try {
      await indexCodexSource(incremental,source);await indexCodexSource(full,source);
      expect(incremental.db.prepare("SELECT * FROM normalized_event ORDER BY byte_offset,subrecord_index").all()).toEqual(full.db.prepare("SELECT * FROM normalized_event ORDER BY byte_offset,subrecord_index").all());
      const usage=incremental.db.prepare("SELECT byte_offset,subrecord_index FROM normalized_event WHERE kind = 'usage'").all() as {byte_offset:number;subrecord_index:number}[];
      expect(usage.length).toBeGreaterThan(1);expect(new Set(usage.map(u=>u.byte_offset)).size).toBe(1);
      expect(new Set(usage.map(u=>u.subrecord_index)).size).toBe(usage.length);
    } finally {incremental.db.close();full.db.close();}
  });
  it("deduplicates response usage across duplicate sources and ignores cumulative projections", async () => {
    const {dir,file}=fixture();const tokens={input_tokens:10,output_tokens:4,cached_input_tokens:3,reasoning_output_tokens:2,total_tokens:14};
    appendFileSync(file,line("token_usage_record",{response_id:"r1",usage:tokens,thread_token_usage:tokens}));
    const source=(await discoverCodexSources({codexHome:dir,namespace:"host"}))[0]!;const graph=openSessionGraph(":memory:");
    try {
      await indexCodexSource(graph,source);await indexCodexSource(graph,{...source,sourceId:source.sourceId+":copy"});
      expect(normalizedUsage(graph,conversationRef(source.conversation))).toEqual([expect.objectContaining({inputTokens:10,outputTokens:4,requestCount:1,basis:"delta"})]);
    } finally {graph.db.close();}
  });
});

it("does not add snapshot-only totals from duplicate physical sources", async () => {
  const { dir, file } = fixture();
  appendFileSync(file, line("event_msg", { type: "token_count", info: { total_token_usage: {
    input_tokens: 10, output_tokens: 4, total_tokens: 14,
  } } }));
  const source = (await discoverCodexSources({ codexHome: dir, namespace: "host" }))[0]!;
  const graph = openSessionGraph(":memory:");
  try {
    await indexCodexSource(graph, source);
    await indexCodexSource(graph, { ...source, sourceId: source.sourceId + ":copy" });
    expect(normalizedUsage(graph, conversationRef(source.conversation))).toEqual([
      expect.objectContaining({ inputTokens: 10, outputTokens: 4, basis: "snapshot" }),
    ]);
  } finally { graph.db.close(); }
});

describe("normalized readers", () => {
  const at = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ type, timestamp, payload }) + "\n";
  const call = (id: string) => at("2026-09-11T12:01:00Z", "response_item", { type: "function_call", name: "shell", call_id: id, arguments: "{}" });
  const output = (id: string, isError: boolean) => at("2026-09-11T12:02:00Z", "response_item", { type: "function_call_output", call_id: id, output: "ENOENT", is_error: isError });
  async function indexedChild() {
    const dir = temp(); mkdirSync(path.join(dir, "sessions")); const file = path.join(dir, "sessions", "rollout.jsonl");
    writeFileSync(file, [
      at("2026-09-11T12:00:00Z", "session_meta", { id: "child-id", parent_thread_id: "parent-id", cwd: "/scratch", cli_version: "test" }),
      at("2026-09-11T12:00:00Z", "event_msg", { type: "task_started", turn_id: "turn-1" }),
      call("c1"), call("c2"), call("c1"), output("c1", true), output("c2", false),
      at("2026-09-11T12:03:00Z", "event_msg", { type: "task_complete", turn_id: "turn-1" }),
      at("2026-09-11T12:04:00Z", "event_msg", { type: "task_started", turn_id: "turn-2" }),
      at("2026-09-11T12:05:00Z", "event_msg", { type: "task_complete", turn_id: "turn-2" }),
    ].join(""));
    const source = (await discoverCodexSources({ codexHome: dir, namespace: "host" }))[0]!;
    const graph = openSessionGraph(":memory:", { normalized: true });
    await indexCodexSource(graph, source);
    return { graph, file: source.path, ref: conversationRef(source.conversation), transcriptId: graph.transcripts.ensure(source.sourceId).sourceId };
  }

  it("counts each turn's distinct tool calls in one grouped query and report lineage both ways", async () => {
    const { graph, ref } = await indexedChild();
    try {
      const detail = normalizedConversationDetail(graph, ref);
      expect(detail.turns).toEqual([
        { turnRef: expect.stringContaining("turn-1"), startedAt: "2026-09-11T12:00:00Z", endedAt: "2026-09-11T12:03:00Z", toolCalls: 2 },
        { turnRef: expect.stringContaining("turn-2"), startedAt: "2026-09-11T12:04:00Z", endedAt: "2026-09-11T12:05:00Z", toolCalls: 0 },
      ]);
      expect(detail.edges).toEqual([{ relation: "parent", targetRef: expect.stringContaining("parent-id") }]);
      expect(normalizedConversationDetail(graph, detail.edges[0]!.targetRef).inbound).toEqual([{ relation: "parent", sourceRef: ref }]);
    } finally { graph.db.close(); }
  });

  it("reads error tool results only, with their conversation and transcript", async () => {
    const { graph, ref, transcriptId } = await indexedChild();
    try {
      expect(normalizedErrorFacts(graph)).toEqual([expect.objectContaining({ transcriptId, conversationRef: ref, ts: "2026-09-11T12:02:00Z" })]);
    } finally { graph.db.close(); }
  });

  it("counts sessions and events and resolve a source's file", async () => {
    const { graph, file, transcriptId } = await indexedChild();
    try {
      expect(hasNormalizedTables(graph)).toBe(true);
      expect(countNormalizedSessions(graph)).toBe(1);
      expect(countNormalizedEvents(graph)).toBe((graph.db.prepare("SELECT count(*) AS n FROM normalized_event").get() as { n: number }).n);
      expect(normalizedSourcePath(graph, transcriptId)).toBe(file);
      expect(normalizedSourcePath(graph, transcriptId + 1)).toBeNull();
    } finally { graph.db.close(); }
  });

  it.each([
    ["holds no normalized tables", () => openSessionGraph(":memory:")],
    ["holds normalized_event without normalized_source", () => {
      const graph = openSessionGraph(":memory:", { normalized: true }); graph.db.exec("DROP TABLE normalized_source"); return graph;
    }],
  ])("reads nothing from a graph that %s", (_, open) => {
    const graph = open();
    try {
      expect(hasNormalizedTables(graph)).toBe(false);
      expect([countNormalizedSessions(graph), countNormalizedEvents(graph)]).toEqual([0, 0]);
      expect(normalizedSourcePath(graph, 1)).toBeNull();
      expect(normalizedConversationDetail(graph, "conversation:codex:host:x")).toEqual({ turns: [], edges: [], inbound: [] });
      expect(normalizedErrorFacts(graph)).toEqual([]);
      expect(normalizedSessions(graph)).toEqual([]);
      expect(normalizedUsage(graph, "conversation:codex:host:x")).toEqual([]);
    } finally { graph.db.close(); }
  });
});
