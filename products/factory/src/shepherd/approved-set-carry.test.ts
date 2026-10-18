import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSha } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import type { ApprovedSet } from "../approved-set.js";
import { followingApprovals } from "./approval-carry.js";
import { setCarry } from "./approved-set-carry.js";
import type { VisualSetCarry } from "./phases.js";
import type { Git } from "./tree-carry.js";

const REPO = "acme/widgets";
const H1 = fakeSha("red");
const H2 = fakeSha("set-committed");
const H3 = fakeSha("merged-up");
const BASELINE = "packages/ui/specimen/baseline/";
const SET: ApprovedSet = {
  ...{ packetSha: "e".repeat(64), packetId: "p-1", ciRunId: "9001", fromHead: H1, sidePaths: [] },
  files: [{ path: `${BASELINE}a.png`, key: "k1", sha256: "f".repeat(64), blob: "a".repeat(40) }],
  removed: [`${BASELINE}gone.png`],
};

/** What the fake git holds at a head: whether `H1` is its ancestor, `diff H1..head`, and each path's blob. */
type HeadTree = { ancestor?: boolean; changed?: string[]; tree?: Record<string, string>; mode?: string };
const EXACT: HeadTree = { changed: [`${BASELINE}a.png`, `${BASELINE}gone.png`], tree: { [`${BASELINE}a.png`]: "a".repeat(40) } };

function fakeGit(heads: Record<string, HeadTree>, calls: string[][]): Git {
  return async (_dir, args) => {
    calls.push([...args]);
    const at = heads[args.at(-1) ?? ""] ?? heads[String(args[2])] ?? {};
    if (args[0] === "merge-base") return { code: at.ancestor === false ? 1 : 0, stdout: "", stderr: "" };
    if (args[0] === "diff-tree") return { code: 0, stdout: (at.changed ?? []).map((path) => `${path}\0`).join(""), stderr: "" };
    if (args[0] !== "ls-tree") return { code: 0, stdout: "", stderr: "" };
    const listed = args.slice(4).flatMap((path) => (at.tree?.[path] ? [`${at.mode ?? "100644"} blob ${at.tree[path]}\t${path}\0`] : []));
    return { code: 0, stdout: listed.join(""), stderr: "" };
  };
}

interface RigOptions {
  heads?: Record<string, HeadTree>;
  mode?: VisualSetCarry;
  /** No set was accepted at the red head. */
  noSet?: boolean;
  visual?: boolean;
  /** Heads whose review is a MERGE; every head by default. */
  reviewed?: (head: string) => boolean;
  /** The owner's decision at each gate; merge by default. */
  decide?: (head: string) => string;
  /** The base the red head's CI read was judged on; null when the read recorded none. */
  base?: string | null;
  /** The run's kind lets an owner's answer follow a merge-up; true by default. */
  follows?: boolean;
  /** Recorded steps a replay returns in order, never reaching git. */
  journal?: { stepId: string; result: object }[];
}

function rig({ heads = { [H2]: EXACT }, mode = "on", noSet = false, visual = true, reviewed = () => true, decide = () => "merge", base = "main", follows = true, journal }: RigOptions = {}) {
  const gates: string[] = [];
  const steps: string[] = [];
  const results = new Map<string, unknown>();
  const calls: string[][] = [];
  const modeReads: string[] = [];
  let accepted: { set: ApprovedSet; base: string | undefined } | undefined = noSet ? undefined : { set: SET, base: base ?? undefined };
  const stateDir = mkdtempSync(join(tmpdir(), "set-carry-"));
  const respond = async (stepId: string, input: unknown): Promise<unknown> => {
    if (journal) return journal.find((recorded) => recorded.stepId === stepId)?.result;
    if (stepId.startsWith("sh-carry-scope:")) return { kind: follows ? "correctness" : null, baseRef: "main" };
    if (stepId.startsWith("sh-remerge:")) return { carries: true, rule: "remerge-empty", headTree: "t", remergeTree: "t", paths: [], generatedPaths: [] };
    if (!stepId.startsWith("sh-approval-carry:set:")) return input;
    results.set(stepId, await setCarry(input, { stateDir, git: fakeGit(heads, calls), remote: () => "file:///none" }));
    return results.get(stepId);
  };
  async function dispatch<T extends Record<string, unknown>>(stepId: string, _template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    steps.push(stepId);
    const result = await respond(stepId, JSON.parse(Object.values(options.vars ?? {})[0] ?? "{}"));
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options.schema?.parse({ result }) };
  }
  const historyNext = () => (journal ? journal.find((recorded) => !steps.includes(recorded.stepId))?.stepId : undefined);
  const ctx = partialFake<WorkflowContext>({ runId: "run-1", dispatch, historyNext, recoveredInFlight: () => [], resumedGate: () => undefined });
  const owner: WorkflowContext["assisted"] = async (_stepId, prompt) => {
    const head = /at head ([0-9a-f]{40})/.exec(prompt)?.[1] ?? "";
    gates.push(head);
    return { stepId: "approve-merge", iteration: 0, agentId: null, signal: null, completedAt: "", data: { decision: decide(head), headSha: head } } satisfies StepResult;
  };
  const ask = followingApprovals(ctx, owner, {
    ...{ target: { repo: REPO, pr: 1 }, reviewedMerge: reviewed, isVisual: () => visual },
    ...{ acceptedSet: () => accepted, spendSet: () => (accepted = undefined), setMode: () => (modeReads.push(mode), mode) },
  });
  return { ask, gates, steps, results, calls, modeReads };
}

const gate = (head: string, row = "visual-path:packages/ui", into = " into main"): string =>
  `Merge PR #1 in ${REPO} at head ${head}${into}? CI is green. Policy shepherd-merge-guard/${row}: a visual path changed`;

describe("a later head that commits exactly the accepted set", () => {
  it("answers its visual gate merge by code under on, with the set's proof recorded", async () => {
    const r = rig();

    const answer = await r.ask("approve-merge", gate(H2));

    expect(answer).toMatchObject({ stepId: `sh-approval-carry:set:${H2}`, data: { decision: "merge", headSha: H2 } });
    expect(r.gates).toEqual([]);
  });

  it.each<[string, HeadTree]>([
    ["an extra source path", { ...EXACT, changed: [...EXACT.changed!, "src/x.ts"] }],
    ["an extra png outside the set", { ...EXACT, changed: [...EXACT.changed!, `${BASELINE}other.png`] }],
    ["a set file missing", { ...EXACT, tree: {} }],
    ["a set file at another blob", { ...EXACT, tree: { [`${BASELINE}a.png`]: "b".repeat(40) } }],
    ["a removed path still present", { ...EXACT, tree: { ...EXACT.tree, [`${BASELINE}gone.png`]: "c".repeat(40) } }],
    ["a head that is no descendant of the red head", { ...EXACT, ancestor: false }],
    ["a skill path", { ...EXACT, changed: [...EXACT.changed!, ".claude/skills/x/SKILL.md"] }],
    ["a set file whose mode flipped to 100755", { ...EXACT, mode: "100755" }],
    ["a head whose diff names no set file, though its blobs match", { ...EXACT, changed: [] }],
  ])("asks the owner for %s", async (_name, head) => {
    const r = rig({ heads: { [H2]: head } });

    await r.ask("approve-merge", gate(H2));

    expect(r.steps).toContain(`sh-approval-carry:set:${H2}`);
    expect(r.gates).toEqual([H2]);
  });

  it.each<[string, RigOptions, string]>([
    ["a gate that is not visual", { visual: false }, gate(H2)],
    ["a head without a reviewer MERGE", { reviewed: () => false }, gate(H2)],
    ["a skill-path gate", {}, gate(H2, "skill-path")],
    ["a gate that names no base", {}, gate(H2, "visual-path:packages/ui", "")],
    ["a gate into another base than the red head was judged on", { base: "release" }, gate(H2)],
    ["a set whose red head's read recorded no base", { base: null }, gate(H2)],
  ])("passes %s through to the owner without a set step", async (_name, options, prompt) => {
    const r = rig(options);

    await r.ask("approve-merge", prompt);

    expect(r.steps).toEqual([]);
    expect(r.gates).toEqual([H2]);
  });

  it("records a would-carry under shadow and still asks", async () => {
    const r = rig({ mode: "shadow" });

    await r.ask("approve-merge", gate(H2));

    const recorded = r.results.get(`sh-approval-carry:set:${H2}`);
    expect(recorded).toMatchObject({ carries: true, mode: "shadow", rule: "approved-set", proof: { packetSha: SET.packetSha, ciRunId: "9001" } });
    expect(recorded).not.toHaveProperty("decision");
    expect(r.gates).toEqual([H2]);
  });

  it("spends a used set, so a later visual gate that would match asks", async () => {
    const r = rig({ heads: { [H2]: EXACT, [H3]: EXACT }, follows: false });

    await r.ask("approve-merge", gate(H2));
    await r.ask("approve-merge:1", gate(H3));

    expect(r.gates).toEqual([H3]);
    expect(r.steps.filter((id) => id.startsWith("sh-approval-carry:set:"))).toEqual([`sh-approval-carry:set:${H2}`]);
  });

  it.each(["send-back", "merge"])("spends the set when the owner answers %s at a visual gate, so a later matching head asks", async (decision) => {
    const r = rig({ heads: { [H2]: EXACT, [H3]: EXACT }, reviewed: (head) => head === H3, decide: (head) => (head === H2 ? decision : "merge"), follows: false });

    await r.ask("approve-merge", gate(H2));
    await r.ask("approve-merge:1", gate(H3));

    expect(r.gates).toEqual([H2, H3]);
    expect(r.steps.filter((id) => id.startsWith("sh-approval-carry:set:"))).toEqual([]);
  });

  it("lets a set-carried approval follow no merge-up head before S8", async () => {
    const r = rig();

    await r.ask("approve-merge", gate(H2));
    await r.ask("approve-merge:1", gate(H3));

    expect(r.gates).toEqual([H3]);
  });

  it("replays the recorded step without git and without reading the flag", async () => {
    const recorded = { carries: true, mode: "on", decision: "merge", headSha: H2 };
    const r = rig({ mode: "off", journal: [{ stepId: `sh-approval-carry:set:${H2}`, result: recorded }] });

    const answer = await r.ask("approve-merge", gate(H2));

    expect(answer.data).toEqual({ decision: "merge", headSha: H2 });
    expect(r.calls).toEqual([]);
    expect(r.modeReads).toEqual([]);
  });

  it("emits no step under off, so the journal equals a run with no set", async () => {
    const off = rig({ mode: "off" });
    const none = rig({ noSet: true });

    for (const r of [off, none]) await r.ask("approve-merge", gate(H2));

    expect(off.steps).toEqual(none.steps);
    expect(off.steps).toEqual([]);
    expect(off.gates).toEqual([H2]);
  });
});
