import { isRepo } from "@titan-design/github";
import { defineCommand } from "@titan-design/registry";
import type { WorkflowRun, WorkflowStatus } from "@titan-design/workflow";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { BUILD_SURFACE_WORKFLOW } from "./manifest.js";

export interface BuildSurfaceArgs {
  repo: string;
  /** Absolute: the run reads it again on every replay, from whatever directory serve runs in. */
  spec: string;
}

export interface BuildSurfaceStarted {
  runId: string;
  /** False when an unfinished build-surface run for the repo already existed and its id came back instead. */
  created: boolean;
  status: WorkflowStatus;
}

/** Unfinished runs of build-surface for `repo`, oldest first. */
export function buildSurfaceRuns(host: FactoryHost, repo: string, statuses?: readonly WorkflowRun["status"][]): WorkflowRun[] {
  return host.runtime.list(statuses).filter((run) => run.workflowName === BUILD_SURFACE_WORKFLOW && run.params.repo?.toLowerCase() === repo.toLowerCase());
}

/** One run per repo: a second start returns the unfinished run instead of starting a rival that would build the same slices. */
export function startBuildSurface(host: FactoryHost, args: BuildSurfaceArgs): BuildSurfaceStarted {
  const existing = buildSurfaceRuns(host, args.repo)[0];
  if (existing) return { runId: existing.id, created: false, status: existing.status };
  const runId = host.runtime.start(BUILD_SURFACE_WORKFLOW, { repo: args.repo, spec: args.spec });
  return { runId, created: true, status: host.runtime.status(runId)?.status ?? "running" };
}

export const buildSurfaceStartCommand = defineCommand<BuildSurfaceArgs, BuildSurfaceStarted, FactoryContext>({
  name: "factory.build-surface.start",
  description: "Start build-surface for owner/repo from its build spec, or return the unfinished run already building it",
  args: z.object({ repo: z.string().refine(isRepo, "must be owner/repo"), spec: z.string().refine(isAbsolute, "must be an absolute path") }),
  result: z.custom<BuildSurfaceStarted>(),
  run: async (args, ctx) => startBuildSurface(ctx.host, args),
});
