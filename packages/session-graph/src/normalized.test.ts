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
import { normalizedSessions, normalizedUsage, readIndexedText } from "./normalized-query.js";
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
