import { Command, CommanderError } from "commander";
import { resolveDbPath } from "./config.js";
import type { WorkflowDefinition } from "./definition.js";
import { openFactoryHost, type FactoryHost, type FactoryHostOptions, type PendingGate, type ResumeReport } from "./host.js";
import type { StepRoute } from "./routed-runner.js";
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
}

const defaultIo: CliIo = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), env: process.env };
const defaultDeps: CliDeps = { workflows: factoryWorkflows, routes: factoryRoutes };

/** Parse argv and run one verb. Returns the exit code instead of exiting, so tests can call it. */
export async function runCli(argv: string[], io: CliIo = defaultIo, deps: CliDeps = defaultDeps): Promise<number> {
  const program = new Command().name("titan-factory").description("Code-driven software-factory workflows").exitOverride();
  program.configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  program.option("--db <path>", "workflow database (TITAN_FACTORY_DB, else the config file, else XDG state)");
  let exitCode: number = EXIT.OK;
  const withHost = async (fn: (host: FactoryHost) => Promise<number> | number): Promise<void> => {
    const dbPath = resolveDbPath({ env: io.env, dbFlag: program.opts<{ db?: string }>().db });
    const host = openFactoryHost({ ...deps.host, dbPath, workflows: deps.workflows, routes: deps.routes });
    try {
      exitCode = await fn(host);
    } finally {
      host.close();
    }
  };
  program
    .command("resume")
    .description("drive every unfinished run until it ends or waits on a human, then list open gates")
    .action(() => withHost(async (host) => (io.stdout(formatResume(await host.resume())), EXIT.OK)));
  program
    .command("gate")
    .description("human gates")
    .command("resolve <runId> <stepId>")
    .description("answer the gate a run is waiting on; the payload must match the gate's stored schema")
    .requiredOption("--json <payload>", "resolution payload, a JSON object")
    .action((runId: string, stepId: string, opts: { json: string }) => withHost((host) => resolveGate(host, io, runId, stepId, opts.json)));
  return parse(program, argv, io, () => exitCode);
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
  lines.push(`  resolve: titan-factory gate resolve ${runId} ${stepId} --json '<payload>'`);
  return lines;
}
