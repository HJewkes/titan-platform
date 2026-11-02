import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { defineWorkflow } from "./definition.js";
import { openFactoryHost } from "./host.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-definition-pin-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

function gatedWorkflow(label: string) {
  return defineWorkflow({
    name: "gated",
    steps: [{ id: "approve", kind: "assisted" }],
    run: async (ctx) => {
      const brief = { summary: `Approve the change? ${label}`, evidenceRef: "$ git log -1" };
      await ctx.assisted("approve", "Approve the change?", { schema: z.object({ approve: z.literal(true) }), brief });
    },
  });
}

const routes: StepRoute[] = [];

async function gatedRun(dbPath: string): Promise<string> {
  const host = openFactoryHost({ dbPath, workflows: [gatedWorkflow("before")], routes, gatePollMs: 10 });
  const runId = host.runtime.start("gated");
  await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("paused"));
  expect(host.runtime.status(runId)?.definitionVersion).toBeUndefined();
  host.close();
  return runId;
}

describe("the definitionVersion pin stays off", () => {
  it("a deploy that changes a workflow's body under the same name parks no run", async () => {
    const dbPath = dbFile();
    const runId = await gatedRun(dbPath);

    const deployed = openFactoryHost({ dbPath, workflows: [gatedWorkflow("after")], routes, gatePollMs: 10 });
    try {
      const report = await deployed.resume();
      const run = deployed.runtime.status(runId);
      expect(run?.status).toBe("paused");
      expect(report.held).toEqual([]);
      expect(report.gates.map((gate) => gate.runId)).toContain(runId);
      expect(JSON.stringify(run)).not.toMatch(/definition changed/i);
    } finally {
      deployed.close();
    }
  });

  it("the factory registers its workflows unpinned", async () => {
    const dbPath = dbFile();
    const host = openFactoryHost({ dbPath, workflows: [gatedWorkflow("before")], routes, gatePollMs: 10 });
    try {
      const runId = host.runtime.start("gated");
      expect(host.runtime.status(runId)?.definitionVersion).toBeUndefined();
    } finally {
      host.close();
    }
  });
});
