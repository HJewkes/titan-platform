import { describe, expect, it } from "vitest";
import { factoryWorkflows } from "../../workflows.js";
import { entryProblems, type StepEntry } from "../entry.js";
import { entryFor } from "../registry.js";
import { factoryRegistry } from "./index.js";
import { shepherdSteps } from "./shepherd.js";

const declarations = factoryWorkflows.flatMap((definition) => definition.steps.map((step) => ({ workflow: definition.name, ...step })));

const AGENT_STEPS = [
  "audit-gaps", "audit-inventory-code", "audit-plan", "audit-propose", "audit-purpose", "bs-extract", "bs-fix", "bs-implement", "bs-review",
  "sh-await-verdict", "sh-correct-verdict", "sh-late-verdict", "sh-no-verdict-diagnosis", "sh-review", "sh-review-panel", "sh-spawn-fixer", "sh-visual-packet",
];

describe("factory step census", () => {
  it("every step declared by a factory workflow has exactly one registry entry, with the declaration's op", () => {
    const wrong = declarations.filter((step) => {
      const matching = factoryRegistry.entries.filter((entry) => entry.name === step.id);
      return matching.length !== 1 || matching[0]?.op !== step.kind;
    });
    expect(wrong).toEqual([]);
    expect(factoryRegistry.entries.map((entry) => entry.name).sort()).toEqual([...new Set(declarations.map((step) => step.id))].sort());
  });

  it("a step id declared by two workflows resolves to one entry", () => {
    const shared = declarations.filter((step) => declarations.some((other) => other.id === step.id && other.workflow !== step.workflow));
    expect(shared.length).toBeGreaterThan(0);
    for (const step of shared) expect(entryFor(factoryRegistry, step.id)?.name).toBe(step.id);
  });

  it("every assisted gate is OWNER", () => {
    const gates = declarations.filter((step) => step.kind === "assisted");
    expect(gates.filter((gate) => entryFor(factoryRegistry, gate.id)?.kind !== "OWNER")).toEqual([]);
  });

  it("every entry is software unless it is marked AGENT or OWNER, and the AGENT list is exactly the census's", () => {
    const agents = factoryRegistry.entries.filter((entry) => entry.kind === "AGENT").map((entry) => entry.name);
    expect(agents.sort()).toEqual(AGENT_STEPS);
    const owners = factoryRegistry.entries.filter((entry) => entry.kind === "OWNER");
    expect(owners.filter((entry) => entry.op !== "assisted" && entry.op !== "authorize")).toEqual([]);
  });

  it("no registry entry is pending review", () => {
    const reviewed: StepEntry = { ...shepherdSteps[0]! };
    const unreviewed = Object.assign(reviewed, { effect: { class: "pending", reason: "not yet reviewed" } });
    expect(entryProblems(unreviewed)).toMatch(/class/);
    expect(factoryRegistry.entries.filter((entry) => entryProblems(entry) !== undefined)).toEqual([]);
  });
});
