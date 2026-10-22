import { AUTORESEARCH_VALIDATE_WORKFLOW, AUTORESEARCH_WORKFLOW, arRunSummary, arRunView, ideaRefs, type ArRunSummary, type ArRunView } from "@titan-design/autoresearch";
import { EXIT, defineCommand, type AnyCommand } from "@titan-design/registry";
import type { WorkflowRun, WorkflowStatus } from "@titan-design/workflow";
import { z } from "zod";
import type { FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { ideaDiff, type IdeaDiff } from "./diff-read.js";

const ALL_STATUSES: WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];

const refused = (message: string, code: number) => Object.assign(new Error(message), { code });
const notFound = (what: string) => refused(`[not_found] ${what}`, EXIT.NOINPUT);

/** Validate runs are separate workflow runs, so a look is found by the run it names as its parent. */
const allOf = (host: FactoryHost, workflowName: string) => host.runtime.list(ALL_STATUSES).filter((run) => run.workflowName === workflowName);

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
