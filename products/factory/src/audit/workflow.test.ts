import { measurementAuditSchema, type MeasurementAudit } from "@titan-design/health/metrics";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { AUDIT_INPUT, BROKEN_QUERY, HAND_AUDIT_COUNTS, fakeAuditPorts, type FakeAuditPorts } from "../test-support/audit.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryWorkflows } from "../workflows.js";
import { AUDIT_WORKFLOW, measurementAuditWorkflow } from "./workflow.js";
import { auditRoutes } from "./routes.js";
import type { AuditInput } from "./schemas.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function openHost(ports: FakeAuditPorts): FactoryHost {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [measurementAuditWorkflow()], routes: auditRoutes(ports), gatePollMs: 5 });
  hosts.push(host);
  return host;
}

async function audit(ports: FakeAuditPorts, decision = "publish", input: AuditInput = AUDIT_INPUT) {
  const host = openHost(ports);
  const runId = host.runtime.start(AUDIT_WORKFLOW, { input: JSON.stringify(input), out: "/reports/shepherd.json" });
  await gateOpened(host, gateId(runId, "audit-review"));
  host.runtime.signal(runId, "audit-review", { decision }, OWNER);
  const run = await host.runtime.wait(runId);
  return { run, report: ports.written.size > 0 ? (JSON.parse([...ports.written.values()][0]!) as MeasurementAudit) : undefined };
}

const within10 = (actual: number, expected: number) => Math.abs(actual - expected) <= 0.1 * expected;

describe("measurement-audit on Shepherd's recorded step outputs", () => {
  it("reproduces the hand audit's counts within 10 percent", async () => {
    const { run, report } = await audit(fakeAuditPorts());

    expect(run?.status).toBe("completed");
    const answerable = (kind: string) => report!.questions.filter((question) => question.answerable === kind).length;
    const actual = { ...report!.counts, yes: answerable("yes"), partly: answerable("partly"), no: answerable("no"), reports: report!.reports.length };
    const expected = { ...HAND_AUDIT_COUNTS, ...HAND_AUDIT_COUNTS.questions };
    for (const key of ["proposed", "Y", "P", "N", "slices", "yes", "partly", "no", "reports"] as const) {
      expect(within10(actual[key], expected[key]), `${key}: ${actual[key]} vs ${expected[key]}`).toBe(true);
    }
  });

  it("writes a report that validates as titan.measurement-audit/v1", async () => {
    const { report } = await audit(fakeAuditPorts());

    expect(measurementAuditSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({ schema: "titan.measurement-audit/v1", system: "shepherd", mode: "initial", codeRev: "0123abcd", at: "2026-10-09T00:00:00.000Z" });
  });

  it("demotes a claimed Y whose query fails to P and records the error, never a zero", async () => {
    const { report } = await audit(fakeAuditPorts());

    const broken = report!.metrics.find((spec) => spec.query?.text === BROKEN_QUERY);
    expect(broken?.source.captured).toBe("P");
    expect(broken?.baseline).toEqual({ value: null, n: 0, error: "no such table: missing_table" });
  });

  it("runs only commands of declared surfaces, and a failing one makes the question unanswerable", async () => {
    const ports = fakeAuditPorts();
    const ran: string[] = [];
    const surface = ports.surface;
    ports.surface = async (command, signal) => (ran.push(command), surface(command, signal));

    const { report } = await audit(ports);

    expect(ran).not.toContain("sqlite3 ledger");
    expect(report!.questions.find((question) => question.id === 1)).toMatchObject({ answerable: "no" });
  });

  it("ranks the registry entry as the last slice", async () => {
    const { report } = await audit(fakeAuditPorts());

    expect(report!.gaps.at(-1)?.slice.title).toBe("metrics/shepherd.yml registry entry");
    expect(report!.gaps.map((gap) => gap.rank)).toEqual(report!.gaps.map((_, index) => index + 1));
  });

  it("asks each agent step with the model the manifest names", async () => {
    const ports = fakeAuditPorts();
    await audit(ports);

    expect(ports.agentCalls.map(({ step, model }) => [step, model])).toEqual([
      ["inventory-code", "sonnet"],
      ["purpose", "opus"],
      ["propose", "opus"],
      ["gaps", "sonnet"],
      ["plan", "sonnet"],
    ]);
  });

  it("publishes nothing when the owner discards the audit at review", async () => {
    const ports = fakeAuditPorts();
    const { run } = await audit(ports, "discard");

    expect(run?.status).toBe("completed");
    expect(ports.written.size).toBe(0);
  });

  it("fails at load, before any store is read, for an area the registry does not list", async () => {
    const ports = fakeAuditPorts();
    const host = openHost(ports);

    const run = await host.runtime.wait(host.runtime.start(AUDIT_WORKFLOW, { input: JSON.stringify({ ...AUDIT_INPUT, system: "nowhere" }) }));

    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining('area "nowhere" is not in the area registry') });
    expect(ports.inventoried).toEqual([]);
  });

  it("refuses a reaudit until the drift check exists", async () => {
    const host = openHost(fakeAuditPorts());

    const run = await host.runtime.wait(host.runtime.start(AUDIT_WORKFLOW, { input: JSON.stringify({ ...AUDIT_INPUT, mode: "reaudit" }) }));

    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("reaudit") });
  });

  it("is registered with the factory's workflows", () => {
    expect(factoryWorkflows.map((workflow) => workflow.name)).toContain(AUDIT_WORKFLOW);
  });
});
