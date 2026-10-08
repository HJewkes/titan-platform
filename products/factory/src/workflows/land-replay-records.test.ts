import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "../definition.js";
import { gateEverything } from "../gate-policy.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { gateId, gateOpened, landScenario, type LandScenario } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { LAND_STEPS, MAX_UPDATE_CYCLES, MAX_UPDATE_RETRIES, land, newUpdateBound } from "./land.js";

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

type Bound = ReturnType<typeof newUpdateBound>;
/** A bound whose retries are spent from the start stands in for code that predates retries: it goes from the budget straight to the gate. */
const OLD_CODE: Bound = { ...newUpdateBound(), retries: MAX_UPDATE_RETRIES };

interface World {
  scenario: LandScenario;
  dbPath: string;
  open(bound?: Bound): FactoryHost;
  stopRacing(): void;
}

function world(): World {
  const scenario = landScenario();
  const keepGreen = scenario.fake.onGetPr!;
  let racing = true;
  scenario.fake.onGetPr = (pr, reads) => (keepGreen(pr, reads), (pr.behind = racing));
  const dir = mkdtempSync(join(tmpdir(), "factory-land-records-"));
  dirs.push(dir);
  const dbPath = join(dir, "factory.sqlite3");
  const open = (updateBound?: Bound) => {
    const workflow = defineWorkflow({ name: "land-test", steps: LAND_STEPS, run: async (ctx) => void scenario.outcomes.push(await land(ctx, { repo: "octo/demo", pr: 1, updateBound }, { policy: gateEverything })) });
    const host = openFactoryHost({ dbPath, workflows: [workflow], routes: scenario.routes, gatePollMs: 5 });
    hosts.push(host);
    return host;
  };
  return { scenario, dbPath, open, stopRacing: () => void (racing = false) };
}

const rows = (host: FactoryHost, runId: string, prefix: string) => Object.values(host.runtime.status(runId)!.stepResults).filter((row) => row.stepId.startsWith(prefix)).length;

describe("a restart during a stuck-behind wait", () => {
  const cases = [
    { name: "old code, answered", recordedBy: OLD_CODE, answered: true, backoffs: 0, updates: MAX_UPDATE_CYCLES },
    { name: "old code, paused", recordedBy: OLD_CODE, answered: false, backoffs: 0, updates: MAX_UPDATE_CYCLES },
    { name: "new code, answered", recordedBy: undefined, answered: true, backoffs: MAX_UPDATE_RETRIES, updates: MAX_UPDATE_CYCLES + MAX_UPDATE_RETRIES },
    { name: "new code, paused", recordedBy: undefined, answered: false, backoffs: MAX_UPDATE_RETRIES, updates: MAX_UPDATE_CYCLES + MAX_UPDATE_RETRIES },
  ];

  it.each(cases)("$name: keeps the recorded retries and honours a retry answer exactly once", async ({ recordedBy, answered, backoffs, updates }) => {
    const w = world();
    const first = w.open(recordedBy);
    const runId = first.runtime.start("land-test");
    await gateOpened(first, gateId(runId, "stuck-behind"));
    if (answered) {
      w.stopRacing();
      first.runtime.signal(runId, "stuck-behind", { decision: "retry" }, OWNER);
      await gateOpened(first, gateId(runId, "approve-merge"));
    }
    const atRestart = rows(first, runId, "update-branch");
    first.close();

    const second = w.open();
    await second.runtime.hydrate();
    if (!answered) {
      await gateOpened(second, gateId(runId, "stuck-behind"));
      expect(rows(second, runId, "update-branch")).toBe(atRestart);
      w.stopRacing();
      second.runtime.signal(runId, "stuck-behind", { decision: "retry" }, OWNER);
    }
    await gateOpened(second, gateId(runId, "approve-merge"));

    expect(rows(second, runId, "update-backoff")).toBe(backoffs);
    expect(rows(second, runId, "stuck-behind")).toBe(1);
    expect(rows(second, runId, "update-branch")).toBe(updates + 1);
    await vi.waitFor(() => expect(second.gates.get(gateId(runId, "stuck-behind"))?.status).toBe("resolved"));
  });
});
