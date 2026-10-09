import type { RepoSlug } from "@titan-design/github";
import { EXIT } from "@titan-design/registry";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import type { FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { SHEPHERD_COMMAND_MAP, type ShepherdServices } from "./commands.js";
import type { TaskKind } from "./store.js";

export interface HandoffRequest {
  repo: RepoSlug;
  pr: number;
  task: string;
  implementer: string;
  kind: TaskKind;
}

export interface HandoffStatus {
  status: WorkflowRun["status"];
  /** Absent until the run records `sh-landed` or `sh-stopped`. */
  outcome?: "landed" | "stopped";
  mergeSha?: string;
}

/** How a workflow step hands a PR to Shepherd and watches the run it gets back. */
export interface HandoffPort {
  /** Idempotent per repo#pr: a repeat returns the registered run with `created: false`. */
  register(request: HandoffRequest): Promise<{ runId: string; created: boolean }>;
  status(runId: string): HandoffStatus;
}

/** Routes are built before the host exists, so the port is bound once `openFactoryHost` has one. */
export interface HandoffRef extends HandoffPort {
  /** Returns the unbind; it clears only its own binding, so a stale unbind never drops a later host. */
  bind(host: FactoryHost): () => void;
}

export class HandoffNotBoundError extends Error {
  constructor() {
    super("handoff not bound");
    this.name = "HandoffNotBoundError";
  }
}

const LandedData = z.object({ result: z.object({ mergeSha: z.string().nullable() }) });

function baseId(result: StepResult): string {
  return result.stepId.split(":")[0]!;
}

function statusOf(run: WorkflowRun): HandoffStatus {
  const steps = Object.values(run.stepResults);
  const landed = steps.find((result) => baseId(result) === "sh-landed");
  if (landed) {
    const mergeSha = LandedData.safeParse(landed.data).data?.result.mergeSha;
    return { status: run.status, outcome: "landed", ...(mergeSha && { mergeSha }) };
  }
  if (steps.some((result) => baseId(result) === "sh-stopped")) return { status: run.status, outcome: "stopped" };
  return { status: run.status };
}

/** Calls the same `shepherd.register` command the CLI and serve run, so a handoff obeys the seat book and dedupe rules. */
export function handoffRef(services: ShepherdServices): HandoffRef {
  let bound: FactoryHost | undefined;
  const hostOf = (): FactoryHost => {
    if (!bound) throw new HandoffNotBoundError();
    return bound;
  };
  const command = SHEPHERD_COMMAND_MAP["shepherd.register"];
  return {
    bind(host) {
      bound = host;
      return () => {
        if (bound === host) bound = undefined;
      };
    },
    async register(request) {
      const ctx: FactoryContext = { warnings: [], format: "json", host: hostOf(), shepherd: services };
      const { runId, created } = await command.run(command.args.parse(request), ctx);
      return { runId, created };
    },
    status(runId) {
      const run = hostOf().runtime.status(runId);
      if (!run) throw Object.assign(new Error(`no run ${runId}`), { code: EXIT.NOINPUT });
      return statusOf(run);
    },
  };
}
