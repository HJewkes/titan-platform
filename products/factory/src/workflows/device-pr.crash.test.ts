import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { GateResolver } from "@titan-design/hitl";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { crashAt } from "../test-support/crash.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { landPrRoutes } from "./land-pr.js";
import { devicePrWorkflow } from "./device-pr.js";

const AT_DEVICE: GateResolver = Object.freeze({ class: "owner-terminal", id: "owner", channel: "factory-cli" });
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-device-pr-crash-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

function greenWorld(): { fake: FakeGitHub; routes: StepRoute[] } {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  let clock = 0;
  return { fake, routes: landPrRoutes({ port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms) }) };
}

describe("device-pr killed while device-confirm is pending", () => {
  it("takes the same gate over, and its answer merges once", async () => {
    const { fake, routes } = greenWorld();
    const crash = crashAt({ dbPath: dbFile(), workflows: [devicePrWorkflow()], routes, hangAt: "merge:0" });
    const runId = crash.crashed.runtime.start("device-pr", { repo: REPO, pr: "1", deviceStep: "Power-cycle the board" });
    await gateOpened(crash.crashed, gateId(runId, "device-confirm"));
    const opened = crash.crashed.gates.get(gateId(runId, "device-confirm"))!;

    const survivor = crash.takeOver(routes);
    await survivor.runtime.hydrate();
    const takenOver = survivor.gates.get(gateId(runId, "device-confirm"));
    survivor.runtime.signal(runId, "device-confirm", { decision: "pass", headSha: H1 }, AT_DEVICE);
    const run = await survivor.runtime.wait(runId);

    try {
      expect(takenOver).toMatchObject({ status: "pending", createdAt: opened.createdAt, prompt: opened.prompt, summary: opened.summary });
      expect(run.status).toBe("completed");
      expect(survivor.gates.get(gateId(runId, "device-confirm", 1))).toBeUndefined();
      expect(fake.effects.merge).toBe(1);
    } finally {
      crash.dispose();
    }
  });
});
