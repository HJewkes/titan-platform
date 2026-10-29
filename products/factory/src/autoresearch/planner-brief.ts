import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quotaRules, QueueOpsSchema, type ArPorts } from "@titan-design/autoresearch";
import { z } from "zod";

interface PlannerTarget {
  name: string;
  /** The target repo checkout the adapter is read from. */
  clone: string;
  /** Where `program.md`, `target.json` and `bounds.json` sit, relative to the clone. */
  adapterDir: string;
}

type PlanInput = Parameters<ArPorts["plan"]>[0];

/** Derived from the schema the engine parses the answer with, so the contract cannot drift from the parser. */
const OPS_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(QueueOpsSchema, { io: "input" }));
const OPS_KEYS = Object.keys(QueueOpsSchema.shape).join(", ");

const roundInput = (input: PlanInput): string => JSON.stringify({ round: input.round, digest: input.digest, violations: input.violations });

/** Worded by the same module whose check the answer must pass, from this round's quota. */
const quotaLine = (input: PlanInput): string => `Quotas this round: ${quotaRules(input.quota).join("; ")}.`;

export const resumeContract = `End with one fenced JSON block of queue ops, keys ${OPS_KEYS}, in the JSON Schema your first brief gave; nothing else is read.`;

function programSection(target: PlannerTarget): string {
  const adapter = join(target.clone, target.adapterDir);
  const program = join(adapter, "program.md");
  const text = existsSync(program) ? `The program, ${program}:\n\n${readFileSync(program, "utf8").trim()}` : `Read the program at ${program} first.`;
  return `${text}\n\nThe keep rule and rungs are in ${join(adapter, "target.json")}; the change classes, their path globs and parameter ranges in ${join(adapter, "bounds.json")}. Read both before you propose.`;
}

/** Round 1's brief is the planner's whole prompt prefix, so it carries the program and the ops contract, not just the digest. */
export function plannerSpawnBrief(target: PlannerTarget, input: PlanInput): string {
  return [
    `You are the planner of autoresearch run ${input.runId} on target ${target.name}. Each round you edit the idea queue; implementers build the picked ideas and a frozen evaluator judges them. You only read; never edit files.`,
    programSection(target),
    `Round input (the digest of evidence so far, and the quotas your last answer missed):\n${roundInput(input)}`,
    quotaLine(input),
    `End contract: your last message must end with one fenced JSON block of queue ops matching this JSON Schema, and nothing else is read:\n${OPS_JSON_SCHEMA}`,
  ].join("\n\n");
}

/** A resumed planner already holds the program in its cached prefix, so only this round's quotas and the contract are restated. */
export function plannerResumeBrief(input: PlanInput): string {
  return `${roundInput(input)}\n\n${quotaLine(input)}\n\n${resumeContract}`;
}
