import {
  AUTORESEARCH_VALIDATE_WORKFLOW,
  AUTORESEARCH_WORKFLOW,
  PinnedSchema,
  ProposalSchema,
  RunSettingsSchema,
  arRunSummary,
  arRunView,
  arStepId,
  ideaRefs,
  type ArRunSummary,
  type ArRunView,
  type Pinned,
  type Proposal,
} from "@titan-design/autoresearch";
import { EXIT, defineCommand, type AnyCommand } from "@titan-design/registry";
import type { WorkflowRun, WorkflowStatus } from "@titan-design/workflow";
import { z } from "zod";
import type { FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import type { ArConfig } from "./config.js";
import { ideaDiff, type IdeaDiff } from "./diff-read.js";
import { appendOwnerIdea } from "./inbox.js";

const ALL_STATUSES: WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];

const refused = (message: string, code: number) => Object.assign(new Error(message), { code });
const notFound = (what: string) => refused(`[not_found] ${what}`, EXIT.NOINPUT);

/** Validate runs are separate workflow runs, so a look is found by the run it names as its parent. */
const allOf = (host: FactoryHost, workflowName: string) => host.runtime.listByWorkflow(workflowName, ALL_STATUSES);

function autoresearchRun(host: FactoryHost, runId: string): WorkflowRun {
  const run = host.runtime.status(runId);
  if (!run || run.workflowName !== AUTORESEARCH_WORKFLOW) throw notFound(`no autoresearch run ${runId}`);
  return run;
}

const id = z.string().min(1);

const runs = defineCommand<Record<string, never>, ArRunSummary[], FactoryContext>({
  name: "autoresearch.runs",
  description: "Every autoresearch run in the run store, with its target, phase, round, status, best head and spend; reads only",
  args: z.object({}),
  result: z.custom<ArRunSummary[]>(),
  run: async (_args, ctx) => allOf(ctx.host, AUTORESEARCH_WORKFLOW).map(arRunSummary),
});

const run = defineCommand<{ runId: string }, ArRunView, FactoryContext>({
  name: "autoresearch.run",
  description: "One autoresearch run's read model, replayed from its recorded steps: target, rounds, ladders, registries, cells and validator looks; reads only",
  args: z.object({ runId: id }),
  result: z.custom<ArRunView>(),
  async run({ runId }, ctx) {
    const looks = allOf(ctx.host, AUTORESEARCH_VALIDATE_WORKFLOW).filter((look) => look.params.parent === runId);
    const view = arRunView(autoresearchRun(ctx.host, runId), looks);
    if (!view) throw notFound(`autoresearch run ${runId} has not recorded its pin`);
    return view;
  },
});

const diff = defineCommand<{ runId: string; ideaId: string }, IdeaDiff, FactoryContext>({
  name: "autoresearch.diff",
  description: "One idea's diff against the head it forked from, read from the target's local clone, with the patch capped; reads only",
  args: z.object({ runId: id, ideaId: id }),
  result: z.custom<IdeaDiff>(),
  async run({ runId, ideaId }, ctx) {
    const found = autoresearchRun(ctx.host, runId);
    const refs = ideaRefs(found, ideaId);
    if (!refs) throw notFound(`no idea ${ideaId} with a built head in run ${runId}`);
    const target = found.params.target;
    const clone = target === undefined ? undefined : ctx.autoresearchClone?.(target);
    if (!clone) throw refused(`[no-config] no local clone is configured for autoresearch target ${target ?? "(unnamed)"}`, EXIT.CONFIG);
    return ideaDiff(clone, refs.base, refs.head);
  },
});

export const AR_READ_COMMANDS: readonly AnyCommand<FactoryContext>[] = [runs, run, diff];

const FINISHED: ReadonlySet<WorkflowStatus> = new Set(["completed", "failed", "cancelled"]);

function configured(ctx: FactoryContext): ArConfig {
  if (!ctx.autoresearch) throw refused("[no-config] autoresearch is not configured on this factory", EXIT.CONFIG);
  return ctx.autoresearch;
}

/** The lease: a target runs one search at a time, so two runs never fast-forward the same clone's ratchet. */
function refuseBusy(host: FactoryHost, target: string): void {
  const busy = host.runtime.list().find((other) => other.workflowName === AUTORESEARCH_WORKFLOW && other.params.target === target);
  if (busy) throw refused(`[target-busy] ${busy.id}`, EXIT.GENERIC);
}

const SettingsOverride = z.strictObject({ lanes: z.number().int().positive(), rounds: z.number().int().positive(), minPool: z.number().int().nonnegative() }).partial();
type StartArgs = { target: string; pin: string; config?: z.infer<typeof SettingsOverride> };
interface ArStarted {
  runId: string;
  status: WorkflowStatus;
}

const start = defineCommand<StartArgs, ArStarted, FactoryContext>({
  name: "autoresearch.start",
  description: "Start an autoresearch run on a configured target at a pinned commit on its default branch; refused while the target has an unfinished run",
  args: z.object({ target: id, pin: z.string().regex(/^[0-9a-f]{7,40}$/, "must be a commit sha"), config: SettingsOverride.optional() }),
  result: z.custom<ArStarted>(),
  async run({ target, pin, config }, ctx) {
    const settings = configured(ctx);
    if (!settings.targets[target]) throw refused(`[no-target] ${target} is not under autoresearch.targets`, EXIT.CONFIG);
    refuseBusy(ctx.host, target);
    const runSettings = RunSettingsSchema.parse({ ...settings.run, ...config });
    const runId = ctx.host.runtime.start(AUTORESEARCH_WORKFLOW, { target, pin, config: JSON.stringify(runSettings) });
    return { runId, status: ctx.host.runtime.status(runId)?.status ?? "running" };
  },
});

const addIdea = defineCommand<{ runId: string; proposal: unknown }, { runId: string; proposal: Proposal }, FactoryContext>({
  name: "autoresearch.add-idea",
  description: "Queue an owner proposal for an unfinished run; the run reads it at its next round",
  args: z.object({ runId: id, proposal: z.unknown() }),
  result: z.custom<{ runId: string; proposal: Proposal }>(),
  async run({ runId, proposal }, ctx) {
    const { inboxDir } = configured(ctx);
    const found = autoresearchRun(ctx.host, runId);
    if (FINISHED.has(found.status)) throw refused(`[run-finished] ${runId} is ${found.status}`, EXIT.GENERIC);
    const parsed = ProposalSchema.safeParse(proposal);
    if (!parsed.success) throw refused(`[proposal] ${z.prettifyError(parsed.error)}`, EXIT.DATAERR);
    return { runId, proposal: appendOwnerIdea(inboxDir, runId, parsed.data) };
  },
});

function pinnedOf(found: WorkflowRun): Pinned {
  const recorded = Object.values(found.stepResults).find((result) => result.stepId === arStepId("pin"));
  if (!recorded) throw refused(`[no-pin] ${found.id} has not recorded its pin`, EXIT.GENERIC);
  return z.object({ result: PinnedSchema }).parse(recorded.data).result;
}

interface ArLookStarted {
  runId: string;
  look: number;
  head: string;
}

/** Every look counts against `maxLooks`, failed ones too, since a failed look may still have run held-out cases. */
const milestone = defineCommand<{ runId: string }, ArLookStarted, FactoryContext>({
  name: "autoresearch.milestone",
  description: "Start one validator look at a run's best head on held-out cases; refused once the target's maxLooks looks exist",
  args: z.object({ runId: id }),
  result: z.custom<ArLookStarted>(),
  async run({ runId }, ctx) {
    configured(ctx);
    const found = autoresearchRun(ctx.host, runId);
    const pinned = pinnedOf(found);
    const taken = allOf(ctx.host, AUTORESEARCH_VALIDATE_WORKFLOW).filter((look) => look.params.parent === runId).length;
    const { maxLooks } = pinned.target.validator;
    if (taken >= maxLooks) throw refused(`[max-looks] ${taken}/${maxLooks}`, EXIT.GENERIC);
    const best = arRunSummary(found).best;
    if (!best) throw refused(`[no-best] ${runId} has not recorded its baseline yet`, EXIT.GENERIC);
    const look = taken + 1;
    const params: Record<string, string> = { target: found.params.target ?? "", parent: runId, pin: pinned.pin, head: best.head, look: String(look) };
    if (pinned.frozenHash !== undefined) params.frozenHash = pinned.frozenHash;
    return { runId: ctx.host.runtime.start(AUTORESEARCH_VALIDATE_WORKFLOW, params), look, head: best.head };
  },
});

/** Kept apart from the reads, which stay free of writes and spawns on every surface. */
export const AR_WRITE_COMMANDS: readonly AnyCommand<FactoryContext>[] = [start, addIdea, milestone];
