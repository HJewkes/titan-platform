import { fileURLToPath } from "node:url";
import { CLIENT_HEADER, probeHealth, type Logger } from "@titan-design/daemon";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { resolveDbPath } from "./config.js";
import type { WorkflowDefinition } from "./definition.js";
import { openFactoryHost, type FactoryHost, type FactoryHostOptions, type PendingGate, type ResumeReport } from "./host.js";
import { parsePrRef, resolveCommand, startLand, type LandArgs, type LandStarted } from "./registry.js";
import type { StepRoute } from "./routed-runner.js";
import { FACTORY_PORT, serveFactoryUntilSignal } from "./serve.js";
import { renderPlist, serviceLogDir } from "./service.js";
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
  routes: readonly StepRoute[];
  host?: Partial<Omit<FactoryHostOptions, "dbPath" | "workflows" | "routes">>;
  /** The serve verb's logger; defaults to the console. */
  logger?: Logger;
  /** Stops the serve verb as SIGTERM would. */
  stop?: AbortSignal;
}

const defaultIo: CliIo = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), env: process.env };
const defaultDeps: CliDeps = { workflows: factoryWorkflows, routes: factoryRoutes };
const SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "recovery_required"]);

interface Verbs {
  io: CliIo;
  deps: CliDeps;
  dbPath: () => string;
  withHost: (fn: (host: FactoryHost) => Promise<number> | number) => Promise<void>;
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
  const withHost = async (fn: (host: FactoryHost) => Promise<number> | number): Promise<void> => {
    const host = openFactoryHost({ ...deps.host, dbPath: dbPath(), workflows: deps.workflows, routes: deps.routes });
    try {
      exitCode = await fn(host);
    } finally {
      host.close();
    }
  };
  const verbs: Verbs = { io, deps, dbPath, withHost, setExit };
  for (const register of [registerResume, registerGate, registerServe, registerLand, registerService]) register(program, verbs);
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
      serveFactoryUntilSignal({ ...deps.host, dbPath: dbPath(), workflows: deps.workflows, routes: deps.routes, port: opts.port, logger: deps.logger }, deps.stop),
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

function registerService(program: Command, { io }: Verbs): void {
  program
    .command("service")
    .description("launchd service for titan-factory serve")
    .command("plist")
    .description("print the LaunchAgent plist; the owner writes it to ~/Library/LaunchAgents and bootstraps it")
    .option("--port <n>", "port for the serve argument", parsePort)
    .action((opts: { port?: number }) => {
      const binPath = fileURLToPath(new URL("./bin.js", import.meta.url));
      io.stdout(renderPlist({ binPath, nodePath: process.execPath, logDir: serviceLogDir(io.env), port: opts.port }));
    });
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
  const res = await fetch(`http://127.0.0.1:${port}/rpc/factory.land`, {
    method: "POST",
    headers: { "content-type": "application/json", [CLIENT_HEADER]: "titan-factory" },
    body: JSON.stringify(args),
  });
  const envelope = (await res.json()) as { ok: true; data: LandStarted } | { ok: false; error: string };
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
  host.runtime.signal(runId, stepId, payload);
  io.stdout(`resolved ${runId}/${stepId}\n`);
  return EXIT.OK;
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
