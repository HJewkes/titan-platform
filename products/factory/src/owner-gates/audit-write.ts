import { linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { activeWorkRoot } from "@titan-design/app-paths";
import type { GateRecord } from "@titan-design/hitl";
import type { WorkflowRun } from "@titan-design/workflow";
import { decisionClassOf, policyRowOf } from "../decision-class.js";
import { gateStepOf } from "../needs/gate-card.js";
import { outcomeFacts, runIdOf, type AuditIncident } from "./audit-facts.js";
import { judgeOrUnavailable, type AuditJudge } from "./audit-judge.js";
import { renderAudit, waitHoursOf, type AuditItem } from "./audit-render.js";
import { sampleOwnerGates, weekPopulation, weekSeed } from "./audit-sample.js";

/** Written straight into the initiative's sources: `active-work source add` would rename it away from its week. */
export function auditPath(env: NodeJS.ProcessEnv, week: string): string {
  return join(activeWorkRoot({ env }), "titan-platform", "sources", `owner-gate-audit-${week}.md`);
}

export class AuditExists extends Error {
  constructor(readonly path: string) {
    super(`${path} already exists; pass --force to replace it`);
  }
}

/** Through a temp file, so a reader never sees half a report; without `force`, the link refuses an existing file atomically. */
export function writeAuditFile(path: string, markdown: string, { force = false } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, markdown);
    if (force) renameSync(temp, path);
    else linkSync(temp, path);
  } catch (error) {
    if (!force && error instanceof Error && "code" in error && error.code === "EEXIST") throw new AuditExists(path);
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

export interface AuditInputs {
  week: string;
  gates: readonly GateRecord[];
  runs: readonly WorkflowRun[];
  /** Undefined when no incident record was read; the report then says incidents are unknown. */
  incidents: readonly AuditIncident[] | undefined;
  now: number;
  /** Undefined runs the audit with no judge, as `--no-judge` does. */
  judge: AuditJudge | undefined;
}

function prUrlOf(run: WorkflowRun | undefined): string | undefined {
  const repo = run?.params.repo;
  return repo && Number(run.params.pr) > 0 ? `https://github.com/${repo}/pull/${run.params.pr}` : undefined;
}

function classOf(gate: GateRecord): string | undefined {
  const row = policyRowOf(gate.prompt) ?? (gate.rule && { table: gate.rule.table, rowId: gate.rule.ruleId });
  return decisionClassOf({ ...row, step: gateStepOf(gate.id), prompt: gate.prompt });
}

async function auditItem(gate: GateRecord, inputs: AuditInputs): Promise<AuditItem> {
  const facts = outcomeFacts(gate, inputs.runs, inputs.incidents, inputs.now);
  const question = gate.questions?.[0]?.question ?? gate.summary ?? gate.prompt.split("\n", 1)[0]!;
  const cls = classOf(gate);
  const input = { gateId: gate.id, class: cls, question, answer: facts.decision, waitHours: waitHoursOf(gate), evidence: gate.resolvedEvidence, facts };
  const prUrl = prUrlOf(inputs.runs.find((run) => run.id === runIdOf(gate.id)));
  return { gate, class: cls, prUrl, question, facts, judge: await judgeOrUnavailable(inputs.judge, input) };
}

/** Samples the week, reads each decision's outcome and judge note, and renders the file; writes nothing. */
export async function buildAudit(inputs: AuditInputs): Promise<{ items: AuditItem[]; markdown: string }> {
  const items: AuditItem[] = [];
  for (const gate of sampleOwnerGates(inputs.gates, inputs.week)) items.push(await auditItem(gate, inputs));
  const header = { week: inputs.week, seed: weekSeed(inputs.week), population: weekPopulation(inputs.gates, inputs.week).length };
  return { items, markdown: renderAudit(header, items) };
}
