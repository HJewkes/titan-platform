import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { seedRepoWithOrigin } from "@titan-design/test-kit/git";
import { BoundsSchema, type Bounds } from "../bounds.js";
import { parseUnifiedDiff } from "../diff.js";
import { postCheck } from "../post-check.js";
import type { QuotaContext } from "../queue.js";
import type { Digest } from "../digest.js";
import type { ArPorts, ImplementRequest, IntegrateRequest, LookAggregate, LookRequest, MicroRequest, RatchetRequest, RegistryRow, RoundRecord, RunPin } from "../ports.js";
import { ArMicroSchema, ArResultSchema, TargetSchema, type Idea, type Proposal, type QueueOps, type Target } from "../schemas.js";
import { fakeMergeOnto } from "./fake-integrate.js";
import { fakeSnapshotPorts, type SnapshotCalls, type SnapshotOptions } from "./fake-snapshot.js";

const run = promisify(execFile);
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const IDENTITY = ["-c", "user.name=autoresearch fixture", "-c", "user.email=fixture@example.invalid"];

type Named = Record<string, number>;

interface Mechanism {
  /** Added to the base metrics; a `by_key` entry replaces a name's effect for one run key. */
  metrics?: Named;
  violations?: Named;
  by_key?: Record<string, { metrics?: Named; violations?: Named }>;
  micro?: boolean;
  /** What the implementer appends, by path; by default a comment in the idea's first target and its class's test file. */
  files?: Record<string, string>;
}

/** What `fake_eval.sh` reports: base metrics, which one carries ±sigma noise, and each mechanism's effect. */
export interface Policy {
  sigma: number;
  noisy: string;
  metrics: Named;
  gates?: string[];
  violations?: string[];
  mechanisms: Record<string, Mechanism>;
  /** An effect named "a+b" applies on top of each mechanism's own only when every named one is in the tree. */
  interactions?: Record<string, Mechanism>;
  /** What each eval run, micro run and implement reports spending; 0 when absent. */
  usd?: { eval?: number; micro?: number; implement?: number };
}

/** A synthetic target repo: a bare `origin` and one checkout that serves as the integration tree. */
export interface FixtureRepo {
  root: string;
  bare: string;
  work: string;
  policyPath: string;
  pin: string;
}

export const git = async (cwd: string, ...args: string[]) => (await run("git", [...IDENTITY, ...args], { cwd })).stdout.trim();

/** The target's own tree at the pin, so an idea's edit is a modification, as it would be on a real repo. */
export const SEED_FILES: Record<string, string> = {
  "src/gate/gates.py": "def accept(task):\n    return True\n",
  "src/gate/measure.py": "def measure(run):\n    return 0\n",
  "src/planner/rank.py": "def rank(tasks):\n    return tasks\n",
  "src/config.json": `${JSON.stringify({ hot_cc: 10, p5: { crossings: 1 } }, null, 2)}\n`,
  "tests/test_gate.py": "def test_accept():\n    assert True\n",
  "tests/test_planner.py": "def test_rank():\n    assert True\n",
};

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A copy of the policy's template repo and its bare origin, which already holds the seed commit. */
export async function fixtureRepo(policy: Policy): Promise<FixtureRepo> {
  const root = mkdtempSync(join(tmpdir(), "ar-fixture-"));
  const bare = join(root, "origin.git");
  const work = join(root, "work");
  seedRepoWithOrigin(work, bare, { ...SEED_FILES, "policy.json": JSON.stringify(policy, null, 2) });
  return { root, bare, work, policyPath: join(work, "policy.json"), pin: await git(work, "rev-parse", "HEAD") };
}

export const removeFixture = (repo: FixtureRepo) => rmSync(repo.root, { recursive: true, force: true });

const NOISE = { bandSigmas: 2, lockAfterPairs: 5, minPairs: 3, defaultBand: 1.5 };
const PHASES = [{ id: "p1", train: ["t-alpha"], baselineRuns: 6, stop: { ideasEvaluated: 16, roundsWithoutGain: 3 } }];

/** A code-health target: lower is better, every gate must hold, and a micro rung per class. */
export const FIXTURE_TARGET: Target = TargetSchema.parse({
  schema: "ar-target/v1",
  ratchetPrefix: "autoresearch/fixture",
  metric: {
    primary: { name: "cc_total_delta_pct", direction: "min" },
    guards: { single_caller_delta: 1 },
    zeroTolerance: ["hidden_regressions"],
    allGate: true,
    noOp: "accepted_tasks",
    noise: NOISE,
  },
  microRung: { "accept-gate": "L1-replay", "planner-ranking": "L1-cluster" },
  frozen: ["src/gate/measure.py", "tests/test_ar_*.py"],
  phases: PHASES,
});

export const FIXTURE_POLICY: Omit<Policy, "mechanisms"> = {
  sigma: 0.2,
  noisy: "cc_total_delta_pct",
  metrics: { cc_total_delta_pct: 0, single_caller_delta: 0, accepted_tasks: 5 },
  gates: ["all_gate"],
  violations: ["hidden_regressions"],
};

/** A second, unrelated target: higher is better, a tail-latency guard and a served-count guard that may not fall, crash counts, no gates and no micro rung. */
export const THROUGHPUT_TARGET: Target = TargetSchema.parse({
  schema: "ar-target/v1",
  ratchetPrefix: "autoresearch/throughput",
  metric: {
    primary: { name: "throughput_rps", direction: "max" },
    guards: { p99_ms: 5, requests_served: { slack: 0, direction: "max" } },
    zeroTolerance: ["crashes"],
    allGate: false,
    noOp: "requests_served",
    noise: NOISE,
  },
  phases: PHASES,
});

export const THROUGHPUT_POLICY: Omit<Policy, "mechanisms"> = {
  sigma: 0.5,
  noisy: "throughput_rps",
  metrics: { throughput_rps: 100, p99_ms: 40, requests_served: 1000 },
  violations: ["crashes"],
};

export const FIXTURE_BOUNDS: Bounds = BoundsSchema.parse({
  schema: "ar-bounds/v1",
  classes: {
    "accept-gate": { paths: ["src/gate/*.py"], tests: ["tests/test_gate*.py"] },
    "planner-ranking": { paths: ["src/planner/{rank,recipes}.py"], tests: ["tests/test_planner*.py"] },
    "config-param": { paths: ["src/config.json"], params: { hot_cc: [6, 15], "p5.*": [0, 0.2] }, integerParams: ["hot_cc"] },
  },
  test: { required: true, mustFailOnBase: true, exceptClasses: ["config-param"] },
  banned: { frozenTouch: true, literalsOutsideConfig: "added source literals other than 0, 1, 2, -1", newFiles: "only under the class's test globs", seedNames: "the run's case names" },
});

export function proposal(mechanism: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    hypothesis: `${mechanism} improves the primary metric`,
    mechanism,
    class: "accept-gate",
    direction: mechanism,
    targets: ["src/gate/gates.py"],
    expectedEffect: { metric: "primary", direction: "down", microSignal: "fewer accepts" },
    microArgs: {},
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

interface FakeCalls extends SnapshotCalls {
  plans: { round: number; violations: string[]; digest: Digest; quota: QuotaContext; mode: string }[];
  implement: string[];
  /** Every implement input but the brief, in call order. */
  implementInputs: Omit<ImplementRequest, "brief">[];
  evals: { ideaId: string | null; key: string }[];
  micro: string[];
  microInputs: MicroRequest[];
  ratchet: RatchetRequest[];
  integrate: IntegrateRequest[];
  released: string[];
  archives: { round: number; record: RoundRecord }[];
  /** The run pin every evaluator step named, by step. */
  runPins: { step: "eval" | "l0" | "l1" | "ratchet"; runPin: RunPin }[];
  inbox: { round: number; after: number }[];
  looks: LookRequest[];
  registry: { runId: string; row: RegistryRow }[];
}

const FIXTURE_FROZEN_HASH = "f".repeat(64);
const runPinIn = ({ runId, pin, frozenHash }: RunPin): RunPin => ({ runId, pin, frozenHash });

export interface FakeOptions extends SnapshotOptions {
  planner: (input: { round: number; violations: string[]; digest: Digest }) => Partial<QueueOps>;
  /** A parse error to answer instead of ops, as a planner whose final message held no JSON does. */
  plannerMalformed?: (input: { round: number; violations: string[] }) => string | undefined;
  target?: Target;
  bounds?: Bounds;
  /** Case names the L0 post-check refuses in an added line. */
  caseNames?: string[];
  /** Defaults to a fast-forward push from the integration tree; a host may pass its own ratchet. */
  ratchet?: (request: RatchetRequest) => Promise<{ head: string }>;
  /** Awaited before an implement or an eval runs: tests hold a lane open or simulate a kill with it. */
  beforeImplement?: (idea: Idea, call: number, lane: number) => Promise<void>;
  beforeEval?: (ideaId: string | null, key: string) => Promise<void>;
  beforePlan?: (round: number) => Promise<void>;
  /** Awaited once a merge is built, before the step records it: a test simulates a kill with it. */
  afterIntegrate?: (call: number) => Promise<void>;
  /** The owner inbox, read live: a test pushes to it while the run is going. */
  inbox?: Proposal[];
  /** What a validator look answers; by default one aggregate with no per-case key. */
  validate?: (input: LookRequest) => LookAggregate;
}

const FIXTURE_LOOK = { aggregate: { metrics: { cc_total_delta_pct: -1 }, gates: { all_gate: 3 } }, provenance: "fixture validator", usd: 0 };

export type FakeArPorts = ArPorts & { calls: FakeCalls };

async function script(name: string, args: string[]): Promise<unknown> {
  return JSON.parse((await run("bash", [join(FIXTURES, name), ...args])).stdout);
}

/** The idea's own edit; `applied/` is the fake evaluator's channel and stays out of the diff L0 checks. */
function editsOf(idea: Idea, policy: Policy, bounds: Bounds): Record<string, string> {
  const files = policy.mechanisms[idea.mechanism]?.files;
  if (files) return files;
  const testGlob = bounds.classes[idea.class]?.tests[0];
  const edits = { [idea.targets[0]!]: `# ${idea.mechanism}\n` };
  return testGlob ? { ...edits, [testGlob.replaceAll("*", "")]: `# checks ${idea.mechanism}\n` } : edits;
}

/** An exploit lane resumes the agent it names; every other lane is a fresh spawn named for its idea and round. */
function implementerOf({ idea, round, fork, resumeFrom }: Omit<ImplementRequest, "brief">) {
  const resumed = fork === "exploit" && resumeFrom !== undefined;
  const agent = resumed ? resumeFrom : `implementer-${idea.id}-r${round}`;
  return { agent, sessionId: `session-${agent}`, mode: resumed ? ("resume" as const) : ("spawn" as const), resumedFrom: resumed ? agent : undefined, account: "fixture" };
}

function treePorts(repo: FixtureRepo, calls: FakeCalls, ideaOfTree: Map<string, string>, policy: Policy, options: FakeOptions) {
  return {
    async allocTree({ runId, ideaId, base }: { runId: string; ideaId: string; base: string }) {
      const tree = join(repo.root, "trees", `${ideaId}-${ideaOfTree.size}`);
      const branch = `ar-idea/${runId}/${ideaId}`;
      await git(repo.work, "worktree", "add", "--quiet", "-B", branch, tree, base);
      ideaOfTree.set(tree, ideaId);
      return { tree, branch };
    },
    async implement({ brief: _brief, ...input }: ImplementRequest) {
      const { idea, tree } = input;
      calls.implement.push(idea.id);
      calls.implementInputs.push(input);
      await options.beforeImplement?.(idea, calls.implement.length, input.lane);
      writeFiles(tree, { [join("applied", idea.mechanism)]: `${idea.mechanism}\n` });
      for (const [path, text] of Object.entries(editsOf(idea, policy, options.bounds ?? FIXTURE_BOUNDS))) {
        mkdirSync(dirname(join(tree, path)), { recursive: true });
        appendFileSync(join(tree, path), text);
      }
      await git(tree, "add", "--all");
      await git(tree, "commit", "--quiet", "-m", `apply ${idea.mechanism}`);
      return { head: await git(tree, "rev-parse", "HEAD"), usd: policy.usd?.implement ?? 0, lesson: `${idea.mechanism} applied`, ...implementerOf(input) };
    },
    async releaseTree({ tree }: { tree: string }) {
      calls.released.push(tree);
      await git(repo.work, "worktree", "remove", "--force", tree);
    },
  };
}

function rungPorts(repo: FixtureRepo, calls: FakeCalls, ideaOfTree: Map<string, string>, target: Target, options: FakeOptions) {
  return {
    async staticCheck({ idea, tree, base, head, ...runPin }: RunPin & { idea: Idea; tree: string; base: string; head: string }) {
      calls.runPins.push({ step: "l0", runPin: runPinIn(runPin) });
      const text = await git(tree, "diff", "--no-color", "--unified=0", "-M", base, head, "--", ".", ":(exclude)applied");
      const bounds = options.bounds ?? FIXTURE_BOUNDS;
      const checked = postCheck({ idea, diff: parseUnifiedDiff(text), bounds, frozen: target.frozen, caseNames: options.caseNames ?? [] });
      return { ok: checked.code === undefined, code: checked.code, checks: checked.checks, diff: checked.size };
    },
    async micro(input: MicroRequest) {
      const { idea, tree, rung } = input;
      calls.micro.push(idea.id);
      calls.microInputs.push(input);
      calls.runPins.push({ step: "l1", runPin: runPinIn(input) });
      return ArMicroSchema.parse(await script("fake_micro.sh", [repo.policyPath, tree, rung, idea.mechanism]));
    },
    async evalCase({ tree, case: testCase, key, ...runPin }: RunPin & { tree: string; case: string; key: string }) {
      const ideaId = ideaOfTree.get(tree) ?? null;
      calls.evals.push({ ideaId, key });
      calls.runPins.push({ step: "eval", runPin: runPinIn(runPin) });
      await options.beforeEval?.(ideaId, key);
      return ArResultSchema.parse(await script("fake_eval.sh", [repo.policyPath, tree, testCase, key]));
    },
  };
}

/** A load gate that never waits; an archive, a registry and an inbox that only record or replay what they were given. */
function recordPorts(repo: FixtureRepo, calls: FakeCalls, options: FakeOptions): Pick<ArPorts, "loadWait" | "archive" | "ownerIdeas" | "registry"> {
  return {
    loadWait: async () => ({ waitedMs: 0, load5: 0.5 }),
    async archive({ runId, round, record }) {
      calls.archives.push({ round, record });
      return { path: join(repo.root, "archive", runId, `round-${round}.json`), sha256: "0".repeat(64) };
    },
    async ownerIdeas({ round, after }) {
      calls.inbox.push({ round, after });
      const inbox = options.inbox ?? [];
      return { ideas: inbox.slice(after), cursor: inbox.length };
    },
    async registry(input) {
      calls.registry.push(input);
      return { path: join(repo.root, "registry.jsonl") };
    },
  };
}

function validatePort(calls: FakeCalls, options: FakeOptions, now: () => number): Pick<ArPorts, "validate"> {
  return {
    async validate(input) {
      calls.looks.push(input);
      return options.validate?.(input) ?? { look: input.look, at: new Date(now()).toISOString(), sha: input.head, ...FIXTURE_LOOK };
    },
  };
}

/** The winner fast-forwards the remote ref, refused if the ref moved since the round started. */
async function pushRatchet({ tree, ratchetRef, from, to }: RatchetRequest): Promise<{ head: string }> {
  await git(tree, "push", "--quiet", `--force-with-lease=${ratchetRef}:${from}`, "origin", `${to}:${ratchetRef}`);
  return { head: to };
}

function movePorts(calls: FakeCalls, options: FakeOptions): Pick<ArPorts, "ratchet" | "integrate"> {
  return {
    async ratchet(input) {
      calls.ratchet.push(input);
      calls.runPins.push({ step: "ratchet", runPin: runPinIn(input) });
      return (options.ratchet ?? pushRatchet)(input);
    },
    async integrate(input) {
      calls.integrate.push(input);
      const result = await fakeMergeOnto(input);
      await options.afterIntegrate?.(calls.integrate.length);
      return result;
    },
  };
}

/** Fake effects over a real fixture repo: scripted planner and implementer, shell-out evaluator, a push ratchet. */
export function fakeArPorts(repo: FixtureRepo, policy: Policy, options: FakeOptions): FakeArPorts {
  const calls: FakeCalls = { plans: [], implement: [], implementInputs: [], evals: [], micro: [], microInputs: [], ratchet: [], integrate: [], snapshot: [], sync: [], released: [], archives: [], runPins: [], inbox: [], looks: [], registry: [] };
  const ideaOfTree = new Map<string, string>();
  const target = options.target ?? FIXTURE_TARGET;
  const now = () => Date.parse("2026-10-21T00:00:00Z");
  return {
    calls,
    now,
    async pin({ runId, pin }) {
      const ratchetRef = `refs/heads/${target.ratchetPrefix}/${runId}`;
      await git(repo.work, "push", "--quiet", "origin", `${pin}:${ratchetRef}`);
      return { pin, ratchetRef, ratchetHead: pin, integrationTree: repo.work, target, bounds: options.bounds ?? FIXTURE_BOUNDS, frozenHash: FIXTURE_FROZEN_HASH };
    },
    async plan(input) {
      calls.plans.push(input);
      await options.beforePlan?.(input.round);
      const agent = `planner-${input.runId}`;
      const malformed = options.plannerMalformed?.(input);
      const answer = malformed === undefined ? { ops: options.planner(input) } : { ops: {}, malformed };
      return { ...answer, agent, sessionId: `session-${agent}`, mode: input.mode, usage: { usd: 0.25, cacheReadTokens: 40, retries: 0 } };
    },
    ...movePorts(calls, options),
    ...fakeSnapshotPorts(calls, options),
    ...recordPorts(repo, calls, options),
    ...validatePort(calls, options, now),
    ...treePorts(repo, calls, ideaOfTree, policy, options),
    ...rungPorts(repo, calls, ideaOfTree, target, options),
  };
}
