import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeAllocator } from "./allocator.js";
import { inspectForRelease } from "./release-safety.js";
import { runGit } from "./git.js";
import { seedRepo } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";

const roots: string[] = [];
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const git = (args: readonly string[], cwd: string): string => execFileSync(realGit, [...args], { cwd, encoding: "utf8", env: fixtureEnv() }).trim();
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function fixture(proof = "head", mode: "git" | "git-or-merged-pr-tip" = "git-or-merged-pr-tip") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "merged-tip-"))); roots.push(root);
  const repo = path.join(root, "repo"); fs.mkdirSync(repo); seedRepo(repo);
  const allocator = createWorktreeAllocator({ releaseProof: mode });
  const allocation = await allocator.allocate({ baseCwd: repo, agentName: "alice" });
  fs.writeFileSync(path.join(allocation.cwd, "feature.ts"), "branch\n");
  git(["add", "feature.ts"], allocation.cwd); git(["commit", "-m", "feature"], allocation.cwd);
  const tip = git(["rev-parse", "HEAD"], allocation.cwd);
  fs.writeFileSync(path.join(repo, "feature.ts"), "main changed since squash\n");
  git(["add", "feature.ts"], repo); git(["commit", "-m", "later main"], repo);
  const pr = { state: "MERGED", headRefOid: proof === "head" ? tip : "f".repeat(40), commits: [{ oid: tip }] };
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const response = path.join(root, "pr.json"); fs.writeFileSync(response, JSON.stringify(pr));
  const calls = path.join(root, "gh-calls");
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(calls)}\ncat ${quote(response)}\n`, { mode: 0o755 });
  vi.stubEnv("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
  return { root, repo, bin, allocator, allocation, tip, pr, response, calls };
}
function shim(f: Awaited<ReturnType<typeof fixture>>, condition: string, action: string): void {
  fs.writeFileSync(path.join(f.bin, "git"), `#!/bin/sh\nif ${condition}; then\n${action}\nfi\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
}
function retained(f: Awaited<ReturnType<typeof fixture>>): void {
  expect(fs.existsSync(f.allocation.cwd)).toBe(true);
  expect(git(["rev-parse", "--verify", "refs/heads/agent-chat/alice"], f.repo)).toMatch(/^[a-f0-9]{40}$/);
}

describe("explicit merged PR tip release proof", () => {
  it.each(["head", "member"])("permits the original merged %s proof only after explicit opt-in", async proof => {
    const f = await fixture(proof);
    const result = await f.allocator.release({}, f.allocation);
    expect(result).toEqual({ released: true });
    expect(fs.existsSync(f.allocation.cwd)).toBe(false);
    expect(git(["branch", "--list", "agent-chat/alice"], f.repo)).toBe("");
    expect(fs.readFileSync(f.calls, "utf8")).toContain("--json state,headRefOid,commits");
  });
  it("recognizes an exact merged head independently of commit-membership evidence", async () => {
    const f = await fixture(); fs.writeFileSync(f.response, JSON.stringify({ ...f.pr, commits: [] }));
    expect(await f.allocator.release({}, f.allocation)).toEqual({ released: true });
    expect(fs.existsSync(f.allocation.cwd)).toBe(false);
  });
  it.each(["head", "member"])("keeps default git-only refusal for the same %s observation", async proof => {
    const f = await fixture(proof, "git");
    expect((await f.allocator.release({}, f.allocation)).released).toBe(false); retained(f);
    expect(fs.readFileSync(f.calls, "utf8")).toContain("--json state --jq .state");
  });
  it.each(["open", "closed", "outside", "bad-json", "bad-commits", "missing", "failed"])("never accepts %s as a merged-tip proof", async kind => {
    const f = await fixture();
    const response = kind === "open" ? { ...f.pr, state: "OPEN" } : kind === "closed" ? { ...f.pr, state: "CLOSED" } :
      kind === "outside" ? { ...f.pr, headRefOid: "f".repeat(40), commits: [] } : kind === "bad-commits" ? { ...f.pr, commits: ["bad"] } : {};
    fs.writeFileSync(f.response, kind === "bad-json" ? "{" : JSON.stringify(response));
    if (kind === "missing") {
      fs.unlinkSync(path.join(f.bin, "gh")); fs.symlinkSync(realGit, path.join(f.bin, "git")); vi.stubEnv("PATH", f.bin);
      expect(await runGit(["status", "--porcelain", "-uall"], f.allocation.cwd)).toBe("");
      expect(await runGit(["rev-parse", "--verify", "agent-chat/alice"], f.repo)).toBe(f.tip);
      expect(await runGit(["diff", "--name-only", "main", "agent-chat/alice"], f.repo)).toBe("feature.ts");
      try { execFileSync("gh", ["--version"], { env: fixtureEnv() }); throw new Error("unexpected gh executable"); }
      catch (error) { expect(error).toMatchObject({ code: "ENOENT" }); }
    }
    if (kind === "failed") fs.writeFileSync(path.join(f.bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect((await f.allocator.release({}, f.allocation)).released).toBe(false); retained(f);
  });
  it("refuses a later local commit outside the moved merged PR", async () => {
    const f = await fixture("member");
    fs.writeFileSync(path.join(f.allocation.cwd, "extra.ts"), "not in PR\n");
    git(["add", "extra.ts"], f.allocation.cwd); git(["commit", "-m", "extra local"], f.allocation.cwd);
    const outcome = await f.allocator.release({}, f.allocation);
    expect(outcome.released).toBe(false);
    if (!outcome.released) expect(outcome.refusal).toMatch(/gh reports the PR as MERGED$/);
    retained(f);
  });
  for (const proof of ["head", "member"]) {
    it.each(["hidden", "ignored", "status-error", "ignored-error"])(`${proof} proof cannot override %s file-loss refusal`, async danger => {
      const f = await fixture(proof);
      if (danger === "hidden") { git(["config", "status.showUntrackedFiles", "no"], f.repo); fs.writeFileSync(path.join(f.allocation.cwd, "notes.txt"), "private fixture\n"); }
      if (danger === "ignored") { fs.appendFileSync(path.join(f.repo, ".git/info/exclude"), "\nnotes.txt\n"); fs.writeFileSync(path.join(f.allocation.cwd, "notes.txt"), "private fixture\n"); }
      if (danger === "status-error") shim(f, '[ "$1" = status ]', "exit 1");
      if (danger === "ignored-error") shim(f, '[ "$1" = ls-files ]', "exit 1");
      const safety = await inspectForRelease(f.repo, f.allocation.cwd, "agent-chat/alice", f.allocation.ref.base ?? "HEAD", "git-or-merged-pr-tip");
      expect(safety.landed).toBe(true); expect(safety.dirty).toBe(true);
      expect((await f.allocator.release({}, f.allocation)).released).toBe(false); retained(f);
    });
    it(`${proof} proof never retries a refused nonforced removal or deletes its branch`, async () => {
      const f = await fixture(proof); const removes = path.join(f.root, "remove-calls");
      shim(f, '[ "$1" = worktree ] && [ "$2" = remove ]', `printf '%s\\n' "$*" >> ${quote(removes)}\necho 'fixture refuses remove' >&2\nexit 1`);
      const outcome = await f.allocator.release({}, f.allocation);
      expect(outcome.released).toBe(false); retained(f);
      expect(fs.readFileSync(removes, "utf8").trim().split("\n")).toHaveLength(1);
      expect(fs.readFileSync(removes, "utf8")).not.toContain("--force");
    });
  }
  it("preserves assigned exemption and grace without a proof subprocess", async () => {
    const f = await fixture();
    expect((await f.allocator.release({ exitedAt: Date.now() }, f.allocation)).released).toBe(false);
    expect(await f.allocator.release({}, { ref: { ...f.allocation.ref, assigned: "true" } })).toEqual({ released: true });
    expect(fs.existsSync(f.calls)).toBe(false); retained(f);
  });
});
