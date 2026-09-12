import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMinerContext, type MinerContext } from "./context.js";
import { resolveConfig } from "./config.js";
import { refresh } from "./commands/refresh.js";
import { search } from "./commands/search.js";
import { sessionList, sessionShow } from "./commands/sessions.js";
import { drainIngest } from "./commands/drain.js";
import { status } from "./commands/status.js";

let dir: string | undefined;let ctx: MinerContext | undefined;
afterEach(()=>{ctx?.close();if(dir)rmSync(dir,{recursive:true,force:true});});
const render=(records: unknown[])=>records.map(r=>JSON.stringify(r)).join("\n")+"\n";
it("indexes mixed corpora with isolated identities, excerpts and clustered errors",async()=>{
  dir=mkdtempSync(path.join(os.tmpdir(),"titan-mixed-"));const claude=path.join(dir,"claude","project");const codex=path.join(dir,"codex","sessions");mkdirSync(claude,{recursive:true});mkdirSync(codex,{recursive:true});
  writeFileSync(path.join(claude,"same-id.jsonl"),render([{type:"user",sessionId:"same-id",uuid:"p1",timestamp:"2026-09-11T12:00:00Z",message:{role:"user",content:"legacyword"}}]));
  const event=(type:string,payload:unknown)=>({type,timestamp:"2026-09-11T12:01:00Z",payload});
  writeFileSync(path.join(codex,"rollout.jsonl"),render([
    event("session_meta",{id:"same-id",session_id:"root",cwd:dir,cli_version:"test"}),
    event("turn_context",{turn_id:"t1",model:"test-model",cwd:dir}),
    event("event_msg",{type:"task_started",turn_id:"t1"}),
    event("response_item",{type:"message",role:"assistant",content:[{type:"output_text",text:"codexword café"}]}),
    event("response_item",{type:"function_call",name:"shell",call_id:"c1",arguments:"{}"}),
    {type:"response_item",timestamp:"2000-01-01T00:00:00Z",payload:{type:"function_call_output",call_id:"benign",output:"all good"}},
    {type:"response_item",payload:{type:"function_call_output",call_id:"c1",output:"Error: ENOENT missing fixture file",is_error:true}},
    event("event_msg",{type:"task_complete",turn_id:"t1"}),
  ]));
  ctx=createMinerContext(resolveConfig({stateDir:path.join(dir,"state"),corpusRoot:path.dirname(claude),codexHome:path.dirname(codex),namespace:"host"},{}));
  const first=await refresh.run({},ctx);expect(first.indexed).toBe(2);expect(first.quarantined).toBe(0);
  const list=await sessionList.run({limit:20},ctx);expect(list.map(s=>s.harness).sort()).toEqual(["claude-code","codex"]);
  const codexId=list.find(s=>s.harness==="codex")!.sessionId;expect(codexId).not.toBe("same-id");
  const hits=await search.run({query:"codexword",limit:10},ctx);expect(hits.hits[0]).toMatchObject({ref:codexId,excerpt:"codexword café"});
  expect((await search.run({query:"legacyword",limit:10},ctx)).hits[0]).toMatchObject({ref:"session:same-id",excerpt:"legacyword"});
  expect(await sessionShow.run({id:codexId},ctx)).toMatchObject({harness:"codex",nativeId:"same-id"});
  expect(await status.run({},ctx)).toMatchObject({sessions:2});
  expect(await drainIngest.run({limit:1},ctx)).toMatchObject({screened:1,clustered:0});
  expect(await drainIngest.run({limit:1},ctx)).toMatchObject({clustered:1,unreadable:0});
  expect(await drainIngest.run({},ctx)).toMatchObject({candidates:0});
  expect(await refresh.run({},ctx)).toMatchObject({unchanged:2,indexed:0});
});
