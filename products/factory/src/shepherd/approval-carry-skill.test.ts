import { fakeSha } from "@titan-design/github";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { followingApprovals } from "./approval-carry.js";
import type { FixCarryResult } from "./fix-carry.js";
import type { OwnMergeUpResult } from "./own-merge-up.js";
import type { RemergeResult } from "./remerge-carry.js";

const REPO = "acme/widgets";
const APPROVED = fakeSha("approved");
const LATER = fakeSha("later");
const SKILL = ".claude/skills/x/SKILL.md";
const EMPTY: RemergeResult = { carries: true, rule: "remerge-empty", headTree: "t", remergeTree: "t", paths: [], generatedPaths: [] };
const RESOLVED: RemergeResult = { carries: false, paths: ["src/a.ts"], generatedPaths: [], reason: "the merge changed 1 path(s) outside the declared generated files" };
const smallFix = (paths: string[]): FixCarryResult => ({ carries: true, rule: "small-fix", base: "b", headTree: "h", mergeTree: "m", changedLines: 4, paths });

const landPrompt = (head: string, table = "authority", row = "MRG-AU"): string =>
  `Merge PR #1 in ${REPO} at head ${head}? CI is green. Policy ${table}/${row}: the authority policy did not allow an automated merge`;

const StepInput = z.record(z.string(), z.unknown());

interface CarryRig {
  ask: WorkflowContext["assisted"];
  /** Heads the owner was asked about. */
  gates: string[];
}

function rig(probes: { kind?: string; remerge?: RemergeResult; fix?: FixCarryResult; own?: OwnMergeUpResult }): CarryRig {
  const gates: string[] = [];
  const respond = (stepId: string, input: Record<string, unknown>): object => {
    if (stepId.startsWith("sh-carry-scope:")) return { kind: probes.kind ?? "correctness", baseRef: "main" };
    if (stepId.startsWith("sh-remerge:")) return probes.remerge ?? RESOLVED;
    if (stepId.startsWith("sh-approval-carry:fix:")) return probes.fix ?? { carries: false, reason: "refused" };
    if (stepId.startsWith("sh-approval-carry:own:")) return probes.own ?? { carries: false, reason: "refused" };
    return input;
  };
  async function dispatch<T extends Record<string, unknown>>(stepId: string, _template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    const input = StepInput.parse(JSON.parse(Object.values(options.vars ?? {})[0] ?? "{}"));
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options.schema?.parse({ result: respond(stepId, input) }) };
  }
  const ctx = partialFake<WorkflowContext>({ runId: "run-1", dispatch });
  const owner: WorkflowContext["assisted"] = async (_stepId, prompt) => {
    const head = /at head ([0-9a-f]{40})/.exec(prompt)?.[1] ?? "";
    gates.push(head);
    return { stepId: "approve-merge", iteration: 0, agentId: null, signal: null, completedAt: "", data: { decision: "merge", headSha: head } } satisfies StepResult;
  };
  return { ask: followingApprovals(ctx, owner, { target: { repo: REPO, pr: 1 }, reviewedMerge: () => true }), gates };
}

describe("an owner merge approval meeting a repo skill change", () => {
  it("asks the owner again at a skill-path gate, even when the head is an empty-remerge merge-up", async () => {
    const r = rig({ remerge: EMPTY });

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(LATER, "shepherd-merge-guard", "skill-path"));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("asks the owner again when the small fix it would follow changes a repo skill", async () => {
    const r = rig({ fix: smallFix(["src/a.ts", SKILL]) });

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(LATER));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("asks the owner again when the merge-up it would follow changed a repo skill, under any spelling", async () => {
    const r = rig({ remerge: { ...EMPTY, rule: "remerge-generated-only", paths: [".Claude/Skills/x.md"], generatedPaths: [".Claude/Skills/x.md"] } });

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(LATER));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("asks a security run's owner again when the PR's own paths hold a repo skill", async () => {
    const own: OwnMergeUpResult = { carries: true, rule: "own-merge-up", base: "b", headTree: "t", mergeTree: "t", prPaths: [SKILL], mainPaths: ["other.txt"] };
    const r = rig({ kind: "security", own });

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(LATER));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("asks the owner again when the merge-up proof names no paths, rather than reading the gap as skill-free", async () => {
    const r = rig({ remerge: { carries: true, rule: "remerge-empty", headTree: "t", remergeTree: "t", generatedPaths: [] } });

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(LATER));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("asks a security run's owner again when the own merge-up proof names no PR paths", async () => {
    const own: OwnMergeUpResult = { carries: true, rule: "own-merge-up", base: "b", headTree: "t", mergeTree: "t", mainPaths: ["other.txt"] };
    const r = rig({ kind: "security", own });

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(LATER));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("still follows a skill-free small fix without asking the owner", async () => {
    const r = rig({ fix: smallFix(["src/a.ts", "docs/skills/x.md"]) });

    await r.ask("approve-merge", landPrompt(APPROVED));
    const answer = await r.ask("approve-merge:1", landPrompt(LATER));

    expect(answer.data).toEqual({ decision: "merge", headSha: LATER });
    expect(r.gates).toEqual([APPROVED]);
  });
});
