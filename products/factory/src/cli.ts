import { probeHealth, type Logger } from "@titan-design/daemon";
import { registerAudit } from "./audit/command.js";
import { Command, CommanderError } from "commander";
import { parsePort } from "./cli-options.js";
import { resolveDbPath } from "./config.js";
import type { DeployPorts } from "./deploy.js";
import type { DeployWatch } from "./deploy-watch.js";
import { configuredDeployWatch } from "./deploy-watch-ports.js";
import { configuredDeployPacer } from "./deploy-pacer-sweep.js";
import type { DeployPacerOptions } from "./shepherd/deploy-pacer.js";
import { configuredFixerRetire, configuredMainWatch } from "./main-watch-ports.js";
import { configuredSeatDigest } from "./seat-digest-ports.js";
import type { FixerRetirePorts } from "./shepherd/fixer-retire.js";
import { EXIT } from "./exit-codes.js";
import { evidenceSources } from "./coordinator-evidence-read.js";
import { resolveGate, type OwnerPresence } from "./gate-resolve.js";
import type { WorkflowDefinition } from "./definition.js";
import { registerDigest } from "./digest/cli.js";
import { registerQueueCounts } from "./needs/counts.js";
import { registerNeeds } from "./needs/command.js";
import { FROZEN_HOST_WRITE_VERBS, FrozenHostError, refuseFrozenHost } from "./remote-factory.js";
import { openFactoryHost, untilSettledOrGated, type FactoryHost, type FactoryRoutes, type FactoryHostOptions, type PendingGate, type ResumeReport } from "./host.js";
import { parsePrRef, resolveCommand, startLand, type LandArgs, type LandStarted } from "./registry.js";
import type { StepRoute } from "@titan-design/workflow";
import { FACTORY_PORT, serveFactoryUntilSignal } from "./serve.js";
import { deployCheckoutFor, registerService } from "./cli-service.js";
import { registerScorecard } from "./cli-scorecard.js";
import { registerToolchain } from "./cli-toolchain.js";
import type { CheckPorts } from "./service-check.js";
import type { ServicePorts } from "./service-control.js";
import type { MainWatchPorts } from "./shepherd/main-watch.js";
import type { SeatDigestPorts } from "./shepherd/seat-digest.js";
import { postRpc } from "./cli-shepherd-rpc.js";
import { registerShepherd } from "./cli-shepherd.js";
import type { HeadRefRead } from "./shepherd/register-identity.js";
import { factoryRoutes, factoryWorkflows } from "./workflows.js";

export { EXIT };

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

/** What the CLI hosts; tests swap in their own workflows and host settings. */
export interface CliDeps {
  workflows: readonly WorkflowDefinition[];
  /** A function defers building the routes until a verb opens the host. */
  routes: readonly StepRoute[] | (() => FactoryRoutes);
  host?: Partial<Omit<FactoryHostOptions, "dbPath" | "workflows" | "routes">>;
  /** The serve verb's logger; defaults to the console. */
  logger?: Logger;
  /** Stops the serve verb as SIGTERM would. */
  stop?: AbortSignal;
  /** What the service verbs run launchctl, systemctl, claude, fetch and the filesystem through; defaults to the real machine. */
  service?: ServicePorts;
  /** What `service check` reads launchd, ps, /health and the build through; defaults to the real machine. */
  check?: CheckPorts;
  /** What `service deploy` runs git, pnpm and launchctl or systemctl through; defaults to the real machine in this bin's own checkout. */
  deploy?: DeployPorts;
  /** How `gate resolve` asks for owner presence; defaults to the macOS helper. Code only, never argv or env. */
  presence?: OwnerPresence;
  /** What `shepherd register` resolves a bare task ID through; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** How `shepherd register` reads a PR's head branch to infer a missing --task or --implementer; defaults to gh. */
  headRef?: HeadRefRead;
  /** How long a shepherd verb waits on a serve that holds the connection but does not answer; defaults to 20 s. */
  serveWaitMs?: number;
  /** The serve verb's deploy alarm; absent means serve keeps no deploy block and tells no hub seat. */
  deployWatch?: (env: NodeJS.ProcessEnv) => DeployWatch;
  /** The serve verb's deploy pacer, which spawns the deployer for Shepherd's queued sha; absent means serve spawns none. */
  deployPacer?: (env: NodeJS.ProcessEnv) => DeployPacerOptions;
  /** The serve verb's main CI watch; absent, or undefined for an env, means serve watches main only after its own merges. */
  mainWatch?: (env: NodeJS.ProcessEnv) => MainWatchPorts | undefined;
  fixerRetire?: (env: NodeJS.ProcessEnv) => FixerRetirePorts | undefined;
  /** The serve verb's seat digest; absent, or undefined for an env, means serve sends none. */
  seatDigest?: (env: NodeJS.ProcessEnv) => SeatDigestPorts | undefined;
}

const defaultIo: CliIo = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), env: process.env };
const defaultDeps: CliDeps = { workflows: factoryWorkflows, routes: factoryRoutes, deployWatch: (env) => configuredDeployWatch(env, deployCheckoutFor(env)), deployPacer: (env) => configuredDeployPacer(env, deployCheckoutFor(env)), mainWatch: configuredMainWatch, fixerRetire: configuredFixerRetire, seatDigest: configuredSeatDigest };
const routesOf = (deps: CliDeps): FactoryRoutes => (typeof deps.routes === "function" ? deps.routes() : deps.routes);

export interface Verbs {
  io: CliIo;
  deps: CliDeps;
  dbPath: () => string;
  withHost: (fn: (host: FactoryHost, routes: FactoryRoutes) => Promise<number> | number) => Promise<void>;
  setExit: (code: number) => void;
}

/** Parse argv and run one verb. Returns the exit code instead of exiting, so tests can call it. */
export async function runCli(argv: string[], io: CliIo = defaultIo, deps: CliDeps = defaultDeps): Promise<number> {
  const program = new Command().name("titan-factory").description("Code-driven software-factory workflows").exitOverride();
  program.configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  program.option("--db <path>", "workflow database (TITAN_FACTORY_DB, else the config file, else XDG state)");
  let exitCode: number = EXIT.OK;
  const dbPath = (): string => resolveDbPath({ env: io.env, dbFlag: program.opts<{ db?: string }>().db });
  const setExit = (code: number): void => void (exitCode = code);
  let verb = "";
  program.hook("preAction", (_program, action) => {
    verb = verbPath(action);
    if (FROZEN_HOST_WRITE_VERBS.has(verb)) refuseFrozenHost(io.env, verb);
  });
  const withHost = async (fn: (host: FactoryHost, routes: FactoryRoutes) => Promise<number> | number): Promise<void> => {
    refuseFrozenHost(io.env, verb);
    const routes = routesOf(deps);
    const host = openFactoryHost({ ...deps.host, dbPath: dbPath(), workflows: deps.workflows, routes });
    try {
      exitCode = await fn(host, routes);
    } finally {
      host.close();
    }
  };
  const verbs: Verbs = { io, deps, dbPath, withHost, setExit };
  for (const register of [registerResume, registerGate, registerServe, registerLand, registerShepherd, (p: Command, v: Verbs) => registerDigest(p, v, postRpc), registerQueueCounts, registerNeeds, registerService, registerAudit, registerToolchain, registerScorecard]) register(program, verbs);
  return parse(program, argv, io, () => exitCode);
}

/** `shepherd hold` for the hold subcommand: every command name below the program. */
function verbPath(command: Command): string {
  const names: string[] = [];
  for (let at: Command | null = command; at?.parent; at = at.parent) names.unshift(at.name());
  return names.join(" ");
}

function registerResume(program: Command, { io, withHost }: Verbs): void {
  program
    .command("resume")
    .description("drive every unfinished run until it ends or waits on a human, then list open gates")
    .action(() => withHost(async (host) => (io.stdout(formatResume(await host.resume())), EXIT.OK)));
}

function registerGate(program: Command, { io, deps, withHost }: Verbs): void {
  program
    .command("gate")
    .description("human gates")
    .command("resolve <runId> <stepId>")
    .description("answer the gate a run is waiting on; the payload must match the gate's stored schema")
    .requiredOption("--json <payload>", "resolution payload, a JSON object")
    .action((runId: string, stepId: string, opts: { json: string }) =>
      withHost((host, routes) => resolveGate(host, io, runId, stepId, opts.json, deps.presence, routes.shepherd && evidenceSources(routes.shepherd))),
    );
}

function registerServe(program: Command, { io, deps, dbPath }: Verbs): void {
  program
    .command("serve")
    .description("own the workflow database and keep runs alive, with RPC and MCP on loopback, until SIGTERM or SIGINT")
    .option("--port <n>", "port to bind", parsePort, FACTORY_PORT)
    .action((opts: { port: number }) =>
      serveFactoryUntilSignal({ ...deps.host, dbPath: dbPath(), workflows: deps.workflows, routes: routesOf(deps), port: opts.port, logger: deps.logger, deployWatch: deps.deployWatch?.(io.env), deployPacer: deps.deployPacer?.(io.env), mainWatch: deps.mainWatch?.(io.env), fixerRetire: deps.fixerRetire?.(io.env), seatDigest: deps.seatDigest?.(io.env) }, deps.stop),
    );
}

function registerLand(program: Command, verbs: Verbs): void {
  program
    .command("land <ref>")
    .description("land owner/repo#N: hand it to titan-factory serve if one answers, else drive it here until it ends or waits on a human")
    .option("--task <slug/id>", "the task this PR delivers")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action((ref: string, opts: { task?: string; port: number }) => landVerb(verbs, ref, opts));
}

async function landVerb(verbs: Verbs, ref: string, opts: { task?: string; port: number }): Promise<void> {
  let args: LandArgs;
  try {
    args = { ...parsePrRef(ref), ...(opts.task ? { task: opts.task } : {}) };
  } catch (err) {
    verbs.io.stderr(`error: ${(err as Error).message}\n`);
    return verbs.setExit(EXIT.USAGE);
  }
  if (await probeHealth(opts.port)) return verbs.setExit(await landOnServer(verbs.io, opts.port, args));
  await verbs.withHost((host) => landInProcess(host, verbs, args, opts.port));
}

/** The server's host starts and owns the run, so this shell can exit while it is still in flight. */
async function landOnServer(io: CliIo, port: number, args: LandArgs): Promise<number> {
  const envelope = await postRpc<LandStarted>(port, "factory.land", args);
  if (!envelope.ok) {
    io.stderr(`error: ${envelope.error}\n`);
    return EXIT.FAILURE;
  }
  io.stdout(`${describeLand(args, envelope.data)} on titan-factory serve (port ${port})\n`);
  return EXIT.OK;
}

async function landInProcess(host: FactoryHost, { io, deps }: Verbs, args: LandArgs, port: number): Promise<number> {
  const started = startLand(host, args);
  if (started.created) await untilSettledOrGated(host.runtime, host.pendingGates, started.runId, deps.host?.gatePollMs ?? 250);
  const run = host.runtime.status(started.runId);
  const lines = [`${describeLand(args, { ...started, status: run?.status ?? started.status })}${run?.error ? ` (${run.error})` : ""}`];
  for (const pending of host.pendingGates().filter((gate) => gate.runId === started.runId)) lines.push(...formatGate(pending));
  if (!started.created) lines.push("titan-factory resume drives an unfinished run");
  lines.push(`no titan-factory serve answered on port ${port}, so this ran in-process; run titan-factory serve to keep it alive`);
  io.stdout(`${lines.join("\n")}\n`);
  return run?.status === "failed" ? EXIT.FAILURE : EXIT.OK;
}

function describeLand(args: LandArgs, started: LandStarted): string {
  return `run ${started.runId} land-pr ${args.repo}#${args.pr}: ${started.status}${started.created ? "" : " (already unfinished)"}`;
}

async function parse(program: Command, argv: string[], io: CliIo, exitCode: () => number): Promise<number> {
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) return err.code === "commander.helpDisplayed" || err.code === "commander.version" ? EXIT.OK : EXIT.USAGE;
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof FrozenHostError ? EXIT.USAGE : EXIT.FAILURE;
  }
  return exitCode();
}

export function formatResume(report: ResumeReport): string {
  const lines = report.resumed.map((run) => `resumed ${run.id} ${run.workflowName}: ${run.status}${run.error ? ` (${run.error})` : ""}`);
  for (const { run, reason } of report.held) {
    lines.push(reason === "leased"
      ? `held ${run.id} ${run.workflowName}: leased by ${run.owner?.runtimeId} until ${run.owner?.leaseUntil}; retry after that`
      : `held ${run.id} ${run.workflowName}: recovery_required (${run.error ?? "no evidence"})`);
  }
  for (const pending of report.gates) lines.push(...formatGate(pending));
  if (lines.length === 0) lines.push("nothing to resume");
  return `${lines.join("\n")}\n`;
}

function formatGate({ runId, stepId, gate }: PendingGate): string[] {
  const lines = [`gate ${gate.id}: ${gate.summary ?? gate.prompt}`];
  if (gate.evidenceRef) lines.push(`  evidence: ${gate.evidenceRef}`);
  for (const { question, options } of gate.questions ?? []) {
    lines.push(`  ${question}`, ...options.map((option) => `    - ${option.id}: ${option.label}${option.recommended ? " (recommended)" : ""}`));
  }
  if (gate.schema) lines.push(`  schema: ${JSON.stringify(gate.schema)}`);
  lines.push(`  resolve: ${resolveCommand(runId, stepId)}`);
  return lines;
}
