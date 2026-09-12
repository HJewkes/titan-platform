import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexExecAdapter, dispatchHarnessRun, prepareCodexEnv, DEFAULT_CODEX_EXECUTABLE, SUPPORTED_CODEX_EXEC_VERSION } from "../packages/agent/dist/index.js";
import { discoverCodexSources } from "../packages/session-read/dist/index.js";
import { indexCodexSource, indexTranscript, normalizedUsage } from "../packages/session-graph/dist/index.js";
import { createMinerContext, createMinerRegistry, resolveConfig } from "../products/session-miner/dist/index.js";

// Deliberately excluded from unit tests: this command starts a real model run.
if (!process.argv.includes("--run")) throw new Error("Opt in with --run and TITAN_SMOKE_MODEL; this launches a real Codex agent.");
const model = process.env.TITAN_SMOKE_MODEL;
if (!model) throw new Error("TITAN_SMOKE_MODEL must explicitly select the smoke model");
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
let observedAuth = "unknown";
try {
  const status = execFileSync(DEFAULT_CODEX_EXECUTABLE,["login","status"], {env:prepareCodexEnv(process.env),encoding:"utf8",timeout:5000,stdio:["ignore","pipe","pipe"]});
  observedAuth = /chatgpt/i.test(status) ? "cached ChatGPT login" : /api key/i.test(status) ? "cached API key" : "unknown";
} catch { /* The launch still provides its own categorized auth/runtime outcome. */ }
const scratch = await mkdtemp(path.join(os.tmpdir(), "titan-codex-smoke-"));
const marker = `titanproof${randomUUID().replaceAll("-", "")}`;
const namespace = `smoke-${randomUUID()}`;
let ctx;
let receipt;
try {
  execFileSync("git", ["init", "--quiet", scratch]);
  await writeFile(path.join(scratch, "fixture.txt"), `${marker}\n`);
  const adapter = createCodexExecAdapter({ auth: "cached-cli" });
  const result = await dispatchHarnessRun({ harness: "codex", cwd: scratch,
    prompt: "Using shell tools, first try to read missing-fixture.txt (the failure is expected), then read fixture.txt. Reply with exactly the contents of fixture.txt. Do not modify files.",
    target: { kind: "fresh", namespace }, wallTimeMs: 90_000,
    native: { model, reasoningEffort: "low", sandbox: "read-only", approvalPolicy: "never" },
  }, adapter);
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.failure));
  assert.equal(result.output.kind, "text");
  assert.equal(result.output.text.trim(), marker);
  const sources = await discoverCodexSources({ codexHome, namespace });
  const source = sources.find(s => s.conversation.nativeId === result.conversation.nativeId);
  assert.ok(source, "persisted rollout for the returned native thread must exist");
  ctx = createMinerContext(resolveConfig({ stateDir: path.join(scratch, "miner"), corpusRoot: scratch }, {}));
  const graph = ctx.graph();
  const claude = path.join(scratch, "claude.jsonl");
  await writeFile(claude, `${JSON.stringify({type:"user",sessionId:result.conversation.nativeId,uuid:"legacy-prompt",timestamp:new Date().toISOString(),message:{role:"user",content:"legacy fixture"}})}\n`);
  await indexTranscript(graph, { absolutePath: claude, displayPath: claude, projectDir: scratch, subagentId: null });
  const indexed = await indexCodexSource(graph, source);
  assert.equal(indexed.status, "indexed", indexed.reason);
  const registry = createMinerRegistry();
  const list = await registry.get("session.list").run({limit:20},ctx);
  assert.equal(list.length,2);
  assert.deepEqual(list.map(s=>s.harness).sort(),["claude-code","codex"]);
  const search = await registry.get("search").run({query:marker,limit:10},ctx);
  assert.ok(search.hits.some(h=>h.ref===indexed.conversationRef && h.excerpt?.includes(marker)));
  const tools = graph.db.prepare("SELECT kind,count(*) AS n FROM normalized_event WHERE kind IN ('tool_call','tool_result') GROUP BY kind").all();
  assert.ok(tools.some(t=>t.kind==="tool_call" && t.n>0));
  assert.ok(tools.some(t=>t.kind==="tool_result" && t.n>0));
  const detail = await registry.get("session.show").run({id:indexed.conversationRef},ctx);
  assert.ok(detail.turns.some(turn=>turn.toolCalls>0),"tool calls must retain their native turn association");
  const usage = normalizedUsage(graph,indexed.conversationRef);
  assert.ok(usage.length>0,"persisted usage must be observed");
  const drain = await registry.get("drain.ingest").run({},ctx);
  assert.ok(drain.clustered>0,"expected missing-file tool output must read back and cluster");
  assert.equal((await indexCodexSource(graph,source)).status,"unchanged");
  assert.deepEqual(normalizedUsage(graph,indexed.conversationRef),usage);
  receipt = {ok:true,binaryVersion:SUPPORTED_CODEX_EXEC_VERSION,model,authMode:"cached-cli (provider key env stripped)",observedAuth,
    conversation:result.conversation,rollout:source.path,observations:indexed.observations,tools,usage,
    errorReadback:drain.clustered,wallTimeMs:90_000,limitations:["local deadline is not a billing cap","no live reattachment or steering"],scratchCleaned:true};
} finally {ctx?.close();await rm(scratch,{recursive:true,force:true});}

console.log(JSON.stringify(receipt,null,2));
