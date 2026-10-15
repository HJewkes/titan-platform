import type { Command } from "commander";
import type { CliDeps, Verbs } from "./cli.js";
import { parsePort } from "./cli-options.js";
import { evidenceSources } from "./coordinator-evidence-read.js";
import { EXIT } from "./exit-codes.js";
import { resolveGate } from "./gate-resolve.js";
import type { FactoryRoutes, PendingGate, ResumeReport } from "./host.js";
import { resolveCommand } from "./registry.js";
import { FACTORY_PORT, serveFactoryUntilSignal } from "./serve.js";

export const routesOf = (deps: CliDeps): FactoryRoutes => (typeof deps.routes === "function" ? deps.routes() : deps.routes);

export function registerResume(program: Command, { io, withHost }: Verbs): void {
  program
    .command("resume")
    .description("drive every unfinished run until it ends or waits on a human, then list open gates")
    .action(() => withHost(async (host) => (io.stdout(formatResume(await host.resume())), EXIT.OK)));
}

export function registerGate(program: Command, { io, deps, withHost }: Verbs): void {
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

export function registerServe(program: Command, { io, deps, dbPath }: Verbs): void {
  program
    .command("serve")
    .description("own the workflow database and keep runs alive, with RPC and MCP on loopback, until SIGTERM or SIGINT")
    .option("--port <n>", "port to bind", parsePort, FACTORY_PORT)
    .action(async (opts: { port: number }) => {
      await serveFactoryUntilSignal({ ...deps.host, dbPath: dbPath(), workflows: deps.workflows, routes: routesOf(deps), port: opts.port, logger: deps.logger, deployWatch: deps.deployWatch?.(io.env), deployPacer: deps.deployPacer?.(io.env), mainWatch: deps.mainWatch?.(io.env), fixerRetire: deps.fixerRetire?.(io.env), seatDigest: deps.seatDigest?.(io.env), gateNotify: deps.gateNotify?.(io.env) }, deps.stop);
      deps.exitAfterServe?.();
    });
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

export function formatGate({ runId, stepId, gate }: PendingGate): string[] {
  const lines = [`gate ${gate.id}: ${gate.summary ?? gate.prompt}`];
  if (gate.evidenceRef) lines.push(`  evidence: ${gate.evidenceRef}`);
  for (const { question, options } of gate.questions ?? []) {
    lines.push(`  ${question}`, ...options.map((option) => `    - ${option.id}: ${option.label}${option.recommended ? " (recommended)" : ""}`));
  }
  if (gate.schema) lines.push(`  schema: ${JSON.stringify(gate.schema)}`);
  lines.push(`  resolve: ${resolveCommand(runId, stepId)}`);
  return lines;
}
