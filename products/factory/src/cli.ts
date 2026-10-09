import { CLIENT_HEADER, probeHealth, type Logger } from "@titan-design/daemon";
import { invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { Command, CommanderError } from "commander";
import { parsePort } from "./cli-options.js";
import { resolveDbPath } from "./config.js";
import type { DeployPorts } from "./deploy.js";
import { deployBlockOf, deploySummary, type DeployHealth } from "./deploy-health.js";
import type { DeployWatch } from "./deploy-watch.js";
import { configuredDeployWatch } from "./deploy-watch-ports.js";
import { EXIT } from "./exit-codes.js";
import { evidenceSources } from "./coordinator-evidence-read.js";
import { parsePayload, resolveGate, type OwnerPresence } from "./gate-resolve.js";
import type { WorkflowDefinition } from "./definition.js";
import { registerDigest } from "./digest/cli.js";
import { registerQueueCounts } from "./needs/counts.js";
import { FROZEN_HOST_WRITE_VERBS, FrozenHostError, refuseFrozenHost } from "./remote-factory.js";
import { openFactoryHost, untilSettledOrGated, type FactoryHost, type FactoryRoutes, type FactoryHostOptions, type PendingGate, type ResumeReport } from "./host.js";
import { createFactoryRegistry, factoryContext, parsePrRef, resolveCommand, startLand, type LandArgs, type LandStarted } from "./registry.js";
import { isRepo } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { FACTORY_PORT, serveFactoryUntilSignal } from "./serve.js";
import { ownCheckout, registerService } from "./cli-service.js";
import { registerShepherdStats } from "./cli-stats.js";
import type { CheckPorts } from "./service-check.js";
import type { ServicePorts } from "./service-control.js";
import type { ShepherdCommandName } from "./shepherd/commands.js";
import { activeWorkOrigin } from "./shepherd/cleanup-ports.js";
import { formatShepherd } from "./shepherd/format.js";
import { qualifyTask } from "./shepherd/task-ref.js";
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
  /** The serve verb's deploy alarm; absent means serve keeps no deploy block and tells no hub seat. */
  deployWatch?: (env: NodeJS.ProcessEnv) => DeployWatch;
}

const defaultIo: CliIo = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), env: process.env };
const defaultDeps: CliDeps = { workflows: factoryWorkflows, routes: factoryRoutes, deployWatch: (env) => configuredDeployWatch(env, ownCheckout()) };
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
  for (const register of [registerResume, registerGate, registerServe, registerLand, registerShepherd, (p: Command, v: Verbs) => registerDigest(p, v, postRpc), registerQueueCounts, registerService]) register(program, verbs);
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
      serveFactoryUntilSignal({ ...deps.host, dbPath: dbPath(), workflows: deps.workflows, routes: routesOf(deps), port: opts.port, logger: deps.logger, deployWatch: deps.deployWatch?.(io.env) }, deps.stop),
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

interface ShepherdOpts {
  port: number;
  json?: boolean;
  offline?: boolean;
  deploy?: boolean;
}

type RegisterOpts = ShepherdOpts & { branch?: string; task: string; implementer: string; reviewer?: string; kind?: string; slice?: string | false; policy?: string };

/** The shepherd.* registry commands as verbs: on titan-factory serve when one answers, else against the database here; register needs --offline for that. */
function registerShepherd(program: Command, verbs: Verbs): void {
  const shepherd = program.command("shepherd").description("shepherd PRs to a merge; gate resolve stays its own verb and is never a shepherd command");
  const verb = (spec: string, description: string): Command =>
    shepherd
      .command(spec)
      .description(description)
      .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
      .option("--json", "print the result as JSON");
  verb("register <target>", "shepherd owner/repo#N, or owner/repo with --branch before its PR exists; a repeat returns the existing run, or a new one if it failed")
    .option("--branch <name>", "the PR's head branch")
    .requiredOption("--task <slug/id>", "the task this PR delivers")
    .requiredOption("--implementer <name>", "the agent that pushes fixes")
    .option("--reviewer <name>", "the agent that reviews")
    .option("--kind <kind>", "correctness, security, feature, refactor or unknown")
    .option("--slice <label>", "this PR is one slice of a multi-slice task: landing notes the task instead of closing it")
    .option("--no-slice", "clear a slice kept from an earlier registration")
    .option("--policy <json>", 'narrow the seat policy, e.g. {"merge":"never"}')
    .option("--offline", "record the run in the database here when no titan-factory serve answers; nothing drives it until serve starts")
    .action((target: string, opts: RegisterOpts) => runShepherd(verbs, "shepherd.register", () => registerArgs(target, opts, verbs), opts));
  verb("status [target]", "one line per shepherded PR, optionally only owner/repo or owner/repo#N, then serve's deploy line")
    .option("--deploy", "with --json, print { rows, deploy } so the deploy block rides along; without it --json stays the bare row array")
    .action((target: string | undefined, opts: ShepherdOpts) => runShepherd(verbs, "shepherd.status", () => (target ? parseTarget(target) : {}), opts));
  verb("list", "the watch list")
    .option("--state <state>", "active, finished or all", "active")
    .action((opts: ShepherdOpts & { state: string }) => runShepherd(verbs, "shepherd.list", () => ({ state: opts.state }), opts));
  verb("hold <ref>", "hold owner/repo#N so no merge goes through until release")
    .requiredOption("--reason <text>", "why it is held")
    .option("--reviewer <name>", "the reviewer whose verdict the run waits for; the reason text never names one")
    .action((ref: string, opts: ShepherdOpts & { reason: string; reviewer?: string }) =>
      runShepherd(verbs, "shepherd.hold", () => ({ ...parsePrRef(ref), reason: opts.reason, reviewer: opts.reviewer }), opts));
  verb("resync", "end runs and gates whose PR was merged or closed outside Shepherd, cancel gates of ended runs, supersede moved heads")
    .option("--dry-run", "print what it would end, cancel or supersede, and write nothing")
    .action((opts: ShepherdOpts & { dryRun?: boolean }) => runShepherd(verbs, "shepherd.resync", () => ({ dryRun: opts.dryRun === true }), opts));
  registerShepherdStats(shepherd, verbs.io, verbs.dbPath, verbs.setExit);
  for (const [name, description] of PR_VERBS) {
    verb(`${name} <ref>`, description).action((ref: string, opts: ShepherdOpts) => runShepherd(verbs, `shepherd.${name}`, () => parsePrRef(ref), opts));
  }
}

const PR_VERBS = [
  ["timeline", "every step and gate the run for owner/repo#N recorded"],
  ["release", "release the hold on owner/repo#N"],
  ["merge", "evaluate a merge of owner/repo#N now; it resolves no gate"],
] as const;

function parseTarget(target: string): { repo: string; pr?: number } {
  if (target.includes("#")) return parsePrRef(target);
  if (!isRepo(target)) throw new Error(`expected owner/repo or owner/repo#N, got ${JSON.stringify(target)}`);
  return { repo: target };
}

async function registerArgs(target: string, opts: RegisterOpts, { io, deps }: Verbs): Promise<Record<string, unknown>> {
  const policy = opts.policy === undefined ? undefined : parsePayload(opts.policy);
  if (opts.policy !== undefined && !policy) throw new Error("--policy must be a JSON object");
  const { branch, implementer, reviewer, kind, slice } = opts;
  const task = await qualifyTask(opts.task, { origin: activeWorkOrigin(io.env), ...(deps.fetch && { fetch: deps.fetch }) });
  return { ...parseTarget(target), branch, task, implementer, reviewer, kind, slice: slice === false ? undefined : slice, noSlice: slice === false ? true : undefined, policy };
}

async function runShepherd(verbs: Verbs, name: ShepherdCommandName, argsOf: () => object | Promise<object>, opts: ShepherdOpts): Promise<void> {
  let args: object;
  try {
    args = await argsOf();
  } catch (err) {
    verbs.io.stderr(`error: ${(err as Error).message}\n`);
    return verbs.setExit(EXIT.USAGE);
  }
  const health = await probeHealth(opts.port);
  const deploy = name === "shepherd.status" ? deployBlockOf(health) : undefined;
  if (health) return verbs.setExit(printShepherd(verbs.io, name, await postRpc(opts.port, name, args), opts, deploy));
  if (name === "shepherd.register" && !opts.offline) {
    verbs.io.stderr(`error: no titan-factory serve answered on port ${opts.port}; nothing was recorded (pass --offline to record the run here anyway)\n`);
    return verbs.setExit(EXIT.UNAVAILABLE);
  }
  await verbs.withHost(async (host, routes) => {
    const { envelope } = await invokeCommand(createFactoryRegistry().get(name)!, args, factoryContext(host, routes));
    if (name === "shepherd.register" && envelope.ok) verbs.io.stderr(`no titan-factory serve answered on port ${opts.port}, so the run was recorded here; titan-factory serve drives it\n`);
    return printShepherd(verbs.io, name, envelope, opts, deploy);
  });
}

/** `deploy` is serve's deploy block for `status`: null when serve keeps none, undefined for every other verb. */
function printShepherd(io: CliIo, name: ShepherdCommandName, envelope: JsonEnvelope<unknown>, opts: ShepherdOpts, deploy: DeployHealth | null | undefined): number {
  if (!envelope.ok) {
    io.stderr(`error: ${envelope.error}\n`);
    return EXIT.FAILURE;
  }
  if (!opts.json) io.stdout(`${formatShepherd(name, envelope.data)}${deploy ? deploySummary(deploy) : ""}`);
  else io.stdout(`${JSON.stringify(opts.deploy && deploy !== undefined ? { rows: envelope.data, deploy } : envelope.data, null, 2)}\n`);
  return EXIT.OK;
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

async function postRpc<T>(port: number, name: string, args: unknown): Promise<JsonEnvelope<T>> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CLIENT_HEADER]: "titan-factory" },
    body: JSON.stringify(args),
  });
  return (await res.json()) as JsonEnvelope<T>;
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
