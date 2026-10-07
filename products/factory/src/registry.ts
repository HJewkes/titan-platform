import { isRepo } from "@titan-design/github";
import type { GateQuestion } from "@titan-design/hitl";
import { EXIT, createRegistry, defineCommand, type BaseContext, type CommandRegistry } from "@titan-design/registry";
import type { WorkflowRun, WorkflowStatus } from "@titan-design/workflow";
import { z } from "zod";
import type { FactoryHost, FactoryRoutes } from "./host.js";
import { SHEPHERD_COMMANDS, type ShepherdServices } from "./shepherd/commands.js";

/** The workflow `factory.land` starts. */
export const LAND_WORKFLOW = "land-pr";

export interface FactoryContext extends BaseContext {
  host: FactoryHost;
  /** Absent when the host runs routes without the shepherd store; the shepherd commands then refuse. */
  shepherd?: ShepherdServices;
}

export interface PrRef {
  repo: string;
  pr: number;
}

export interface LandArgs extends PrRef {
  task?: string;
}

export interface LandStarted {
  runId: string;
  /** False when an unfinished run for the same repo#pr already existed and its id came back instead. */
  created: boolean;
  status: WorkflowStatus;
}

export interface RunSummary {
  id: string;
  workflowName: string;
  status: WorkflowStatus;
  currentStep: string | null;
  params: Record<string, string>;
  owner: { runtimeId: string; leaseUntil: string } | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface GateSummary {
  runId: string;
  stepId: string;
  gateId: string;
  prompt: string;
  schema: unknown;
  resolve: string;
  /** Absent on a gate opened before the brief migration; surfaces fall back to `prompt`. */
  summary?: string;
  evidenceRef?: string;
  questions?: GateQuestion[];
  createdAt: string;
}

const PR_NUMBER = /^[1-9][0-9]*$/;

/** Parse `owner/repo#N` strictly; throws on anything else, including `#0` and `#01`. */
export function parsePrRef(ref: string): PrRef {
  const hash = ref.indexOf("#");
  if (hash < 0) throw new Error(`expected owner/repo#N, got ${JSON.stringify(ref)}: no #`);
  const repo = ref.slice(0, hash);
  const number = ref.slice(hash + 1);
  if (!isRepo(repo)) throw new Error(`expected owner/repo#N, got ${JSON.stringify(ref)}: ${JSON.stringify(repo)} is not owner/repo`);
  if (!PR_NUMBER.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new Error(`expected owner/repo#N, got ${JSON.stringify(ref)}: ${JSON.stringify(number)} is not a PR number`);
  }
  return { repo, pr: Number(number) };
}

/** Start `land-pr` for repo#pr unless an unfinished run for it exists; then return that run instead. */
export function startLand(host: FactoryHost, args: LandArgs): LandStarted {
  const existing = unfinishedLand(host, args);
  if (existing) return { runId: existing.id, created: false, status: existing.status };
  const params = { repo: args.repo, pr: String(args.pr), ...(args.task ? { task: args.task } : {}) };
  const runId = host.runtime.start(LAND_WORKFLOW, params);
  return { runId, created: true, status: host.runtime.status(runId)?.status ?? "running" };
}

/** `runtime.list()` defaults to the unfinished statuses: running, paused, cancelling and recovery_required. */
function unfinishedLand(host: FactoryHost, target: PrRef): WorkflowRun | undefined {
  const pr = String(target.pr);
  return host.runtime.list().find((run) => run.workflowName === LAND_WORKFLOW && run.params.repo === target.repo && run.params.pr === pr);
}

export function resolveCommand(runId: string, stepId: string): string {
  return `titan-factory gate resolve ${runId} ${stepId} --json '<payload>'`;
}

function summarize(run: WorkflowRun): RunSummary {
  const { id, workflowName, status, currentStep, params, startedAt, completedAt, error } = run;
  const owner = run.owner ? { runtimeId: run.owner.runtimeId, leaseUntil: run.owner.leaseUntil } : null;
  return { id, workflowName, status, currentStep, params, owner, startedAt, completedAt, error };
}

const land = defineCommand<LandArgs, LandStarted, FactoryContext>({
  name: "factory.land",
  description: "Start land-pr for owner/repo#pr, or return the unfinished run already landing it",
  args: z.object({
    repo: z.string().refine(isRepo, "must be owner/repo"),
    pr: z.number().int().positive(),
    task: z.string().min(1).optional(),
  }),
  result: z.custom<LandStarted>(),
  run: async (args, ctx) => startLand(ctx.host, args),
});

const status = defineCommand<{ runId?: string }, { runs: RunSummary[] }, FactoryContext>({
  name: "factory.status",
  description: "One run by id, or every unfinished run",
  args: z.object({ runId: z.string().min(1).optional() }),
  result: z.custom<{ runs: RunSummary[] }>(),
  async run({ runId }, ctx) {
    if (!runId) return { runs: ctx.host.runtime.list().map(summarize) };
    const run = ctx.host.runtime.status(runId);
    if (!run) throw Object.assign(new Error(`no run ${runId}`), { code: EXIT.NOINPUT });
    return { runs: [summarize(run)] };
  },
});

const gates = defineCommand<Record<string, never>, { gates: GateSummary[] }, FactoryContext>({
  name: "factory.gates",
  description: "Pending human gates, each with the CLI command that resolves it",
  args: z.object({}),
  result: z.custom<{ gates: GateSummary[] }>(),
  run: async (_args, ctx) => ({
    gates: ctx.host.pendingGates().map(({ runId, stepId, gate }) => ({
      runId,
      stepId,
      gateId: gate.id,
      prompt: gate.prompt,
      schema: gate.schema ?? null,
      resolve: resolveCommand(runId, stepId),
      ...(gate.summary !== undefined && { summary: gate.summary }),
      ...(gate.evidenceRef !== undefined && { evidenceRef: gate.evidenceRef }),
      ...(gate.questions !== undefined && { questions: gate.questions }),
      createdAt: gate.createdAt,
    })),
  }),
});

/** The context every surface runs a command in; the shepherd commands read the services their routes carry. */
export function factoryContext(host: FactoryHost, routes: FactoryRoutes): FactoryContext {
  return { warnings: [], format: "json", host, ...(routes.shepherd && { shepherd: routes.shepherd }) };
}

/** Resolving a gate is deliberately absent: it stays a local `titan-factory gate resolve`, never a network call. */
export function createFactoryRegistry(): CommandRegistry<FactoryContext> {
  const registry = createRegistry<FactoryContext>();
  for (const cmd of [land, status, gates, ...SHEPHERD_COMMANDS]) registry.register(cmd);
  return registry;
}
