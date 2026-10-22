import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./index.js";
import { seedRepo } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";

const roots: string[] = [];
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const git = (args: readonly string[], cwd: string): string => execFileSync(realGit, [...args], { cwd, encoding: "utf8", env: fixtureEnv() }).trim();
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "typed-refusal-"))); roots.push(root);
  const repo = path.join(root, "repo"); fs.mkdirSync(repo); seedRepo(repo);
  const allocator = api.createWorktreeAllocator({ releaseProof: "git-or-merged-pr-tip" });
  const allocation = await allocator.allocate({ baseCwd: repo, agentName: "alice" });
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const calls = path.join(root, "git-calls");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(calls)}\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  vi.stubEnv("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
  return { root, repo, allocator, allocation, bin, calls };
}
function shim(f: Awaited<ReturnType<typeof fixture>>, condition: string): void {
  fs.writeFileSync(path.join(f.bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(f.calls)}\nif ${condition}; then exit 1; fi\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
}
function retained(f: Awaited<ReturnType<typeof fixture>>): void {
  expect(fs.existsSync(f.allocation.cwd)).toBe(true);
  expect(git(["rev-parse", "--verify", "refs/heads/agent-chat/alice"], f.repo)).toMatch(/^[a-f0-9]{40}$/);
}
function diverge(f: Awaited<ReturnType<typeof fixture>>): string {
  fs.writeFileSync(path.join(f.allocation.cwd, "feature.txt"), "branch\n");
  git(["add", "."], f.allocation.cwd); git(["commit", "-m", "feature"], f.allocation.cwd);
  const tip = git(["rev-parse", "HEAD"], f.allocation.cwd);
  fs.writeFileSync(path.join(f.repo, "feature.txt"), "main\n"); git(["add", "."], f.repo); git(["commit", "-m", "main"], f.repo);
  return tip;
}

describe("typed presentation preserves release authority", () => {
  it.each(["tracked", "untracked", "hidden"])("codes only ordinary %s refusal with unchanged text and probes", async kind => {
    const f = await fixture();
    if (kind === "tracked") { fs.writeFileSync(path.join(f.allocation.cwd, "tracked.txt"), "old\n"); git(["add", "."], f.allocation.cwd); git(["commit", "-m", "tracked"], f.allocation.cwd); git(["merge", "--ff-only", "agent-chat/alice"], f.repo); }
    if (kind === "hidden") git(["config", "status.showUntrackedFiles", "no"], f.repo);
    fs.writeFileSync(path.join(f.allocation.cwd, kind === "tracked" ? "tracked.txt" : "notes.txt"), "owned notes\n");
    const result = await f.allocator.release({}, f.allocation);
    expect(result).toMatchObject({ released: false, refusalCode: "unsaved-changes", refusal: `uncommitted or untracked changes in ${f.allocation.cwd}` });
    expect(fs.readFileSync(f.calls, "utf8").split("\n").filter(line => line.startsWith("status "))).toHaveLength(1);
    retained(f);
  });
  it.each(["unmerged", "grace", "ignored", "status-error", "ignored-error", "remove-error"])("does not label %s as ordinary dirt", async danger => {
    const f = await fixture();
    if (danger === "unmerged") { diverge(f); fs.writeFileSync(path.join(f.allocation.cwd, "notes.txt"), "notes\n"); }
    if (danger === "ignored") { fs.appendFileSync(path.join(f.repo, ".git/info/exclude"), "\nnotes.txt\n"); fs.writeFileSync(path.join(f.allocation.cwd, "notes.txt"), "notes\n"); }
    if (danger === "status-error") shim(f, '[ "$1" = status ]');
    if (danger === "ignored-error") shim(f, '[ "$1" = ls-files ]');
    if (danger === "remove-error") shim(f, '[ "$1" = worktree ] && [ "$2" = remove ]');
    const result = await f.allocator.release(danger === "grace" ? { exitedAt: Date.now() } : {}, f.allocation);
    expect(result.released).toBe(false); expect(result).not.toHaveProperty("refusalCode"); retained(f);
  });
  it("keeps the exact public inspection shape and ordinary message", async () => {
    const f = await fixture(); fs.writeFileSync(path.join(f.allocation.cwd, "notes.txt"), "notes\n");
    const safety = await api.inspectForRelease(f.repo, f.allocation.cwd, "agent-chat/alice", f.allocation.ref.base ?? "HEAD");
    expect(Object.keys(safety).sort()).toEqual(["ahead", "checked", "dirty", "landed", "unmerged"]);
    expect(safety.checked[0]).toEqual({ name: "dirty", ok: false, detail: `uncommitted or untracked changes in ${f.allocation.cwd}` });
  });
  for (const proof of ["head", "member"]) {
    it.each(["clean-ordinary", "ordinary-ordinary", "ordinary-removed", "ignored-ordinary", "ordinary-ignored", "ordinary-status-error", "status-error-ordinary", "ordinary-ignored-error"])(`${proof} proof preserves mixed observation classification for %s`, async mode => {
      const f = await fixture(); const tip = diverge(f); const notes = path.join(f.allocation.cwd, "notes.txt");
      const marker = path.join(f.root, "provider-finished");
      if (mode === "ordinary-ignored") fs.appendFileSync(path.join(f.repo, ".git/info/exclude"), "\nprivate.txt\n");
      if (mode.startsWith("ordinary")) fs.writeFileSync(notes, "notes\n");
      if (mode === "ignored-ordinary") { fs.appendFileSync(path.join(f.repo, ".git/info/exclude"), "\nnotes.txt\n"); fs.writeFileSync(notes, "notes\n"); }
      if (mode === "status-error-ordinary") shim(f, `[ ! -f ${quote(marker)} ] && [ "$1" = status ]`);
      if (mode === "ordinary-status-error") shim(f, `[ -f ${quote(marker)} ] && [ "$1" = status ]`);
      if (mode === "ordinary-ignored-error") shim(f, `[ -f ${quote(marker)} ] && [ "$1" = ls-files ]`);
      const response = path.join(f.root, "proof.json");
      fs.writeFileSync(response, JSON.stringify({ state: "MERGED", headRefOid: proof === "head" ? tip : "f".repeat(40), commits: [{ oid: tip }] }));
      const action = mode === "ordinary-ignored" ? `rm ${quote(notes)}\nprintf 'private notes\\n' > ${quote(path.join(f.allocation.cwd, "private.txt"))}` : mode === "ordinary-removed" || mode === "ordinary-ignored-error" ? `rm ${quote(notes)}` :
        mode === "ignored-ordinary" ? `rm ${quote(notes)}\nprintf 'new notes\\n' > ${quote(path.join(f.allocation.cwd, "new.txt"))}` : `printf 'new notes\\n' > ${quote(notes)}`;
      fs.writeFileSync(path.join(f.bin, "gh"), `#!/bin/sh\n${action}\nprintf done > ${quote(marker)}\ncat ${quote(response)}\n`, { mode: 0o755 });
      const result = await f.allocator.release({}, f.allocation);
      expect(result.released).toBe(false); retained(f);
      if (mode === "clean-ordinary" || mode === "ordinary-ordinary" || mode === "ordinary-removed") expect(result).toHaveProperty("refusalCode", "unsaved-changes");
      else expect(result).not.toHaveProperty("refusalCode");
      expect(fs.readFileSync(f.calls, "utf8").split("\n").filter(line => line.startsWith("status "))).toHaveLength(2);
    });
  }
  it.each(["absent", "mismatched"])("exposes the typed missing-assigned-record error for %s record with unchanged message", async kind => {
    const f = await fixture(); const assigned = path.join(f.repo, ".worktrees", "missing");
    const request = { baseCwd: f.repo, agentName: "bob", assignedWorktree: assigned,
      ...(kind === "mismatched" ? { assignedRecord: { gitRoot: f.repo, worktree: path.join(f.repo, ".worktrees", "other"), branch: "agent-chat/bob" } } : {}) };
    const error: unknown = await f.allocator.allocate(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const exported: unknown = Reflect.get(api, "MissingAssignedWorktreeRecordError");
    expect(exported).toBeTypeOf("function");
    expect(error).toMatchObject({ constructor: exported, worktreePath: assigned, message: `assigned worktree ${assigned} does not exist, and there is no record of allocating it to re-create it from. Not spawned` });
    expect(fs.existsSync(assigned)).toBe(false);
  });
});
