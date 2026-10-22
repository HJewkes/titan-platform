// Owned Git fixtures for explicit ignored policy; no product cache/database dependency.
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {seedRepoWithOrigin} from "./git-fixture.js";
import {fixtureEnv} from "./test-env.js";
import {parkWorktree,type ParkIgnoredFilesObservation,type ParkIgnoredFilesPolicy} from "./park.js";
const roots:string[]=[];
const branch="agent-chat/policy-worker";
const git=(cwd:string,args:string[])=>execFileSync("/usr/bin/git",args,{cwd,encoding:"utf8",stdio:"pipe",env:fixtureEnv()}).trim();
function fixture(entries=[".candidate-cache"],tracking=false){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"park-policy-")));roots.push(root);
 const repo=path.join(root,"repo"),origin=path.join(root,"origin");fs.mkdirSync(repo);fs.mkdirSync(origin);seedRepoWithOrigin(repo,origin);
 fs.writeFileSync(path.join(repo,".gitignore"),".candidate-cache\nprivate-note\nworkspace/\n");
 git(repo,["add","."]);git(repo,["commit","-qm","owned ignore"]);
 const tree=path.join(repo,".worktrees","worker");git(repo,["worktree","add","-qb",branch,tree]);
 fs.writeFileSync(path.join(tree,"tracked.txt"),"owned tracked\n");git(tree,["add","."]);git(tree,["commit","-qm","owned work"]);
 const head=git(tree,["rev-parse","HEAD"]);
 if(tracking)git(tree,["push","-q","origin","HEAD:refs/heads/"+branch]);else git(repo,["remote","remove","origin"]);
 for(const e of entries){const f=path.join(tree,e);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,"owned candidate\n");}
 return {root,repo,tree,head,target:{gitRoot:repo,worktree:tree,branch}};
}
function retained(f:ReturnType<typeof fixture>,entries=[".candidate-cache"]){
 expect(fs.readFileSync(path.join(f.tree,"tracked.txt"),"utf8")).toBe("owned tracked\n");
 expect(git(f.repo,["rev-parse",branch])).toBe(f.head);
 for(const e of entries)expect(fs.existsSync(path.join(f.tree,e))).toBe(true);
}
const optionsFor=(value:unknown)=>Object.defineProperty({},"ignoredFiles",{value});
afterEach(()=>{vi.unstubAllEnvs();for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true});});
it("explicit subset policy permits an observed cache and preserves old metadata",async()=>{
 const f=fixture();expect(await parkWorktree(f.target,()=>undefined,{ignoredFiles:{protectedEntries:()=>[]}})).toEqual({ok:true,head:f.head});
 expect(fs.existsSync(f.tree)).toBe(false);expect(git(f.repo,["rev-parse",branch])).toBe(f.head);
});
it("expanded observations are fresh frozen arrays of actual deduped candidates",async()=>{
 const f=fixture(["workspace/build/a.cache","workspace/build/b.cache"]);const seen:ParkIgnoredFilesObservation[]=[];
 const policy:ParkIgnoredFilesPolicy={expandDirectories:true,protectedEntries:o=>{
  seen.push(o);expect(o.worktree).toBe(f.tree);expect(o.entries).toEqual(["workspace/build/a.cache","workspace/build/b.cache"]);
  expect(Object.isFrozen(o)).toBe(true);expect(Object.isFrozen(o.entries)).toBe(true);
  expect(Reflect.set(o,"worktree","/tmp/foreign")).toBe(false);expect(Reflect.set(o.entries,"0","invented")).toBe(false);return [];
 }};
 expect(await parkWorktree(f.target,()=>undefined,{ignoredFiles:policy})).toEqual({ok:true,head:f.head});
 expect(seen.length).toBeGreaterThanOrEqual(3);expect(new Set(seen).size).toBe(seen.length);
 expect(new Set(seen.map(o=>o.entries)).size).toBe(seen.length);expect(Object.isFrozen(policy)).toBe(false);
});
it.each([
 ["null",null],["primitive",true],["missing classifier",{}],["nonfunction",{protectedEntries:1}],
 ["invalid expansion",{protectedEntries:()=>[],expandDirectories:1}],
 ["invalid formatter",{protectedEntries:()=>[],formatRefusal:1}],
])("malformed descriptor %s refuses",async(_label,policy)=>{
 const f=fixture();expect((await parkWorktree(f.target,()=>undefined,optionsFor(policy))).ok).toBe(false);retained(f);
});
it.each([
 ["foreign",()=>["foreign"]],["duplicate",()=>[".candidate-cache",".candidate-cache"]],["hole",()=>new Array(1)],
 ["hole masked by iterator",()=>Object.defineProperty(new Array(1),Symbol.iterator,{value:()=>({next:()=>({done:true,value:undefined})})})],
 ["array thenable",()=>Object.assign([],{then:()=>undefined})],
 ["array then getter",()=>Object.defineProperty([],"then",{get(){throw new Error("owned then getter");}})],
 ["boolean",()=>true],["string",()=>".candidate-cache"],["object",()=>({protected:[]})],
 ["promise",()=>Promise.resolve([])],["thenable",()=>({then:()=>[]})],
 ["throws",()=>{throw new Error("owned classifier");}],
 ["array getter",()=>Object.defineProperty([],"0",{get(){throw new Error("owned getter");}})],
 ["rejected promise",()=>{const p=Promise.reject(new Error("owned rejection"));void p.catch(()=>undefined);return p;}],
])("malformed classifier %s cannot delete resources",async(_label,classify)=>{
 const f=fixture();const result=await parkWorktree(f.target,()=>undefined,optionsFor({protectedEntries:classify}));
 if(String(_label).startsWith("array then"))fs.writeFileSync(path.join(process.env.TP640_POLICY_ROOT??os.tmpdir(),"thenable-regression-"+path.basename(f.root)+".json"),JSON.stringify({label:_label,result,tree:fs.existsSync(f.tree),tracked:fs.existsSync(path.join(f.tree,"tracked.txt"))?fs.readFileSync(path.join(f.tree,"tracked.txt"),"utf8"):null,ignored:fs.existsSync(path.join(f.tree,".candidate-cache")),branchTip:git(f.repo,["rev-parse",branch]),expectedTip:f.head},null,2));
 expect(result.ok).toBe(false);retained(f);
});
it("descriptor getter failure conservatively refuses",async()=>{
 const f=fixture();const policy=Object.defineProperty({},"protectedEntries",{get(){throw new Error("owned getter");}});
 expect((await parkWorktree(f.target,()=>undefined,optionsFor(policy))).ok).toBe(false);retained(f);
});
it.each(["tracked","untracked"])("dirty %s work is never waivable by policy",async kind=>{
 const f=fixture();const name=kind==="tracked"?"tracked.txt":"untracked-note";fs.writeFileSync(path.join(f.tree,name),"owned late bytes");
 const classify=vi.fn(()=>[]);expect((await parkWorktree(f.target,()=>undefined,{ignoredFiles:{protectedEntries:classify}})).ok).toBe(false);
 expect(classify).not.toHaveBeenCalled();expect(fs.readFileSync(path.join(f.tree,name),"utf8")).toBe("owned late bytes");
});
it.each(["local-copy","own-tracking"])("fresh policy detects late paid bytes on %s fast path",async mode=>{
 const f=fixture([".candidate-cache"],mode==="own-tracking");const seen:ParkIgnoredFilesObservation[]=[];
 const policy:ParkIgnoredFilesPolicy={protectedEntries:o=>{seen.push(o);return fs.readFileSync(path.join(o.worktree,".candidate-cache"),"utf8").includes("paid")?[".candidate-cache"]:[];}};
 const recheck=vi.fn(()=>{fs.writeFileSync(path.join(f.tree,".candidate-cache"),"owned paid");return undefined;});
 expect((await parkWorktree(f.target,recheck,{ignoredFiles:policy})).ok).toBe(false);expect(recheck).toHaveBeenCalledTimes(1);
 expect(seen.length).toBeGreaterThanOrEqual(3);retained(f);expect(fs.readFileSync(path.join(f.tree,".candidate-cache"),"utf8")).toBe("owned paid");
});
it.each(["empty","nonstring","throws"])("formatter %s remains refusal only",async mode=>{
 const f=fixture();const formatRefusal=()=>{if(mode==="throws")throw new Error("owned format");return mode==="empty"?"":1;};
 const result=await parkWorktree(f.target,()=>undefined,optionsFor({protectedEntries:()=>[".candidate-cache"],formatRefusal}));
 expect(result).toMatchObject({ok:false,reason:expect.stringContaining(".candidate-cache")});retained(f);
});
it("formatter cannot deny an empty protected subset or freeze its caller",async()=>{
 const f=fixture();const formatRefusal=vi.fn(()=>"must not run");const policy={protectedEntries:()=>[],formatRefusal};
 expect(await parkWorktree(f.target,()=>undefined,{ignoredFiles:policy})).toEqual({ok:true,head:f.head});
 expect(formatRefusal).not.toHaveBeenCalled();expect(Object.isFrozen(policy)).toBe(false);
});

const shellQuote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
function commandFixture(f:ReturnType<typeof fixture>,body:string){
 const bin=path.join(f.root,"bin");fs.mkdirSync(bin);const calls=path.join(f.root,"calls");
 fs.writeFileSync(path.join(bin,"git"),"#!/bin/sh\nprintf '%s\\n' \"$*\" >> "+shellQuote(calls)+"\n"+body+'\nexec /usr/bin/git "$@"\n',{mode:0o755});
 fs.writeFileSync(path.join(bin,"gh"),"#!/bin/sh\nexit 127\n",{mode:0o755});
 vi.stubEnv("PATH",bin+path.delimiter+(process.env.PATH??""));return calls;
}
it("failed collapsed expansion is protected even when callback returns empty",async()=>{
 const f=fixture(["workspace/private-note"]);
 const calls=commandFixture(f,'if [ "$1" = ls-files ] && [ "$5" = -- ]; then exit 1; fi');
 expect((await parkWorktree(f.target,()=>undefined,{ignoredFiles:{expandDirectories:true,protectedEntries:()=>[]}})).ok).toBe(false);
 expect(fs.readFileSync(calls,"utf8")).toContain("ls-files --others --ignored --exclude-standard -- workspace/");
 retained(f,["workspace/private-note"]);
});
it.each(["status","ls-files"])("unreadable %s is never passed to the classifier",async command=>{
 const f=fixture();commandFixture(f,'if [ "$1" = '+shellQuote(command)+' ]; then exit 1; fi');
 const classify=vi.fn(()=>[]);
 expect((await parkWorktree(f.target,()=>undefined,{ignoredFiles:{protectedEntries:classify}})).ok).toBe(false);
 expect(classify).not.toHaveBeenCalled();retained(f);
});
it("Git removal rejection remains nonforced and retains files and branch",async()=>{
 const f=fixture();const calls=commandFixture(f,'if [ "$1" = worktree ] && [ "$2" = remove ]; then exit 1; fi');
 const result=await parkWorktree(f.target,()=>undefined,{ignoredFiles:{protectedEntries:()=>[]}});
 expect(result).toMatchObject({ok:false,reason:expect.stringContaining("git would not remove")});
 expect(fs.readFileSync(calls,"utf8")).toContain("worktree remove "+f.tree);
 expect(fs.readFileSync(calls,"utf8")).not.toContain("--force");retained(f);
});
it("formatter receives the frozen validated subset in observation order",async()=>{
 const f=fixture([".candidate-cache","private-note"]);
 const formatter=vi.fn((o:ParkIgnoredFilesObservation)=>{
  expect(o.entries).toEqual([".candidate-cache","private-note"]);
  expect(Object.isFrozen(o)).toBe(true);expect(Object.isFrozen(o.entries)).toBe(true);
  return "owned exact original diagnostic";
 });
 expect(await parkWorktree(f.target,()=>undefined,{ignoredFiles:{
  protectedEntries:()=>["private-note",".candidate-cache"],formatRefusal:formatter,
 }})).toEqual({ok:false,reason:"owned exact original diagnostic"});
 expect(formatter).toHaveBeenCalledTimes(1);retained(f,[".candidate-cache","private-note"]);
});
it("policy descriptor is copied once without mutating its caller",async()=>{
 const f=fixture();const original=vi.fn(():string[]=>[]);const replacement=vi.fn(()=>[".candidate-cache"]);
 const policy={protectedEntries:original};
 expect(await parkWorktree(f.target,()=>{policy.protectedEntries=replacement;return undefined;},{ignoredFiles:policy})).toEqual({ok:true,head:f.head});
 expect(replacement).not.toHaveBeenCalled();expect(Object.isFrozen(policy)).toBe(false);
 expect(policy.protectedEntries).toBe(replacement);
});
it("no policy preserves the exact original local-copy command order",async()=>{
 const f=fixture([]);const calls=commandFixture(f,"");
 expect(await parkWorktree(f.target)).toEqual({ok:true,head:f.head});
 expect(fs.readFileSync(calls,"utf8").trim().split("\n")).toEqual([
  "symbolic-ref --quiet --short HEAD","status --porcelain -uall",
  "ls-files --others --ignored --exclude-standard --directory","remote get-url origin",
  "rev-parse HEAD","worktree remove "+f.tree,
 ]);
});
