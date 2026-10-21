import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { seedRepo } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";
import { reclaimWorktree, sweepWorktrees } from "./sweep.js";

const roots: string[] = [];
const branch = "agent-chat/worker";
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const git = (cwd: string, args: string[]): string =>
  execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", env: fixtureEnv() }).trim();
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-safety-")));
  roots.push(root);
  const repo = path.join(root, "repo"); fs.mkdirSync(repo); seedRepo(repo);
  const tree = path.join(repo, ".worktrees", "worker");
  git(repo, ["worktree", "add", "-qb", branch, tree]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const marker = path.join(root, "fault");
  const calls = path.join(root, "calls");
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> " + quote(calls),
    "if [ -f " + quote(marker) + " ]; then",
    "  fault=$(cat " + quote(marker) + ")",
    "  if [ \"$fault\" = status ] && [ \"$1\" = status ]; then exit 1; fi",
    "  if [ \"$fault\" = ignored ] && [ \"$1\" = ls-files ]; then exit 1; fi",
    "  if [ \"$fault\" = remove ] && [ \"$1\" = worktree ] && [ \"$2\" = remove ]; then",
    "    printf '%s\\n' 'synthetic removal refusal' >&2; exit 1",
    "  fi",
    "fi",
    'exec /usr/bin/git "$@"', "",
  ].join("\n"), { mode: 0o755 });
  vi.stubEnv("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
  const report = await sweepWorktrees({
    roots: [repo], held: [{ gitRoot: repo, branch, base }],
    list: async cwd => git(cwd, ["worktree", "list", "--porcelain"]),
    ownerOf: () => ({ agentId: "synthetic", name: "worker", state: "exited", lastEventAt: 0 }),
    now: () => 120_001,
  });
  expect(report).toHaveLength(1);
  const entry = report[0]!;
  expect(entry).toMatchObject({ gitRoot: repo, worktree: tree, branch, status: "reclaimable" });
  expect(git(tree, ["status", "--porcelain", "-uall"])).toBe("");
  return { repo, tree, base, entry, marker, calls };
}

it.each(["ignored", "commit", "untracked", "status-error", "ignored-error"])(
  "ordinary reclaim refuses fresh %s after sweep classification",
  async kind => {
    const f = await fixture();
    const note = path.join(f.tree, "late-owned-note.txt");
    if (kind === "ignored") git(f.repo, ["config", "core.excludesFile", path.join(f.repo, ".git", "info", "exclude")]);
    if (kind === "ignored") fs.appendFileSync(path.join(f.repo, ".git", "info", "exclude"), "\nlate-owned-note.txt\n");
    if (["ignored", "commit", "untracked"].includes(kind)) fs.writeFileSync(note, "harmless owned note\n");
    if (kind === "commit") {
      git(f.tree, ["add", "late-owned-note.txt"]); git(f.tree, ["commit", "-qm", "owned late commit"]);
      expect(git(f.tree, ["status", "--porcelain", "-uall"])).toBe("");
      expect(git(f.repo, ["rev-list", "--count", "HEAD.." + branch])).toBe("1");
    }
    if (kind === "ignored") {
      expect(git(f.tree, ["status", "--porcelain", "-uall"])).toBe("");
      expect(git(f.tree, ["ls-files", "--others", "--ignored", "--exclude-standard"])).toBe("late-owned-note.txt");
    }
    const tip = git(f.repo, ["rev-parse", branch]);
    if (kind === "status-error") fs.writeFileSync(f.marker, "status");
    if (kind === "ignored-error") fs.writeFileSync(f.marker, "ignored");
    const result = await reclaimWorktree(f.entry);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(fs.existsSync(f.tree)).toBe(true);
    expect(git(f.repo, ["rev-parse", branch])).toBe(tip);
    if (["ignored", "commit", "untracked"].includes(kind))
      expect(fs.readFileSync(note, "utf8")).toBe("harmless owned note\n");
    if (kind === "status-error") expect(result.reason).toContain("could not read git status");
    if (kind === "ignored-error") expect(result.reason).toContain("could not list ignored files");
  }
);

it("ordinary reclaim still removes an unchanged safe tree and branch", async () => {
  const f = await fixture();
  expect(await reclaimWorktree(f.entry)).toEqual({ ok: true });
  expect(fs.existsSync(f.tree)).toBe(false);
  expect(git(f.repo, ["branch", "--list", branch])).toBe("");
  expect(fs.readFileSync(f.calls, "utf8")).not.toContain("worktree remove --force");
});

it("ordinary reclaim retains the branch when final nonforced Git removal refuses", async () => {
  const f = await fixture();
  fs.writeFileSync(f.marker, "remove");
  const result = await reclaimWorktree(f.entry);
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("synthetic removal refusal");
  expect(fs.existsSync(f.tree)).toBe(true);
  expect(git(f.repo, ["rev-parse", branch])).toBe(f.base);
  expect(fs.readFileSync(f.calls, "utf8")).not.toContain("worktree remove --force");
});
