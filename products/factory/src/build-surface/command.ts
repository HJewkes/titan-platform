import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { isRepo } from "@titan-design/github";
import type { WorkflowRun } from "@titan-design/workflow";
import type { CliIo, Verbs } from "../cli.js";
import { refusedInProcess } from "../cli-agent-env.js";
import { formatGate } from "../cli-host-verbs.js";
import { parsePort } from "../cli-options.js";
import { postRpc } from "../cli-shepherd-rpc.js";
import { EXIT } from "../exit-codes.js";
import { untilSettledOrGated, type FactoryHost } from "../host.js";
import type { RunSummary } from "../registry.js";
import { FACTORY_PORT } from "../serve.js";
import { probeServe } from "../serve-probe.js";
import { BUILD_SURFACE_WORKFLOW } from "./manifest.js";
import { parseBuildSpec } from "./spec.js";
import { buildSurfaceRuns, startBuildSurface, type BuildSurfaceArgs, type BuildSurfaceStarted } from "./start.js";

type RunLine = Pick<RunSummary, "id" | "status" | "currentStep" | "error">;

/** Checked here as well as at plan, so a bad spec is a usage error at the prompt, not a failed run. */
function readArgs(repo: string, specPath: string): BuildSurfaceArgs {
  if (!isRepo(repo)) throw new Error(`expected owner/repo, got ${JSON.stringify(repo)}`);
  const spec = resolve(specPath);
  const parsed = parseBuildSpec(readFileSync(spec, "utf8"));
  if (parsed.repo.toLowerCase() !== repo.toLowerCase()) throw new Error(`build spec is for ${parsed.repo}, not ${repo}`);
  return { repo, spec };
}

function describe(repo: string, run: RunLine): string {
  const at = run.currentStep ? ` at ${run.currentStep}` : "";
  return `run ${run.id} ${BUILD_SURFACE_WORKFLOW} ${repo}: ${run.status}${at}${run.error ? ` (${run.error})` : ""}`;
}

async function startOnServer(io: CliIo, port: number, args: BuildSurfaceArgs): Promise<number> {
  const envelope = await postRpc<BuildSurfaceStarted>(port, "factory.build-surface.start", args);
  if (!envelope.ok) return (io.stderr(`error: ${envelope.error}\n`), EXIT.FAILURE);
  const line = describe(args.repo, { id: envelope.data.runId, status: envelope.data.status, currentStep: null, error: null });
  io.stdout(`${line}${envelope.data.created ? "" : " (already unfinished)"} on titan-factory serve (port ${port})\n`);
  return EXIT.OK;
}

async function startInProcess(host: FactoryHost, { io, deps }: Verbs, args: BuildSurfaceArgs, port: number): Promise<number> {
  const started = startBuildSurface(host, args);
  if (started.created) await untilSettledOrGated(host.runtime, host.pendingGates, started.runId, deps.host?.gatePollMs ?? 250);
  const run = host.runtime.status(started.runId)!;
  const lines = [describe(args.repo, run), ...host.pendingGates().filter((gate) => gate.runId === started.runId).flatMap(formatGate)];
  lines.push(`no titan-factory serve answered on port ${port}, so this ran in-process; run titan-factory serve to keep it alive`);
  io.stdout(`${lines.join("\n")}\n`);
  return run.status === "failed" ? EXIT.FAILURE : EXIT.OK;
}

async function startVerb(verbs: Verbs, repo: string, opts: { spec: string; port: number }): Promise<void> {
  let args: BuildSurfaceArgs;
  try {
    args = readArgs(repo, opts.spec);
  } catch (err) {
    verbs.io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return verbs.setExit(EXIT.USAGE);
  }
  const probe = await probeServe(opts.port, verbs.deps.serveWaitMs);
  if (probe.state === "up") return verbs.setExit(await startOnServer(verbs.io, opts.port, args));
  if (refusedInProcess(verbs, probe, opts.port, "build-surface start")) return;
  await verbs.withHost((host) => startInProcess(host, verbs, args, opts.port));
}

const ALL: readonly WorkflowRun["status"][] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];

/** Serve's view when it answers, so a run serve holds is read as serve sees it; else this database's. */
async function statusVerb(verbs: Verbs, repo: string, opts: { port: number }): Promise<void> {
  const probe = await probeServe(opts.port, verbs.deps.serveWaitMs);
  if (probe.state === "up") {
    const envelope = await postRpc<{ runs: RunSummary[] }>(opts.port, "factory.status", {});
    if (!envelope.ok) return (verbs.io.stderr(`error: ${envelope.error}\n`), verbs.setExit(EXIT.FAILURE));
    const runs = envelope.data.runs.filter((run) => run.workflowName === BUILD_SURFACE_WORKFLOW && run.params.repo?.toLowerCase() === repo.toLowerCase());
    verbs.io.stdout(runs.length === 0 ? `no unfinished ${BUILD_SURFACE_WORKFLOW} run for ${repo} on titan-factory serve\n` : `${runs.map((run) => describe(repo, run)).join("\n")}\n`);
    return;
  }
  await verbs.withHost((host) => {
    const runs = buildSurfaceRuns(host, repo, ALL);
    verbs.io.stdout(runs.length === 0 ? `no ${BUILD_SURFACE_WORKFLOW} run for ${repo}\n` : `${runs.map((run) => describe(repo, run)).join("\n")}\n`);
    return EXIT.OK;
  });
}

export function registerBuildSurface(program: Command, verbs: Verbs): void {
  const group = program.command("build-surface").description("the repo-agnostic build-surface workflow: slices from a build spec, gated, reviewed, landed and deployed");
  group
    .command("start <repo>")
    .description("start build-surface for owner/repo from its build spec on titan-factory serve if one answers, else here until it ends or waits on a human")
    .requiredOption("--spec <path>", "the build spec: markdown whose YAML front matter is titan.build-surface/v1")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action((repo: string, opts: { spec: string; port: number }) => startVerb(verbs, repo, opts));
  group
    .command("status <repo>")
    .description("the build-surface runs for owner/repo: status, current step and why a finished one failed")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action((repo: string, opts: { port: number }) => statusVerb(verbs, repo, opts));
}
