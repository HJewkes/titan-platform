import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parkWorktree } from "./park.js";
import { seedRepoWithOrigin } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";

const roots: string[] = [];
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const git = (args: string[], cwd: string): string =>
  execFileSync(realGit, args, {
    cwd,
    encoding: "utf8",
    env: fixtureEnv(),
  }).trim();
const quote = (value: string): string =>
  "'" + value.replaceAll("'", "'\\''") + "'";
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "park-default-"))
  );
  roots.push(root);
  const repo = path.join(root, "repo");
  const origin = path.join(root, "origin");
  fs.mkdirSync(repo);
  fs.mkdirSync(origin);
  seedRepoWithOrigin(repo, origin);
  const branch = "agent-chat/worker";
  const worktree = path.join(repo, ".worktrees", "worker");
  git(["worktree", "add", "-qb", branch, worktree], repo);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const fetches = path.join(root, "fetches");
  const target = { gitRoot: repo, worktree, branch };
  const script = (action = "") => {
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = fetch ]; then\nprintf 'fetch\\n' >> ${quote(
        fetches
      )}\n${action}\nfi\nexec ${quote(realGit)} "$@"\n`,
      { mode: 0o755 }
    );
    vi.stubEnv("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
  };
  script();
  return { root, repo, origin, bin, fetches, target, script };
}
const missing = (f: ReturnType<typeof fixture>) => ({
  ok: false,
  reason: `${f.target.branch} is not on origin; push it first`,
});
function retained(f: ReturnType<typeof fixture>) {
  expect(fs.existsSync(f.target.worktree)).toBe(true);
  expect(git(["rev-parse", "--verify", f.target.branch], f.repo)).toMatch(
    /^[a-f0-9]{40}$/
  );
}
function commitLocal(f: ReturnType<typeof fixture>) {
  fs.writeFileSync(
    path.join(f.target.worktree, "local.txt"),
    "owned local work\n"
  );
  git(["add", "local.txt"], f.target.worktree);
  git(["commit", "-qm", "local"], f.target.worktree);
}
describe("explicit fetched DEFAULT park proof", () => {
  it.each([undefined, false])(
    "keeps old missing-branch refusal and no fetch when opt-in is %j",
    async (flag) => {
      const f = fixture();
      const options =
        flag === undefined ? {} : { allowDefaultBranchAncestor: flag };
      expect(await parkWorktree(f.target, () => undefined, options)).toEqual(
        missing(f)
      );
      expect(fs.existsSync(f.fetches)).toBe(false);
      retained(f);
    }
  );
  it("accepts only the opt-in fetched DEFAULT ancestor and keeps its branch", async () => {
    const f = fixture();
    const head = git(["rev-parse", "HEAD"], f.target.worktree);
    expect(
      await parkWorktree(f.target, () => undefined, {
        allowDefaultBranchAncestor: true,
        fetchTimeoutMs: 1_000,
      })
    ).toEqual({ ok: true, head });
    expect(fs.existsSync(f.target.worktree)).toBe(false);
    expect(git(["rev-parse", f.target.branch], f.repo)).toBe(head);
    expect(fs.readFileSync(f.fetches, "utf8")).toBe("fetch\n");
  });
  it("still refuses a local-only commit with the exact existing reason", async () => {
    const f = fixture();
    commitLocal(f);
    expect(
      await parkWorktree(f.target, () => undefined, {
        allowDefaultBranchAncestor: true,
      })
    ).toEqual(missing(f));
    retained(f);
    expect(
      fs.readFileSync(path.join(f.target.worktree, "local.txt"), "utf8")
    ).toBe("owned local work\n");
    expect(fs.readFileSync(f.fetches, "utf8")).toBe("fetch\n");
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses invalid budget %j without fetching",
    async (budget) => {
      const f = fixture();
      expect(
        await parkWorktree(f.target, () => undefined, {
          allowDefaultBranchAncestor: true,
          fetchTimeoutMs: budget,
        })
      ).toEqual(missing(f));
      expect(fs.existsSync(f.fetches)).toBe(false);
      retained(f);
    }
  );
  it("never treats stale tracking or local HEAD as fresh fetch proof", async () => {
    const f = fixture();
    f.script("exit 1");
    expect(
      await parkWorktree(f.target, () => undefined, {
        allowDefaultBranchAncestor: true,
      })
    ).toEqual(missing(f));
    expect(fs.existsSync(f.fetches)).toBe(true);
    retained(f);
  });
  it("refuses initial unsaved work before any optional fetch", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.target.worktree, "initial.txt"), "owned\n");
    expect(
      await parkWorktree(f.target, () => undefined, {
        allowDefaultBranchAncestor: true,
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("uncommitted or untracked changes"),
    });
    expect(fs.existsSync(f.fetches)).toBe(false);
    retained(f);
  });
  it("rechecks ignored files introduced during DEFAULT fetch", async () => {
    const f = fixture();
    git(["config", "core.excludesFile", path.join(f.root, "ignore")], f.repo);
    fs.writeFileSync(path.join(f.root, "ignore"), "late.txt\n");
    f.script(
      `printf 'owned late file\\n' > ${quote(
        path.join(f.target.worktree, "late.txt")
      )}`
    );
    expect(
      await parkWorktree(f.target, () => undefined, {
        allowDefaultBranchAncestor: true,
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ignored files"),
    });
    expect(fs.existsSync(f.fetches)).toBe(true);
    retained(f);
    expect(
      fs.readFileSync(path.join(f.target.worktree, "late.txt"), "utf8")
    ).toBe("owned late file\n");
  });
  it.each(["ignored", "untracked", "commit", "branch"])(
    "binds final state after callback introduces %s",
    async (danger) => {
      const f = fixture();
      let calls = 0;
      if (danger === "ignored") {
        git(
          ["config", "core.excludesFile", path.join(f.root, "ignore")],
          f.repo
        );
        fs.writeFileSync(path.join(f.root, "ignore"), "late.txt\n");
      }
      const recheck = () => {
        calls++;
        if (danger === "branch")
          git(["switch", "-qc", "side"], f.target.worktree);
        else if (danger === "commit") commitLocal(f);
        else
          fs.writeFileSync(
            path.join(f.target.worktree, "late.txt"),
            "owned callback file\n"
          );
        return undefined;
      };
      const result = await parkWorktree(f.target, recheck, {
        allowDefaultBranchAncestor: true,
      });
      expect(calls).toBe(1);
      expect(result.ok).toBe(false);
      retained(f);
      if (danger === "ignored" || danger === "untracked")
        expect(
          fs.readFileSync(path.join(f.target.worktree, "late.txt"), "utf8")
        ).toBe("owned callback file\n");
      if (danger === "commit") expect(result).toEqual(missing(f));
      if (danger === "branch")
        expect(result).toMatchObject({
          reason: expect.stringContaining("on side"),
        });
    }
  );
  it.each(["commit", "branch"])(
    "does not authorize a %s changed during the DEFAULT fetch",
    async (danger) => {
      const f = fixture();
      const work = quote(f.target.worktree);
      f.script(
        danger === "branch"
          ? `${quote(realGit)} -C ${work} switch -qc side`
          : `printf 'owned local work\\n' > ${quote(
              path.join(f.target.worktree, "local.txt")
            )}\n${quote(realGit)} -C ${work} add local.txt\n${quote(
              realGit
            )} -C ${work} commit -qm late`
      );
      const result = await parkWorktree(f.target, () => undefined, {
        allowDefaultBranchAncestor: true,
      });
      expect(result.ok).toBe(false);
      expect(fs.existsSync(f.fetches)).toBe(true);
      retained(f);
      if (danger === "commit") {
        expect(result).toEqual(missing(f));
        expect(git(["rev-parse", "HEAD"], f.target.worktree)).not.toBe(
          git(["rev-parse", "main"], f.repo)
        );
      } else
        expect(result).toMatchObject({
          reason: expect.stringContaining("on side"),
        });
    }
  );
  it.each(["status", "ls-files"])(
    "refuses a final %s failure introduced by the callback",
    async (command) => {
      const f = fixture();
      const marker = path.join(f.root, "late-failure");
      const file = path.join(f.bin, "git");
      const script = fs.readFileSync(file, "utf8");
      fs.writeFileSync(
        file,
        script.replace(
          `exec ${quote(realGit)}`,
          `if [ -f ${quote(marker)} ] && [ "$1" = ${quote(
            command
          )} ]; then exit 1; fi\nexec ${quote(realGit)}`
        )
      );
      let calls = 0;
      const result = await parkWorktree(
        f.target,
        () => {
          calls++;
          fs.writeFileSync(marker, "owned");
          return undefined;
        },
        { allowDefaultBranchAncestor: true }
      );
      expect(calls).toBe(1);
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining(
          command === "status"
            ? "could not read git status"
            : "could not list ignored files"
        ),
      });
      retained(f);
    }
  );
  it("honors the caller's late refusal without removing the tree", async () => {
    const f = fixture();
    let called = false;
    expect(
      await parkWorktree(
        f.target,
        () => {
          called = true;
          return "owned late claimant";
        },
        { allowDefaultBranchAncestor: true }
      )
    ).toEqual({ ok: false, reason: "owned late claimant" });
    expect(called).toBe(true);
    retained(f);
  });
});
