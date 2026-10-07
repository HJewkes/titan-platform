import type { GateRecord } from "@titan-design/hitl";
import { expect } from "vitest";

/** The least brief a requireBrief host accepts, for tests whose gate is not about the brief. */
export const TEST_BRIEF = { summary: "A test gate waits for an answer.", evidenceRef: "$ git status" };

/** The ids a gate's stored answer schema accepts for `decision`. */
function schemaDecisions(gate: GateRecord): unknown {
  const properties = gate.schema?.properties as Record<string, { enum?: unknown; const?: unknown }> | undefined;
  return properties?.decision?.enum ?? [properties?.decision?.const];
}

/** What every gate site owes the owner: a summary naming the head, a link or command, and a menu that matches the schema. */
export function expectBrief(gate: GateRecord | undefined, head: string, evidence: RegExp): void {
  expect(gate, "the gate opened").toBeDefined();
  expect(gate?.summary).toContain(head);
  expect(gate?.evidenceRef).toMatch(evidence);
  const options = gate?.questions?.[0]?.options.map((option) => option.id);
  if (options) expect(options).toEqual(schemaDecisions(gate!));
}
