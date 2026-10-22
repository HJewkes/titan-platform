import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as built from "../dist/index.js";
import { seedRepo } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";

const roots: string[] = [];
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const git = (args: readonly string[], cwd: string): string => execFileSync(realGit, [...args], { cwd, encoding: "utf8", env: fixtureEnv() }).trim();
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "strict-fetch-"))); roots.push(root);
  const seed = path.join(root, "seed"); fs.mkdirSync(seed); seedRepo(seed);
  return { root, seed };
}
function originFixture(branch = "main") {
  const { root, seed } = fixture();
  if (branch !== "main") git(["branch", "-m", "main", branch], seed);
  const origin = path.join(root, "origin.git"); git(["clone", "--quiet", "--bare", seed, origin], seed);
  const clones = ["peer", "local"].map(name => {
    const dir = path.join(root, name); git(["clone", "--quiet", origin, dir], seed);
    git(["config", "user.email", "test@example.com"], dir); git(["config", "user.name", "Test"], dir);
    git(["config", "commit.gpgsign", "false"], dir); git(["config", "maintenance.auto", "false"], dir);
    return dir;
  });
  return { root, origin, peer: clones[0] ?? seed, local: clones[1] ?? seed };
}
function advance(repo: string, file: string): string {
  fs.writeFileSync(path.join(repo, file), "owned fixture\n"); git(["add", file], repo); git(["commit", "-q", "-m", file], repo);
  return git(["rev-parse", "HEAD"], repo);
}

describe("built public strict default fetch", () => {
  it("refuses no-origin without substituting the local HEAD", async () => {
    const { seed } = fixture(); const head = git(["rev-parse", "HEAD"], seed);
    expect(await built.fetchDefaultTip(seed, 2_000)).toBe("the repository has no origin remote");
    expect(git(["rev-parse", "HEAD"], seed)).toBe(head);
  });
  it("refuses an unreachable owned origin while the separate resolver keeps its old HEAD fallback", async () => {
    const { root, local } = originFixture(); const head = advance(local, "local-only.txt");
    git(["remote", "set-url", "origin", path.join(root, "missing.git")], local);
    expect(await built.fetchDefaultTip(local, 2_000)).toBe("fetching origin/main failed or timed out");
    expect(await built.resolveBranchBase(local, 2_000)).toMatchObject({ sha: head, ref: "HEAD", warning: expect.stringContaining("failed or timed out") });
    expect(git(["rev-parse", "HEAD"], local)).toBe(head);
  });
  it("fetches current origin without moving a foreign local commit or edited checkout file", async () => {
    const { peer, local } = originFixture(); const remote = advance(peer, "remote.txt"); git(["push", "-q", "origin", "main"], peer);
    const head = advance(local, "foreign.txt"); fs.writeFileSync(path.join(local, "README.md"), "uncommitted local edit\n");
    expect(await built.fetchDefaultTip(local, 2_000)).toEqual({ sha: remote, ref: "origin/main" });
    expect(git(["rev-parse", "HEAD"], local)).toBe(head);
    expect(fs.readFileSync(path.join(local, "README.md"), "utf8")).toBe("uncommitted local edit\n");
    expect(git(["rev-parse", "origin/main"], local)).toBe(remote);
  });
  it("uses origin HEAD's custom branch instead of assuming main or master", async () => {
    const { peer, local } = originFixture("trunk"); const tip = advance(peer, "trunk.txt"); git(["push", "-q", "origin", "trunk"], peer);
    expect(await built.fetchDefaultTip(local, 2_000)).toEqual({ sha: tip, ref: "origin/trunk" });
  });
  it("does not replace a missing origin HEAD target with an available main", async () => {
    const { local } = originFixture(); git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing"], local);
    expect(await built.fetchDefaultTip(local, 2_000)).toBe("fetching origin/missing failed or timed out");
  });
  it("tries master after absent main only when origin HEAD is unknown", async () => {
    const { peer, local } = originFixture("master"); const tip = advance(peer, "master.txt"); git(["push", "-q", "origin", "master"], peer);
    git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], local);
    expect(await built.fetchDefaultTip(local, 2_000)).toEqual({ sha: tip, ref: "origin/master" });
  });
  it("shares one exhausted deadline across candidates without sleeping or launching SSH", async () => {
    const { root, seed } = fixture(); const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    const marker = path.join(root, "budget-spent"), calls = path.join(root, "fetch-calls");
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$1" = remote ]; then printf 'owned-origin\\n'; exit 0; fi\nif [ "$1" = fetch ]; then printf '%s\\n' "$*" >> ${quote(calls)}; : > ${quote(marker)}; fi\nexit 1\n`, { mode: 0o755 });
    vi.stubEnv("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
    vi.spyOn(Date, "now").mockImplementation(() => fs.existsSync(marker) ? 10_000 : 1_000);
    expect(await built.fetchDefaultTip(seed, 500)).toBe("fetching origin/main or origin/master failed or timed out");
    const fetches = fs.readFileSync(calls, "utf8").trim().split("\n");
    expect(fetches).toHaveLength(1); expect(fetches[0]).toContain("+refs/heads/main:refs/remotes/origin/main");
  });
});
