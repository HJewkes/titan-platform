import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Bounds } from "../bounds.js";
import type { Digest } from "../digest.js";
import type { ArPorts, RatchetRequest } from "../ports.js";
import { execGit, ratchetFastForward } from "../ratchet.js";
import { ArMicroSchema, ArResultSchema, type Idea, type Proposal, type QueueOps, type Target } from "../schemas.js";

const run = promisify(execFile);
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const IDENTITY = ["-c", "user.name=autoresearch fixture", "-c", "user.email=fixture@example.invalid"];

interface Mechanism {
  cc?: number;
  cc_by_key?: Record<string, number>;
  hidden?: number;
  hidden_by_key?: Record<string, number>;
  micro?: boolean;
  l0?: string;
  single_caller?: number;
  noop?: boolean;
  gate_fail?: boolean;
}

export interface Policy {
  sigma: number;
  base_cc: number;
  accepted_tasks: number;
  mechanisms: Record<string, Mechanism>;
}

/** A synthetic target repo: a bare `origin` and one checkout that serves as the integration tree. */
export interface FixtureRepo {
  root: string;
  bare: string;
  work: string;
  policyPath: string;
  pin: string;
}

export const git = (cwd: string, ...args: string[]) => execGit([...IDENTITY, ...args], cwd);

export async function fixtureRepo(policy: Policy): Promise<FixtureRepo> {
  const root = mkdtempSync(join(tmpdir(), "ar-fixture-"));
  const bare = join(root, "origin.git");
  const work = join(root, "work");
  mkdirSync(work);
  await git(work, "init", "--quiet", "-b", "main");
  writeFileSync(join(work, "applied.txt"), "");
  writeFileSync(join(work, "policy.json"), JSON.stringify(policy, null, 2));
  await git(work, "add", ".");
  await git(work, "commit", "--quiet", "-m", "fixture");
  await git(root, "clone", "--quiet", "--bare", work, bare);
  await git(work, "remote", "add", "origin", bare);
  await git(work, "fetch", "--quiet", "origin");
  return { root, bare, work, policyPath: join(work, "policy.json"), pin: await git(work, "rev-parse", "HEAD") };
}

export const removeFixture = (repo: FixtureRepo) => rmSync(repo.root, { recursive: true, force: true });

const FIXTURE_TARGET: Target = {
  schema: "ar-target/v1",
  ratchetPrefix: "autoresearch/fixture",
  metric: { direction: "min", guards: { single_caller_delta: 1 }, noise: { bandSigmas: 2, lockAfterPairs: 5, minPairs: 3, defaultBandPp: 1.5 } },
  microRung: { "accept-gate": "L1-replay", "planner-ranking": "L1-cluster" },
  phases: [{ id: "p1", train: ["t-alpha"], baselineRuns: 6, stop: { ideasEvaluated: 16, roundsWithoutGain: 3 } }],
};

export const FIXTURE_BOUNDS: Bounds = {
  schema: "ar-bounds/v1",
  classes: {
    "accept-gate": { paths: ["src/gate/*.py"], tests: ["tests/test_gate*.py"] },
    "planner-ranking": { paths: ["src/planner/{rank,recipes}.py"], tests: ["tests/test_planner*.py"] },
    "config-param": { paths: ["src/config.json"], tests: [], params: { hot_cc: [6, 15], "p5.*": [0, 0.2] } },
  },
};

export function proposal(mechanism: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    hypothesis: `${mechanism} lowers tree CC`,
    mechanism,
    class: "accept-gate",
    direction: mechanism,
    targets: ["src/gate/gates.py"],
    expectedEffect: { metric: "cc_total_delta_pct", direction: "down", microSignal: "fewer accepts" },
    testPlan: "assert the new accept decision",
    bold: false,
    priority: 0,
    source: "planner",
    evidence: [],
    ...overrides,
  };
}

/** Round one adds `mechanisms` (the first is the bold one); later rounds add nothing and exempt the quotas. */
export function scriptedPlanner(mechanisms: readonly string[]): (input: { round: number }) => Partial<QueueOps> {
  return ({ round }) =>
    round === 1
      ? { add: mechanisms.map((mechanism, index) => proposal(mechanism, { bold: index === 0 })) }
      : { exempt: { bold: "script ends after round one", followup: "script ends after round one" } };
}

interface FakeCalls {
  plans: { round: number; violations: string[]; digest: Digest }[];
  implement: string[];
  evals: { ideaId: string | null; key: string }[];
  micro: string[];
  ratchet: RatchetRequest[];
  released: string[];
}

export interface FakeOptions {
  planner: (input: { round: number; violations: string[]; digest: Digest }) => Partial<QueueOps>;
  target?: Target;
  /** Awaited before an implement or an eval runs: tests hold a lane open or simulate a kill with it. */
  beforeImplement?: (idea: Idea, call: number) => Promise<void>;
  beforeEval?: (ideaId: string | null, key: string) => Promise<void>;
}

export type FakeArPorts = ArPorts & { calls: FakeCalls };

async function script(name: string, args: string[]): Promise<unknown> {
  return JSON.parse((await run("bash", [join(FIXTURES, name), ...args])).stdout);
}

function treePorts(repo: FixtureRepo, calls: FakeCalls, ideaOfTree: Map<string, string>, options: FakeOptions) {
  return {
    async allocTree({ runId, ideaId, base }: { runId: string; ideaId: string; base: string }) {
      const tree = join(repo.root, "trees", `${ideaId}-${ideaOfTree.size}`);
      const branch = `ar-idea/${runId}/${ideaId}`;
      await git(repo.work, "worktree", "add", "--quiet", "-B", branch, tree, base);
      ideaOfTree.set(tree, ideaId);
      return { tree, branch };
    },
    async implement({ idea, tree }: { idea: Idea; tree: string }) {
      calls.implement.push(idea.id);
      await options.beforeImplement?.(idea, calls.implement.length);
      appendFileSync(join(tree, "applied.txt"), `${idea.mechanism}\n`);
      await git(tree, "commit", "--quiet", "-am", `apply ${idea.mechanism}`);
      return { head: await git(tree, "rev-parse", "HEAD"), usd: 0, lesson: `${idea.mechanism} applied` };
    },
    async releaseTree({ tree }: { tree: string }) {
      calls.released.push(tree);
      await git(repo.work, "worktree", "remove", "--force", tree);
    },
  };
}

function rungPorts(repo: FixtureRepo, calls: FakeCalls, ideaOfTree: Map<string, string>, policy: Policy, options: FakeOptions) {
  return {
    async staticCheck({ idea }: { idea: Idea }) {
      const code = policy.mechanisms[idea.mechanism]?.l0;
      return code ? { ok: false, code } : { ok: true };
    },
    async micro({ idea, tree, rung }: { idea: Idea; tree: string; rung: string }) {
      calls.micro.push(idea.id);
      return ArMicroSchema.parse(await script("fake_micro.sh", [repo.policyPath, tree, rung]));
    },
    async evalSeed({ tree, seed, key }: { tree: string; seed: string; key: string }) {
      const ideaId = ideaOfTree.get(tree) ?? null;
      calls.evals.push({ ideaId, key });
      await options.beforeEval?.(ideaId, key);
      return ArResultSchema.parse(await script("fake_eval.sh", [repo.policyPath, tree, seed, key]));
    },
  };
}

/** Fake effects over a real fixture repo: scripted planner and implementer, shell-out evaluator, real ratchet. */
export function fakeArPorts(repo: FixtureRepo, policy: Policy, options: FakeOptions): FakeArPorts {
  const calls: FakeCalls = { plans: [], implement: [], evals: [], micro: [], ratchet: [], released: [] };
  const ideaOfTree = new Map<string, string>();
  const target = options.target ?? FIXTURE_TARGET;
  return {
    calls,
    now: () => Date.parse("2026-10-21T00:00:00Z"),
    async pin({ runId, pin }) {
      const ratchetRef = `refs/heads/${target.ratchetPrefix}/${runId}`;
      await git(repo.work, "push", "--quiet", "origin", `${pin}:${ratchetRef}`);
      return { pin, ratchetRef, ratchetHead: pin, integrationTree: repo.work, target, bounds: FIXTURE_BOUNDS };
    },
    async plan(input) {
      calls.plans.push(input);
      return options.planner(input);
    },
    async ratchet(input) {
      calls.ratchet.push(input);
      return ratchetFastForward(execGit, input);
    },
    ...treePorts(repo, calls, ideaOfTree, options),
    ...rungPorts(repo, calls, ideaOfTree, policy, options),
  };
}
