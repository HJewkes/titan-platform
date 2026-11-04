import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedRepo } from "@titan-design/test-kit/git";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { checkoutGit, draftPlanRound, type PlanRoundArgs, type PlanRoundPorts } from "../cli-shepherd-plan-round.js";
import { runCli } from "../cli.js";
import { PlanApprovalActionSchema } from "../console-action/record.js";
import { blobOf, NOTHING_PREDICTED, pinFiles, PlanBlockSchema, planRound, PlanRoundRefused, predictGates, readPlanBlock, type GitRead, type PlanBlock } from "./plan-round.js";

const plan = (fields: Partial<PlanBlock> & Pick<PlanBlock, "files">): PlanBlock => PlanBlockSchema.parse({ task: "demo/TP-1", repo: "octo/planned", summary: "Add a merge-lint entry", ...fields });
const noGit: GitRead = { show: async () => null, blob: async () => null, commit: async (ref) => ref, diffNames: async () => [] };
const ARGS: PlanRoundArgs = { round: 1, supersedes: [], base: "origin/main" };
const PrintedBindings = z.object({ planApprovals: z.array(z.object({ task: z.string(), repo: z.string(), gate: z.string(), scope: z.unknown() })) });

const tmp: string[] = [];
afterEach(() => tmp.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "plan-round-"));
  tmp.push(dir);
  return dir;
};

function drafting(text: string, visualPaths?: readonly string[]) {
  const out = { stdout: "", stderr: "" };
  const ports: PlanRoundPorts = {
    io: { stdout: (t) => void (out.stdout += t), stderr: (t) => void (out.stderr += t), env: {} },
    readPlan: async () => text,
    git: () => noGit,
    visualPaths: () => visualPaths,
  };
  return { out, run: () => draftPlanRound("plan.md", ARGS, ports) };
}

describe("pinning a planned file's bytes", () => {
  it("pins the git blob sha of the UTF-8 bytes, as git hash-object does", () => {
    const files = pinFiles(plan({ files: [{ path: "a", content: "hello\n" }, { path: "b", content: "é\n" }] }));

    expect(files).toEqual([
      { path: "a", blob: "ce013625030ba8dba906f756967f9e9ca394464a" },
      { path: "b", blob: "c6003325155f475bd7c87731607525dce73be9cf" },
    ]);
    expect(blobOf(Buffer.from(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("pins an absent file as null", () => {
    expect(pinFiles(plan({ files: [{ path: ".github/old.yml", absent: true }] }))).toEqual([{ path: ".github/old.yml", blob: null }]);
  });
});

describe("predicting the ci-policy gate", () => {
  it("refuses a .github/ plan that names no ciPolicyKeys, naming the keys", () => {
    const refusal = () => predictGates(plan({ files: [{ path: ".github/merge-lint.json", content: "{}\n" }] }), undefined);

    expect(refusal).toThrow(PlanRoundRefused);
    expect(refusal).toThrow(/required-check, permissions, pull_request_target, secrets, ruleset, other, or \[\] when it weakens none/);
  });

  it("asks nothing for a .github/ plan whose ciPolicyKeys are empty", () => {
    expect(predictGates(plan({ files: [{ path: ".github/merge-lint.json", content: "{}\n" }], ciPolicyKeys: [] }), undefined)).toEqual({ notes: [] });
  });

  it("refuses a policy plan with a file it gives no content for", () => {
    const files = [{ path: ".github/merge-lint.json", content: "{}\n" }, { path: "src/code.ts" }];

    expect(() => predictGates(plan({ files, ciPolicyKeys: ["other"] }), undefined)).toThrow(/src\/code\.ts has no content or absent; split the policy edit into its own PR/);
  });

  it("refuses a policy plan of 21 pinned files", () => {
    const files = Array.from({ length: 21 }, (_, i) => ({ path: `.github/f${i}.yml`, content: `${i}\n` }));

    expect(() => predictGates(plan({ files, ciPolicyKeys: ["other"] }), undefined)).toThrow(/at most 20 files, and the plan lists 21/);
  });

  it("binds a weakening outside .github/ when the plan sets ciPolicy", () => {
    const predicted = predictGates(plan({ files: [{ path: "package.json", content: "{}\n" }], ciPolicyKeys: ["required-check"], ciPolicy: true }), undefined);

    expect(predicted.ciPolicy).toEqual({ ciPolicyKeys: ["required-check"], files: [{ path: "package.json", blob: blobOf(Buffer.from("{}\n")) }] });
  });
});

describe("predicting the skill and visual gates", () => {
  it("names exactly the skill paths, case folded as the guard folds them", () => {
    const files = [{ path: ".claude/skills/a/SKILL.md" }, { path: ".Claude/Skills/b/x.md" }, { path: "src/z.ts" }];

    expect(predictGates(plan({ files }), undefined).skill).toEqual([".claude/skills/a/SKILL.md", ".Claude/Skills/b/x.md"]);
  });

  it("names a rendering file under the seat's visual paths, and not its test or readme", () => {
    const files = [{ path: "packages/ui/src/Button.tsx" }, { path: "packages/ui/src/Button.test.tsx" }, { path: "packages/ui/README.md" }];

    expect(predictGates(plan({ files }), ["packages/ui/**"]).visual).toEqual(["packages/ui/src/Button.tsx"]);
    expect(predictGates(plan({ files }), undefined).visual).toBeUndefined();
  });
});

describe("reading the plan block", () => {
  const block = JSON.stringify({ task: "demo/TP-1", repo: "octo/planned", summary: "s", files: [{ path: "src/a.ts" }] });
  const fenced = (n: number) => `# Plan\n\n${Array.from({ length: n }, () => `\`\`\`plan-round\n${block}\n\`\`\`\n`).join("\ntext\n")}`;

  it("parses exactly one plan-round fence and refuses zero or two", () => {
    expect(readPlanBlock(fenced(1)).files).toEqual([{ path: "src/a.ts" }]);
    expect(() => readPlanBlock(fenced(0))).toThrow(/holds 0 ```plan-round fences/);
    expect(() => readPlanBlock(fenced(2))).toThrow(/holds 2 ```plan-round fences/);
  });

  it("reads a bare JSON plan and refuses an unknown ciPolicyKeys entry", () => {
    expect(readPlanBlock(block).task).toBe("demo/TP-1");
    expect(() => readPlanBlock(JSON.stringify({ ...JSON.parse(block), ciPolicyKeys: ["loosened"] }))).toThrow(PlanRoundRefused);
  });
});

describe("drafting the round", () => {
  it("prints nothing and exits 0 with one stderr line when no gate is predicted", async () => {
    const { out, run } = drafting(JSON.stringify(plan({ files: [{ path: "src/a.ts" }] })));

    expect(await run()).toBe(0);
    expect(out).toEqual({ stdout: "", stderr: `note: ${NOTHING_PREDICTED}\n` });
  });

  it("notes the authority table on stderr and binds nothing for it", async () => {
    const { out, run } = drafting(JSON.stringify(plan({ files: [{ path: "packages/authority/src/table.json" }, { path: ".claude/skills/a/SKILL.md" }] })));

    expect(await run()).toBe(0);
    expect(out.stderr).toMatch(/^note: no plan approval covers the authority table yet/);
    expect(JSON.parse(out.stdout).planApprovals.map((each: { gate: string }) => each.gate)).toEqual(["skill"]);
  });

  it("exits 65 and prints no round when the plan is refused", async () => {
    const { out, run } = drafting(JSON.stringify(plan({ files: [{ path: ".github/x.yml", content: "a\n" }] })));

    expect(await run()).toBe(65);
    expect(out.stdout).toBe("");
  });

  it("prints bindings that each parse as the factory's plan-approval record once a round id is set", async () => {
    const files = [{ path: ".github/merge-lint.json", content: '{ "allow": ["a", "b"] }\n' }, { path: ".claude/skills/a/SKILL.md", content: "x\n" }, { path: "packages/ui/Card.tsx", content: "y\n" }];
    const { out, run } = drafting(JSON.stringify(plan({ files, ciPolicyKeys: ["other"] })), ["packages/ui/**"]);

    expect(await run()).toBe(0);
    const bindings = PrintedBindings.parse(JSON.parse(out.stdout)).planApprovals;
    expect(bindings.map((each) => each.gate)).toEqual(["ci-policy", "skill", "visual"]);
    for (const { task, repo, gate, scope } of bindings) expect(PlanApprovalActionSchema.safeParse({ kind: "plan-approval", task, repo, round: "plan-demo-tp-1-r1", gate, scope }).success).toBe(true);
  });

  it("shows the owner each pinned file's changed lines against the base", async () => {
    const git: GitRead = { ...noGit, show: async (ref, path) => (ref === "origin/main" && path === ".github/merge-lint.json" ? '{ "allow": ["a"] }\n' : null) };
    const files = [{ path: ".github/merge-lint.json", content: '{ "allow": ["a", "b"] }\n' }];

    const { round } = await planRound(plan({ files, ciPolicyKeys: ["other"] }), { round: 2, base: "origin/main", supersedes: ["plan-demo-tp-1-r1"] }, git);

    expect(round?.sections?.[0]?.context).toBe('Weakens: other.\n.github/merge-lint.json:\n- L1: { "allow": ["a"] }\n+ L1: { "allow": ["a", "b"] }');
    expect(round).toMatchObject({ unit: "plan-demo-tp-1", round: 2, supersedes: ["plan-demo-tp-1-r1"] });
  });
});

describe("reading the base in a checkout", () => {
  it("shows a file at a ref, reads a path the ref lacks as null, and refuses a ref that is no commit", async () => {
    const dir = tempDir();
    seedRepo(dir, { "kept.yml": "on: push\n" });
    const read = checkoutGit(dir);

    expect(await read.show("HEAD", "kept.yml")).toBe("on: push\n");
    expect(await read.show("HEAD", "gone.yml")).toBeNull();
    await expect(read.show("no-such-ref", "kept.yml")).rejects.toThrow(/no-such-ref is not a commit/);
  });

  it("drafts through the titan-factory CLI from a plan file", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "plan.json"), JSON.stringify(plan({ files: [{ path: ".claude/skills/a/SKILL.md" }] })));
    let stdout = "";

    const code = await runCli(["shepherd", "plan-round", join(dir, "plan.json"), "--checkout", dir], { stdout: (t) => void (stdout += t), stderr: () => undefined, env: { XDG_CONFIG_HOME: dir } });

    expect(code).toBe(0);
    expect(JSON.parse(stdout).planApprovals).toEqual([expect.objectContaining({ gate: "skill", scope: { paths: [".claude/skills/a/SKILL.md"] } })]);
  });
});
