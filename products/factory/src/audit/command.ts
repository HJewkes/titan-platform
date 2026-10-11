import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { parse } from "yaml";
import type { Verbs } from "../cli.js";
import { EXIT } from "../exit-codes.js";
import { untilSettledOrGated, type FactoryHost } from "../host.js";
import { resolveCommand } from "../registry.js";
import { AUDIT_WORKFLOW } from "./workflow.js";

interface AuditOpts {
  input: string;
  out: string;
}

/** YAML is a superset of JSON, so one parser reads either form of the input file. */
function readInput(path: string, area: string): unknown {
  const input = parse(readFileSync(path, "utf8")) as { system?: unknown } | null;
  if (input?.system !== area) throw new Error(`input is for ${JSON.stringify(input?.system)}, not "${area}"`);
  return input;
}

function describeRun(host: FactoryHost, runId: string, area: string, out: string): string[] {
  const run = host.runtime.status(runId);
  const lines = [`run ${runId} ${AUDIT_WORKFLOW} ${area}: ${run?.status ?? "unknown"}${run?.error ? ` (${run.error})` : ""}`];
  for (const { stepId, gate } of host.pendingGates().filter((pending) => pending.runId === runId)) {
    lines.push(`gate ${gate.id}: ${gate.summary ?? gate.prompt}`, `  resolve: ${resolveCommand(runId, stepId)}`, `  then titan-factory resume writes the report to ${out}`);
  }
  return lines;
}

async function auditVerb(verbs: Verbs, area: string, opts: AuditOpts): Promise<void> {
  let input: unknown;
  try {
    input = readInput(opts.input, area);
  } catch (err) {
    verbs.io.stderr(`error: ${(err as Error).message}\n`);
    return verbs.setExit(EXIT.USAGE);
  }
  const out = resolve(opts.out);
  await verbs.withHost(async (host) => {
    const runId = host.runtime.start(AUDIT_WORKFLOW, { input: JSON.stringify(input), out });
    await untilSettledOrGated(host.runtime, host.pendingGates, runId, verbs.deps.host?.gatePollMs ?? 250);
    verbs.io.stdout(`${describeRun(host, runId, area, out).join("\n")}\n`);
    return host.runtime.status(runId)?.status === "failed" ? EXIT.FAILURE : EXIT.OK;
  });
}

export function registerAudit(program: Command, verbs: Verbs): void {
  program
    .command("audit <area>")
    .description("run the measurement-audit workflow for one area here, up to the area owner's review gate")
    .requiredOption("--input <file>", "the audit input (system, codeRoots, stores, surfaces, owner, mode) as YAML or JSON")
    .requiredOption("--out <file>", "where publish writes the titan.measurement-audit/v1 report once the owner approves and the run resumes")
    .action((area: string, opts: AuditOpts) => auditVerb(verbs, area, opts));
}
