import { describe, expect, it } from "vitest";
import { AUDIT_INPUT, fakeAuditPorts, type FakeAuditPorts } from "../test-support/audit.js";
import { auditStepId } from "./manifest.js";
import { auditRoutes } from "./routes.js";

function runStep(ports: FakeAuditPorts, stepName: Parameters<typeof auditStepId>[0], prompt: string) {
  const stepId = auditStepId(stepName);
  const route = auditRoutes(ports).find((candidate) => candidate.match === stepId);
  if (!route) throw new Error(`no route for ${stepId}`);
  return route.runner.run({ runId: "run-1", workflowName: "measurement-audit", stepId, iteration: 0, attempt: 1, requestKey: `run-1/${stepId}`, prompt, signal: new AbortController().signal });
}

const MALFORMED_PROMPTS = [
  ["load", "null"],
  ["inventory-data", JSON.stringify({ stores: "ledger" })],
  ["inventory-data", JSON.stringify({ stores: [{ id: "ledger" }] })],
  ["answerability", JSON.stringify({ questions: [{ id: "one" }], surfaces: [] })],
  ["baseline", JSON.stringify({ query: { kind: "sql" } })],
  ["publish", JSON.stringify({ report: {} })],
  ["publish", "{not json"],
] as const;

describe("audit step routes", () => {
  it.each(MALFORMED_PROMPTS)("a malformed step prompt returns ok false, not retryable (%s: %s)", async (stepName, prompt) => {
    const ports = fakeAuditPorts();

    const result = await runStep(ports, stepName, prompt);

    expect(result).toMatchObject({ ok: false, retryable: false, error: expect.any(String) });
    expect(ports.inventoried).toEqual([]);
    expect(ports.written.size).toBe(0);
  });

  it("keeps unknown keys on a store it hands to the inventory port", async () => {
    const seen: unknown[] = [];
    const ports = fakeAuditPorts({ inventory: async (store) => (seen.push(store), { store: store.id, kind: store.kind }) });
    const store = { ...AUDIT_INPUT.stores[0], addedByNewerWriter: "kept" };

    const result = await runStep(ports, "inventory-data", JSON.stringify({ stores: [store], addedAtTop: 1 }));

    expect(result.ok).toBe(true);
    expect(seen).toEqual([store]);
  });

  it("keeps unknown keys on a query it hands to the query port", async () => {
    const seen: unknown[] = [];
    const ports = fakeAuditPorts({ query: async (_store, query) => (seen.push(query), { value: 1, n: 1 }) });
    const query = { kind: "sql", store: "ledger", text: "select 1", addedByNewerWriter: "kept" };

    await runStep(ports, "baseline", JSON.stringify({ query, store: AUDIT_INPUT.stores[0] }));

    expect(seen).toEqual([query]);
  });

  it("hands an agent step its input unchanged, whatever its shape", async () => {
    const ports = fakeAuditPorts();

    await runStep(ports, "inventory-code", JSON.stringify({ system: "synthetic-marker", extra: [1] }));

    expect(ports.agentCalls[0]?.prompt).toContain("synthetic-marker");
  });
});
