import type { PullRequest } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import { inlineRunner, type StepRoute } from "@titan-design/workflow";
import { stringify } from "yaml";
import { buildSurfaceCodeRoutes } from "../build-surface/routes.js";
import type { BuildSurfacePorts, CommandRun } from "../build-surface/ports.js";
import type { GateEvidence, ImplementerReport, ReviewReport } from "../build-surface/schemas.js";

export const DEMO_REPO = "owner/demo-repo";
const MAIN_SHA = "0".repeat(40);
export const shaOf = (n: number): string => n.toString(16).padStart(40, "a");

/** A toy two-slice spec: `shell` must merge before `panel` starts. */
export function demoSpec(overrides: Record<string, unknown> = {}): string {
  const spec = {
    schema: "titan.build-surface/v1",
    repo: DEMO_REPO,
    clone: "/work/demo-repo",
    task: "demo/DM-1",
    gate: { command: ["make", "gates"], evidence: "evidence/{slice}/{head}" },
    preview: { command: ["make", "preview"] },
    deploy: { command: ["make", "deploy"], approve: true },
    validate: { report: ["node", "tools/check-report.mjs"] },
    reviewer: { profile: "reviewer-ro" },
    budgetUsd: 300,
    sliceBudgetUsd: 40,
    slices: [
      { id: "shell", title: "App shell", brief: "Build the shell.", partition: ["src/shell/"] },
      { id: "panel", title: "Panel", brief: "Build the panel.", dependsOn: ["shell"] },
    ],
    ...overrides,
  };
  return `---\n${stringify(spec)}---\n\n# Demo build spec\n`;
}

export type GateScript = (slice: string, head: string, round: number) => { status: number; records: Omit<GateEvidence, "head">[] };

export interface FakeBuild {
  ports: BuildSurfacePorts;
  commands: { argv: readonly string[]; env: Record<string, string>; input?: string }[];
  branches: Map<string, string>;
  registered: { repo: string; pr: number; task: string; implementer: string }[];
  /** Agent-step calls in order, as `<step id>`. */
  agentCalls: string[];
}

interface FakeOptions {
  spec?: string;
  gate?: GateScript;
  /** Exit status of the report validator for a head; 0 accepts. */
  reportCheck?: (head: string) => number;
  /** Exit status of the spec's preflight command; 0 when absent. */
  preflight?: number;
  /** Branches already on the remote, as a stopped earlier run left them. */
  branches?: Record<string, string>;
  /** Gate records already in an evidence directory, keyed by the directory. */
  evidence?: Record<string, unknown[]>;
}

const allGreen: GateScript = () => ({ status: 0, records: [{ gate: "G1", pass: true }] });

function commandRunner(fake: FakeBuild, evidence: Map<string, unknown[]>, options: FakeOptions, rounds: Map<string, number>) {
  return async (argv: readonly string[], request: { env: Record<string, string>; input?: string }): Promise<CommandRun> => {
    fake.commands.push({ argv, env: request.env, ...(request.input !== undefined && { input: request.input }) });
    if (argv[1] === "gates") {
      const { BS_SLICE: slice = "", BS_HEAD: head = "", BS_EVIDENCE: dir = "" } = request.env;
      const round = rounds.get(slice) ?? 0;
      rounds.set(slice, round + 1);
      const result = (options.gate ?? allGreen)(slice, head, round);
      evidence.set(dir, result.records.map((record) => ({ ...record, head })));
      return { status: result.status, stdout: "", stderr: result.status === 0 ? "" : "a gate failed" };
    }
    if (argv[1] === "tools/check-report.mjs") {
      const status = options.reportCheck?.(request.env.BS_HEAD ?? "") ?? 0;
      return { status, stdout: status === 0 ? "" : "diff leaves the partition: src/other.ts\n", stderr: "" };
    }
    if (argv[1] === "preflight") return { status: options.preflight ?? 0, stdout: "", stderr: "spec lock moved" };
    return { status: 0, stdout: "ok", stderr: "" };
  };
}

/** Ports with no machine behind them: commands, GitHub and Shepherd are maps, and every PR merges at once. */
export function fakeBuild(options: FakeOptions = {}): FakeBuild {
  const evidence = new Map<string, unknown[]>(Object.entries(options.evidence ?? {}));
  const prs = new Map<string, number>();
  const fake: FakeBuild = { ports: partialFake<BuildSurfacePorts>(), commands: [], branches: new Map([["main", MAIN_SHA], ...Object.entries(options.branches ?? {})]), registered: [], agentCalls: [] };
  fake.ports = {
    now: () => Date.parse("2026-10-28T12:00:00Z"),
    readText: async () => options.spec ?? demoSpec(),
    run: commandRunner(fake, evidence, options, new Map()),
    readEvidence: async (dir) => (evidence.get(dir) ?? []).map((json, n) => ({ path: `${dir}/G${n + 1}.json`, json })),
    github: {
      getHeadSha: async (_repo, branch) => fake.branches.get(branch) ?? null,
      ensureBranch: async (_repo, branch, sha) => (fake.branches.set(branch, sha), { sha, done: true }),
      findPr: async () => null,
      openPr: async (_repo, request) => {
        const number = prs.get(request.head) ?? prs.size + 1;
        prs.set(request.head, number);
        return { pr: partialFake<PullRequest>({ number, headRef: request.head }), done: true };
      },
    },
    implementer: { start: () => Promise.reject(new Error("routed to a stub")), resume: () => Promise.reject(new Error("routed to a stub")) },
    extract: async () => ({ output: { cases: [] }, costUsd: 0.5 }),
    shepherd: {
      register: async (request) => (fake.registered.push(request), { runId: `sh-${request.pr}` }),
      land: async ({ pr }) => ({ state: "merged", mergeSha: shaOf(9000 + pr) }),
    },
  };
  return fake;
}

const answer = (result: object): string => JSON.stringify({ result });

/** Every agent step as an inlineRunner: an implementer round pushes the next head; a review passes what it is shown. */
function stubAgentRoutes(fake: FakeBuild): StepRoute[] {
  let pushes = 0;
  const push = (stepId: string): ImplementerReport => {
    const slice = stepId.split(":")[1]!;
    const head = shaOf(++pushes);
    fake.branches.set(`build-surface/${slice}`, head);
    fake.agentCalls.push(stepId);
    return { head, targetsCovered: [], newPrimitivesRequested: [], deviations: [], ideas: [] };
  };
  const review = (prompt: string, stepId: string): ReviewReport => {
    fake.agentCalls.push(stepId);
    const head = /at exactly head ([0-9a-f]{40})/.exec(prompt)![1]!;
    return { head, verdict: "PASS", rows: [{ rubric: 1, result: "pass" }] };
  };
  const route = (match: string, onRestart: "park" | "repeat", fn: (input: { prompt: string; stepId: string }) => string): StepRoute => ({ match, onRestart, runner: inlineRunner(fn) });
  return [
    route("bs-extract", "repeat", ({ stepId }) => (fake.agentCalls.push(stepId), answer({ targets: { cases: ["c1"] } }))),
    route("bs-implement", "park", ({ stepId }) => answer({ agent: "bs-demo-repo-shell", sessionId: "s1", report: push(stepId) })),
    route("bs-fix", "park", ({ stepId }) => answer({ agent: "bs-demo-repo-shell", sessionId: "s1", report: push(stepId) })),
    route("bs-review", "repeat", ({ prompt, stepId }) => answer({ agent: "reviewer", sessionId: "s2", report: review(prompt, stepId) })),
  ];
}

/** The toy run's routes: the real code routes over the fake ports, and inline stubs for every agent step. */
export function stubbedRoutes(fake: FakeBuild): StepRoute[] {
  return [...buildSurfaceCodeRoutes(fake.ports), ...stubAgentRoutes(fake)];
}
