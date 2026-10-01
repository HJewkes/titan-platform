import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_HEADER, probeHealth, type Logger } from "@titan-design/daemon";
import type { GateResolver } from "@titan-design/hitl";
import { invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { resolveDbPath } from "./config.js";
import type { WorkflowDefinition } from "./definition.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes, type FactoryHostOptions, type PendingGate, type ResumeReport } from "./host.js";
import { createFactoryRegistry, factoryContext, isRepoSlug, parsePrRef, resolveCommand, startLand, type LandArgs, type LandStarted } from "./registry.js";
import type { StepRoute } from "@titan-design/workflow";
import { FACTORY_PORT, serveFactoryUntilSignal } from "./serve.js";
import { renderPlist, serviceLogDir, servicePath, stableNodePath, type PlistOptions } from "./service.js";
import { installService, restartService, runServiceVerb, serviceStatus, uninstallService, type ServicePorts } from "./service-control.js";
import { systemServicePorts } from "./service-ports.js";
import { formatShepherd } from "./shepherd/format.js";
import { factoryRoutes, factoryWorkflows } from "./workflows.js";

export const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

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
  /** What the service verbs run launchctl, claude, fetch and the filesystem through; defaults to the real machine. */
  service?: ServicePorts;
}

const defaultIo: CliIo = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), env: process.env };
const defaultDeps: CliDeps = { workflows: factoryWorkflows, routes: factoryRoutes };
const routesOf = (deps: CliDeps): FactoryRoutes => (typeof deps.routes === "function" ? deps.routes() : deps.routes);
const SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "recovery_required"]);

interface Verbs {
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
  const withHost = async (fn: (host: FactoryHost, routes: FactoryRoutes) => Promise<number> | number): Promise<void> => {
    const routes = routesOf(deps);
    const host = openFactoryHost({ ...deps.host, dbPath: dbPath(), workflows: deps.workflows, routes });
    try {
      exitCode = await fn(host, routes);
    } finally {
      host.close();
    }
  };
  const verbs: Verbs = { io, deps, dbPath, withHost, setExit };
  for (const register of [registerResume, registerGate, registerServe, registerLand, registerShepherd, registerService]) register(program, verbs);
  return parse(program, argv, io, () => exitCode);
}

function registerResume(program: Command, { io, withHost }: Verbs): void {
  program
    .command("resume")
    .description("drive every unfinished run until it ends or waits on a human, then list open gates")
    .action(() => withHost(async (host) => (io.stdout(formatResume(await host.resume())), EXIT.OK)));
}

function registerGate(program: Command, { io, withHost }: Verbs): void {
  program
    .command("gate")
    .description("human gates")
    .command("resolve <runId> <stepId>")
    .description("answer the gate a run is waiting on; the payload must match the gate's stored schema")
    .requiredOption("--json <payload>", "resolution payload, a JSON object")
    .action((runId: string, stepId: string, opts: { json: string }) => withHost((host) => resolveGate(host, io, runId, stepId, opts.json)));
}

function registerServe(program: Command, { deps, dbPath }: Verbs): void {
  program
    .command("serve")
    .description("own the workflow database and keep runs alive, with RPC and MCP on loopback, until SIGTERM or SIGINT")
    .option("--port <n>", "port to bind", parsePort, FACTORY_PORT)
    .action((opts: { port: number }) =>
      serveFactoryUntilSignal({ ...deps.host, dbPath: dbPath(), workflows: deps.workflows, routes: routesOf(deps), port: opts.port, logger: deps.logger }, deps.stop),
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
}

type RegisterOpts = ShepherdOpts & { branch?: string; task: string; implementer: string; reviewer?: string; kind?: string; slice?: string | false; policy?: string };

/** The shepherd.* registry commands as verbs: on titan-factory serve when one answers, else against the database here. */
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
    .action((target: string, opts: RegisterOpts) => runShepherd(verbs, "shepherd.register", () => registerArgs(target, opts), opts));
  verb("status [target]", "one line per shepherded PR, optionally only owner/repo or owner/repo#N")
    .action((target: string | undefined, opts: ShepherdOpts) => runShepherd(verbs, "shepherd.status", () => (target ? parseTarget(target) : {}), opts));
  verb("list", "the watch list")
    .option("--state <state>", "active, finished or all", "active")
    .action((opts: ShepherdOpts & { state: string }) => runShepherd(verbs, "shepherd.list", () => ({ state: opts.state }), opts));
  verb("hold <ref>", "hold owner/repo#N so no merge goes through until release")
    .requiredOption("--reason <text>", "why it is held")
    .action((ref: string, opts: ShepherdOpts & { reason: string }) => runShepherd(verbs, "shepherd.hold", () => ({ ...parsePrRef(ref), reason: opts.reason }), opts));
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
  if (!isRepoSlug(target)) throw new Error(`expected owner/repo or owner/repo#N, got ${JSON.stringify(target)}`);
  return { repo: target };
}

function registerArgs(target: string, opts: RegisterOpts): Record<string, unknown> {
  const policy = opts.policy === undefined ? undefined : parsePayload(opts.policy);
  if (opts.policy !== undefined && !policy) throw new Error("--policy must be a JSON object");
  const { branch, task, implementer, reviewer, kind, slice } = opts;
  return { ...parseTarget(target), branch, task, implementer, reviewer, kind, slice: slice === false ? undefined : slice, noSlice: slice === false ? true : undefined, policy };
}

async function runShepherd(verbs: Verbs, name: string, argsOf: () => object, opts: ShepherdOpts): Promise<void> {
  let args: object;
  try {
    args = argsOf();
  } catch (err) {
    verbs.io.stderr(`error: ${(err as Error).message}\n`);
    return verbs.setExit(EXIT.USAGE);
  }
  if (await probeHealth(opts.port)) return verbs.setExit(printShepherd(verbs.io, name, await postRpc(opts.port, name, args), opts.json));
  await verbs.withHost(async (host, routes) => {
    const { envelope } = await invokeCommand(createFactoryRegistry().get(name)!, args, factoryContext(host, routes));
    if (name === "shepherd.register" && envelope.ok) verbs.io.stderr(`no titan-factory serve answered on port ${opts.port}, so the run was recorded here; titan-factory serve drives it\n`);
    return printShepherd(verbs.io, name, envelope, opts.json);
  });
}

function printShepherd(io: CliIo, name: string, envelope: JsonEnvelope<unknown>, json: boolean | undefined): number {
  if (!envelope.ok) {
    io.stderr(`error: ${envelope.error}\n`);
    return EXIT.FAILURE;
  }
  io.stdout(json ? `${JSON.stringify(envelope.data, null, 2)}\n` : formatShepherd(name, envelope.data));
  return EXIT.OK;
}

interface PlistFlags {
  port?: number;
  node?: string;
}

const collectDir = (value: string, previous: string[]): string[] => [...previous, value];

const NODE_FLAG = "absolute node binary launchd runs; default is this node, mapped off a Homebrew Cellar path";

/** The plist, and the binaries its PATH cannot cover; each of those gets a warning line. */
function plistOptions(io: CliIo, opts: PlistFlags, ports: ServicePorts): { plist: PlistOptions; missing: string[] } {
  const binPath = fileURLToPath(new URL("./bin.js", import.meta.url));
  const nodePath = opts.node ?? stableNodePath(process.execPath);
  const { path, missing } = servicePath(ports.which, nodePath);
  for (const binary of missing) io.stderr(`warning: ${binary} is not on PATH, so the service will not find it\n`);
  return { plist: { binPath, nodePath, logDir: serviceLogDir(io.env), port: opts.port, path }, missing };
}

function registerService(program: Command, verbs: Verbs): void {
  const service = program.command("service").description("launchd service for titan-factory serve");
  service
    .command("plist")
    .description("print the LaunchAgent plist; the owner writes it to ~/Library/LaunchAgents and bootstraps it")
    .option("--port <n>", "port for the serve argument", parsePort)
    .option("--node <path>", NODE_FLAG, parseNodePath)
    .action((opts: PlistFlags) => verbs.io.stdout(renderPlist(plistOptions(verbs.io, opts, verbs.deps.service ?? systemServicePorts()).plist)));
  registerServiceControl(service, verbs);
}

function registerServiceControl(service: Command, { io, deps, setExit }: Verbs): void {
  const run = async (verb: string, fn: (ports: ServicePorts) => Promise<number>): Promise<void> =>
    setExit(await runServiceVerb(verb, deps.service ?? systemServicePorts(), io, fn));
  const logDir = serviceLogDir(io.env);
  service
    .command("install")
    .description("write the LaunchAgent plist, load it (replacing a loaded one) and wait for /health")
    .option("--port <n>", "port titan-factory serve binds", parsePort)
    .option("--node <path>", NODE_FLAG, parseNodePath)
    .option("--mcp", "register the MCP endpoint with claude at user scope")
    .option("--claude-config-dir <dir>", "with --mcp, register in this Claude config dir too (repeatable); default is the caller's profile", collectDir, [])
    .action((opts: PlistFlags & { mcp?: boolean; claudeConfigDir: string[] }) =>
      run("install", (ports) =>
        installService(ports, io, {
          ...plistOptions(io, opts, ports),
          port: opts.port ?? FACTORY_PORT,
          mcp: opts.mcp === true,
          claudeConfigDirs: opts.claudeConfigDir,
          ...(io.env.CLAUDE_CONFIG_DIR ? { callerConfigDir: io.env.CLAUDE_CONFIG_DIR } : {}),
        }),
      ),
    );
  service.command("uninstall").description("unload the LaunchAgent and remove its plist").action(() => run("uninstall", (ports) => uninstallService(ports, io)));
  service
    .command("status")
    .description("loaded or not, the pid, and a /health summary; exits 0 only when /health answers and its GitHub check is ok")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action((opts: { port: number }) => run("status", (ports) => serviceStatus(ports, io, opts.port)));
  service
    .command("restart")
    .description("kill and restart the loaded job, then wait for /health")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action((opts: { port: number }) => run("restart", (ports) => restartService(ports, io, opts.port, logDir)));
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
  if (started.created) await untilSettledOrGated(host, started.runId, deps.host?.gatePollMs ?? 250);
  const run = host.runtime.status(started.runId);
  const lines = [`${describeLand(args, { ...started, status: run?.status ?? started.status })}${run?.error ? ` (${run.error})` : ""}`];
  for (const pending of host.pendingGates().filter((gate) => gate.runId === started.runId)) lines.push(...formatGate(pending));
  if (!started.created) lines.push("titan-factory resume drives an unfinished run");
  lines.push(`no titan-factory serve answered on port ${port}, so this ran in-process; run titan-factory serve to keep it alive`);
  io.stdout(`${lines.join("\n")}\n`);
  return run?.status === "failed" ? EXIT.FAILURE : EXIT.OK;
}

async function untilSettledOrGated(host: FactoryHost, runId: string, pollMs: number): Promise<void> {
  for (;;) {
    const run = host.runtime.status(runId);
    if (!run || SETTLED.has(run.status)) return;
    if (run.status === "paused" && host.pendingGates().some((pending) => pending.runId === runId)) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function describeLand(args: LandArgs, started: LandStarted): string {
  return `run ${started.runId} land-pr ${args.repo}#${args.pr}: ${started.status}${started.created ? "" : " (already unfinished)"}`;
}

/** node's directory goes on the job's PATH, where ":" separates entries. */
function parseNodePath(value: string): string {
  if (!isAbsolute(value)) throw new InvalidArgumentError("must be an absolute path");
  if (value.includes(":")) throw new InvalidArgumentError('must not contain ":"');
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^[0-9]+$/.test(value) || port > 65_535) throw new InvalidArgumentError("expected a port number");
  return port;
}

async function parse(program: Command, argv: string[], io: CliIo, exitCode: () => number): Promise<number> {
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) return err.code === "commander.helpDisplayed" || err.code === "commander.version" ? EXIT.OK : EXIT.USAGE;
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.FAILURE;
  }
  return exitCode();
}

function resolveGate(host: FactoryHost, io: CliIo, runId: string, stepId: string, json: string): number {
  const payload = parsePayload(json);
  if (!payload) {
    io.stderr("error: --json must be a JSON object\n");
    return EXIT.USAGE;
  }
  host.runtime.signal(runId, stepId, payload, cliResolver(io.env));
  io.stdout(`resolved ${runId}/${stepId}\n`);
  return EXIT.OK;
}

/** Owner unless agent-chat spawned this shell; CLAUDECODE is ignored because the owner's `!` commands set it too. A refusal exits FAILURE through `parse`. */
function cliResolver(env: NodeJS.ProcessEnv): GateResolver {
  return { class: env.AGENT_CHAT_AGENT_ID ? "coordinator" : "owner-terminal", id: userInfo().username, channel: "factory-cli" };
}

function parsePayload(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
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
  const lines = [`gate ${gate.id}: ${gate.prompt}`];
  if (gate.schema) lines.push(`  schema: ${JSON.stringify(gate.schema)}`);
  lines.push(`  resolve: ${resolveCommand(runId, stepId)}`);
  return lines;
}
