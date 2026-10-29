import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { blobOf, PlanBlockSchema, type PlanBlock } from "./plan-round.js";

const LINT = ".github/merge-lint.json";
const PLANNED = '{ "allow": ["a", "b"] }\n';
const short = (content: string): string => blobOf(Buffer.from(content)).slice(0, 12);

const tmp: string[] = [];
afterEach(() => tmp.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "plan-round-verify-"));
  tmp.push(dir);
  return dir;
};

const git = (dir: string, ...args: string[]): string => gitIn(dir)(...args);

/** A checkout whose `main` holds `base`; `head` then commits each change (null deletes) on a `pr` branch, as the PR's head. */
function checkout(base: Record<string, string>) {
  const dir = tempDir();
  seedRepo(dir, {});
  const write = (files: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) git(dir, "rm", "-q", path);
      else {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
        git(dir, "add", path);
      }
    }
    git(dir, "commit", "-q", "--allow-empty", "-m", "change");
    return git(dir, "rev-parse", "HEAD");
  };
  withHistory(dir, [{ files: base, message: "change" }]);
  git(dir, "switch", "-q", "-c", "pr");
  return { dir, head: write, rename: (from: string, to: string) => (git(dir, "mv", from, to), write({})) };
}

const plan = (fields: Pick<PlanBlock, "files"> & Partial<PlanBlock>): PlanBlock => PlanBlockSchema.parse({ task: "demo/TP-1", repo: "octo/planned", summary: "Allow b in merge-lint", ...fields });
const policyPlan = plan({ files: [{ path: LINT, content: PLANNED }, { path: ".github/old.yml", absent: true }], ciPolicyKeys: ["other"] });

async function planRoundCli(dir: string, block: PlanBlock, ...args: string[]) {
  const planFile = join(tempDir(), "plan.json");
  writeFileSync(planFile, JSON.stringify(block));
  const out = { stdout: "", stderr: "" };
  const io = { stdout: (t: string) => void (out.stdout += t), stderr: (t: string) => void (out.stderr += t), env: { XDG_CONFIG_HOME: dir } };
  const code = await runCli(["shepherd", "plan-round", planFile, "--checkout", dir, "--base", "main", ...args], io);
  return { code, ...out };
}

describe("verifying a head against its plan", () => {
  it("passes a head that changes only planned paths, each at its pinned blob", async () => {
    const repo = checkout({ [LINT]: '{ "allow": ["a"] }\n', ".github/old.yml": "on: push\n" });
    repo.head({ [LINT]: PLANNED, ".github/old.yml": null });

    const result = await planRoundCli(repo.dir, policyPlan, "--verify", "HEAD");

    expect(result).toMatchObject({ code: 0, stderr: "" });
  });

  it("fails a pinned file whose bytes drifted, naming both blobs and the re-ask", async () => {
    const repo = checkout({ [LINT]: '{ "allow": ["a"] }\n', ".github/old.yml": "on: push\n" });
    const head = repo.head({ [LINT]: '{ "allow": ["a", "c"] }\n' });

    const result = await planRoundCli(repo.dir, policyPlan, "--verify", "HEAD");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`drift: ${LINT} is pinned at ${short(PLANNED)} but is ${short('{ "allow": ["a", "c"] }\n')} at HEAD`);
    expect(result.stderr).toContain(`.github/old.yml is pinned absent but is ${short("on: push\n")} at HEAD`);
    expect(result.stderr).toContain(`--pin-from ${head} --round <n+1> --supersedes plan-demo-tp-1-r<n>`);
  });

  it("fails a changed path the plan does not list, a rename's source included", async () => {
    const repo = checkout({ "src/old.ts": "export const kept = 1;\n" });
    repo.rename("src/old.ts", "src/new.ts");

    const result = await planRoundCli(repo.dir, plan({ files: [{ path: "src/new.ts" }] }), "--verify", "HEAD");

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^drift: unplanned path src\/old\.ts: HEAD changes it and the plan does not list it; re-ask: /);
  });

  it("lets a skill-only plan's skill file change content, and fails a new skill path", async () => {
    const skill = ".claude/skills/a/SKILL.md";
    const repo = checkout({ [skill]: "base\n" });
    const skillPlan = plan({ files: [{ path: skill, content: "planned\n" }] });
    repo.head({ [skill]: "rewritten\n" });

    expect((await planRoundCli(repo.dir, skillPlan, "--verify", "HEAD")).code).toBe(0);

    repo.head({ ".claude/skills/b/SKILL.md": "new\n" });
    const result = await planRoundCli(repo.dir, skillPlan, "--verify", "HEAD");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unplanned path .claude/skills/b/SKILL.md");
  });
});

describe("re-asking with --pin-from", () => {
  const unpinned = plan({ files: [{ path: LINT }, { path: ".github/gone.yml" }], ciPolicyKeys: ["other"] });

  it("pins each file to its blob at the ref, null where the ref lacks it, and refuses inline content", async () => {
    const repo = checkout({ [LINT]: '{ "allow": ["a"] }\n' });
    const head = repo.head({ [LINT]: '{ "allow": ["a", "c"] }\n' });

    const result = await planRoundCli(repo.dir, unpinned, "--pin-from", head);

    expect(result.code).toBe(0);
    const files = [{ path: LINT, blob: git(repo.dir, "rev-parse", `${head}:${LINT}`) }, { path: ".github/gone.yml", blob: null }];
    expect(JSON.parse(result.stdout).planApprovals[0].scope).toEqual({ ciPolicyKeys: ["other"], files });
    const refused = await planRoundCli(repo.dir, policyPlan, "--pin-from", head);
    expect(refused).toMatchObject({ code: 65, stdout: "" });
    expect(refused.stderr).toContain(`${LINT}, .github/old.yml also gives content or absent inline`);
  });

  it("prints the re-ask's round number and the round it supersedes", async () => {
    const repo = checkout({ [LINT]: '{ "allow": ["a"] }\n' });
    const head = repo.head({ [LINT]: PLANNED });

    const result = await planRoundCli(repo.dir, unpinned, "--pin-from", head, "--round", "2", "--supersedes", "plan-demo-tp-1-r1");

    expect(JSON.parse(result.stdout)).toMatchObject({ unit: "plan-demo-tp-1", round: 2, supersedes: ["plan-demo-tp-1-r1"] });
    expect((await planRoundCli(repo.dir, unpinned, "--pin-from", head, "--verify", "HEAD")).code).toBe(64);
  });
});
