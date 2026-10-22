import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepWorktrees, type SweepOptions, type SweepOwner } from "./sweep.js";
import { seedRepo } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";

type SafetyView = Readonly<{ dirty: boolean; unmerged: boolean }>;
const roots: string[] = [];
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const git = (args: string[], cwd: string): string =>
  execFileSync(realGit, args, { cwd, encoding: "utf8", env: fixtureEnv(), stdio: "pipe" }).trim();
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-detail-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  seedRepo(repo);
  const branch = "agent-chat/worker";
  const worktree = path.join(repo, ".worktrees", "worker");
  git(["worktree", "add", "-qb", branch, worktree], repo);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const statuses = path.join(root, "statuses");
  const script = (fail = "") => {
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
if [ "$1" = status ]; then printf 'status\\n' >> ${quote(statuses)}; fi
${fail ? `if [ "$1" = ${quote(fail)} ]; then exit 1; fi` : ""}
exec ${quote(realGit)} "$@"
`,
      { mode: 0o755 }
    );
    // Advisory provider lookup is a fixed owned fake, never a live gh command.
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    vi.stubEnv("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
  };
  script();
  const options: SweepOptions = {
    roots: [repo],
    list: async () => git(["worktree", "list", "--porcelain"], repo),
  };
  return { root, repo, branch, worktree, statuses, script, options };
}
function change(
  f: ReturnType<typeof fixture>,
  kind: "dirty" | "unmerged" | "both" | "ignored" | "status" | "ls-files"
) {
  if (kind === "unmerged" || kind === "both") {
    fs.writeFileSync(path.join(f.worktree, "committed.txt"), "owned commit\n");
    git(["add", "committed.txt"], f.worktree);
    git(["commit", "-qm", "owned commit"], f.worktree);
  }
  if (kind === "dirty" || kind === "both")
    fs.writeFileSync(path.join(f.worktree, "scratch.txt"), "owned scratch\n");
  if (kind === "ignored") {
    fs.writeFileSync(path.join(f.root, "ignore"), "scratch.txt\n");
    git(["config", "core.excludesFile", path.join(f.root, "ignore")], f.repo);
    fs.writeFileSync(path.join(f.worktree, "scratch.txt"), "owned ignored\n");
  }
  if (kind === "status" || kind === "ls-files") f.script(kind);
}
function retained(f: ReturnType<typeof fixture>) {
  expect(fs.existsSync(f.worktree)).toBe(true);
  expect(git(["rev-parse", "--verify", f.branch], f.repo)).toMatch(/^[a-f0-9]{40}$/);
}
describe("sweep safety detail presentation", () => {
  it.each(["dirty", "unmerged", "both", "ignored", "status", "ls-files"] as const)(
    "presents the SAME classified %s observation exactly once without altering status or other fields",
    async (kind) => {
      const f = fixture();
      change(f, kind);
      const original = await sweepWorktrees(f.options);
      expect(original).toHaveLength(1);
      expect(original[0]?.status).toBe("holds-work");
      fs.writeFileSync(f.statuses, "");
      const views: SafetyView[] = [];
      const options = {
        ...f.options,
        formatSafetyDetail: (view: SafetyView) => {
          views.push(view);
          expect(Object.isFrozen(view)).toBe(true);
          expect(Object.keys(view).sort()).toEqual(["dirty", "unmerged"]);
          expect(Reflect.set(view, "dirty", false)).toBe(false);
          return [view.dirty && "uncommitted changes", view.unmerged && "commits that exist nowhere else"]
            .filter(Boolean)
            .join(" and ");
        },
      };
      const actual = await sweepWorktrees(options);
      expect(views).toEqual([
        { dirty: kind !== "unmerged", unmerged: kind === "unmerged" || kind === "both" },
      ]);
      expect(actual).toEqual(
        original.map((entry) => ({
          ...entry,
          detail: [
            kind !== "unmerged" && "uncommitted changes",
            (kind === "unmerged" || kind === "both") && "commits that exist nowhere else",
          ]
            .filter(Boolean)
            .join(" and "),
        }))
      );
      expect(fs.readFileSync(f.statuses, "utf8")).toBe("status\n");
      retained(f);
    }
  );
  it.each(["held", "in-grace", "reclaimable"] as const)("never calls a presenter for %s", async (state) => {
    const f = fixture();
    const owner: SweepOwner | undefined =
      state === "reclaimable"
        ? undefined
        : {
            agentId: "owned",
            name: "worker",
            state: state === "held" ? "live" : "exited",
            lastEventAt: 1000,
          };
    const base = { ...f.options, ownerOf: () => owner, now: () => 1000 };
    const original = await sweepWorktrees(base);
    const options = {
      ...base,
      formatSafetyDetail: () => {
        throw new Error("presenter must not run");
      },
    };
    expect(await sweepWorktrees(options)).toEqual(original);
    expect(original[0]?.status).toBe(state);
    retained(f);
  });
  it("rejects a throwing presenter and preserves owned work", async () => {
    const f = fixture();
    change(f, "dirty");
    const error = new Error("owned presenter failure");
    const options = {
      ...f.options,
      formatSafetyDetail: () => {
        throw error;
      },
    };
    await expect(sweepWorktrees(options)).rejects.toBe(error);
    expect(fs.readFileSync(path.join(f.worktree, "scratch.txt"), "utf8")).toBe("owned scratch\n");
    retained(f);
  });
  it("rejects a nonstring presenter result with TypeError and preserves owned work", async () => {
    const f = fixture();
    change(f, "dirty");
    const options: SweepOptions = {
      ...f.options,
      // @ts-expect-error Runtime boundary deliberately supplies an invalid presenter result.
      formatSafetyDetail: () => 42,
    };
    await expect(sweepWorktrees(options)).rejects.toBeInstanceOf(TypeError);
    retained(f);
  });
  it("leaves default combined diagnostics exact when no presenter is supplied", async () => {
    const f = fixture();
    change(f, "both");
    expect(await sweepWorktrees(f.options)).toEqual([
      {
        gitRoot: f.repo,
        worktree: f.worktree,
        branch: f.branch,
        status: "holds-work",
        detail: `uncommitted or untracked changes in ${f.worktree} and commits that exist nowhere else`,
      },
    ]);
    retained(f);
  });
});
