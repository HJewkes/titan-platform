import { CONFIG_PATH } from "@titan-design/fix-proof";
import { fakeSha, type PrFile } from "@titan-design/github";
import { EXIT } from "@titan-design/registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture, shepherdRuns, type ShepherdFixture } from "../test-support/shepherd.js";
import type { Registered } from "./commands.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { TEST_ONLY_HINT } from "./register-kind.js";

// Stands in for slice f deleting TEST_ONLY_GATED: with `live` set, a move into test-only meets the guard the flag holds back.
const gate = vi.hoisted(() => ({ live: true }));
vi.mock("./task-kind.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./task-kind.js")>();
  return {
    ...real,
    kindMoveRefusal: (...args: Parameters<typeof real.kindMoveRefusal>) => {
      const refusal = real.kindMoveRefusal(...args);
      return gate.live && refusal?.includes("cannot move to test-only yet") ? real.testOnlyMoveRefusal(args[0], args[2]) : refusal;
    },
  };
});

const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  gate.live = true;
});

const MERGE_BASE = fakeSha("merge-base");
const CONFIG = JSON.stringify({ tests: ["{packages,products,apps}/*/src/**/*.test.{ts,tsx}"], carry: ["**/test-support/**"] });
const pr1 = { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" };
const added = (path: string): PrFile => ({ path, status: "added" });
const TESTS_ONLY = [added(".changeset/demo.md"), added("products/demo/src/x.test.ts"), added("products/demo/src/test-support/child.ts")];
const WITH_SOURCE = [added("products/demo/src/x.test.ts"), added("products/demo/src/x.ts")];

interface World extends ShepherdFixture {
  host: FactoryHost;
  call: (args: object) => ReturnType<typeof callCommand<Registered>>;
  storedKind: () => string | undefined;
}

function world(files: PrFile[]): World {
  const fixture = shepherdFixture({ frozen: true });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  fixture.fake.prFiles.set(1, files);
  fixture.fake.compares.set(`main...${H1}`, { mergeBaseSha: MERGE_BASE, files: [] });
  for (const ref of [MERGE_BASE, "main"]) fixture.fake.files.set(`${ref}:${CONFIG_PATH}`, { content: CONFIG, blobSha: fakeSha(ref) });
  const call = (args: object) => callCommand<Registered>(host, fixture.routes, "shepherd.register", args);
  return { ...fixture, host, call, storedKind: () => fixture.routes.shepherd!.store.get().byPr(REPO, 1)?.kind };
}

async function registered(w: World, args: object): Promise<Registered> {
  const envelope = await w.call(args);
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data;
}

/** A correctness registration whose run has failed, so a repeat register takes the restart path. */
async function failedCorrectness(w: World): Promise<string> {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", branch: BRANCH, policy: JSON.stringify(OWNER_GATE_POLICY), task: "demo/T-1", after: "not json" });
  await w.host.runtime.wait(runId);
  w.routes.shepherd!.store.get().register({ ...pr1, branch: BRANCH, runId, policy: OWNER_GATE_POLICY, kind: "correctness" });
  return runId;
}

describe("shepherd register --kind test-only on a live run", () => {
  it("refuses a source change with exit 65, names the path and keeps the kind correctness", async () => {
    const w = world(WITH_SOURCE);
    await registered(w, pr1);

    const envelope = await w.call({ ...pr1, kind: "test-only" });

    expect(envelope).toMatchObject({ ok: false, code: EXIT.DATAERR, error: expect.stringContaining("non-test source products/demo/src/x.ts") });
    expect(w.storedKind()).toBe("correctness");
  });

  it("moves a tests-only PR to test-only", async () => {
    const w = world(TESTS_ONLY);
    await registered(w, pr1);

    const again = await registered(w, { ...pr1, kind: "test-only" });

    expect(again.registration.kind).toBe("test-only");
  });
});

describe("shepherd register --kind test-only on a failed run", () => {
  it("refuses a source change before the run is replaced, naming the path", async () => {
    const w = world(WITH_SOURCE);
    const failedRunId = await failedCorrectness(w);

    const envelope = await w.call({ ...pr1, kind: "test-only" });

    expect(envelope).toMatchObject({ ok: false, code: EXIT.DATAERR, error: expect.stringContaining("non-test source products/demo/src/x.ts") });
    expect(shepherdRuns(w.host)).toEqual([failedRunId]);
    expect(w.storedKind()).toBe("correctness");
  });

  it("restarts a tests-only PR as test-only", async () => {
    const w = world(TESTS_ONLY);
    const failedRunId = await failedCorrectness(w);

    const again = await registered(w, { ...pr1, kind: "test-only" });

    expect(again).toMatchObject({ created: true, previousRunId: failedRunId, registration: { kind: "test-only" } });
  });
});

describe("shepherd register hints at test-only", () => {
  it("hints when a defaulted correctness registration is on a tests-only PR", async () => {
    const w = world(TESTS_ONLY);

    expect(await registered(w, pr1)).toMatchObject({ registration: { kind: "correctness" }, kindHint: TEST_ONLY_HINT });
  });

  it("gives no hint on a PR with a source change", async () => {
    const w = world(WITH_SOURCE);

    expect(await registered(w, { ...pr1, kind: "correctness" })).not.toHaveProperty("kindHint");
  });

  it("gives no hint while the guard still refuses every move into test-only", async () => {
    gate.live = false;
    const w = world(TESTS_ONLY);

    expect(await registered(w, pr1)).not.toHaveProperty("kindHint");
  });
});
