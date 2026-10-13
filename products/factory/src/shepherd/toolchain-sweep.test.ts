import { fakeSha } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { LEAKY_MESSAGE, expectNoLeak } from "../test-support/leak.js";
import { shepherdFixture, shepherdRuns } from "../test-support/shepherd.js";
import { ADOPTION_BRANCH, DRIFTED, toolchainWorld, type ToolchainWorld } from "../test-support/toolchain.js";
import { TOOLCHAIN_CONSUMERS } from "../workflows/toolchain-fanout.js";
import { TOOLCHAIN_IMPLEMENTER } from "./commands.js";
import type { ShepherdServices } from "./services.js";
import { sweepToolchain } from "./toolchain-sweep.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World extends ToolchainWorld {
  host: FactoryHost;
  services: ShepherdServices;
}

function world(): World {
  const github = toolchainWorld();
  const fixture = shepherdFixture({ frozen: true, port: github.port });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  return { ...github, host, services: fixture.routes.shepherd! };
}

const drifted = (w: World) => w.fakes.get(DRIFTED)!;

describe("sweepToolchain", () => {
  it("opens one adoption PR for the drifted consumer through the API and registers it with Shepherd, with no fixer", async () => {
    const w = world();

    const notes = await sweepToolchain(w.host, w.services);

    const pr = drifted(w).pr(1);
    const registration = w.services.store.get().byPr(DRIFTED, pr.number);
    expect(notes).toEqual([{ repo: DRIFTED, pr: pr.number, registered: registration?.runId }]);
    expect(pr).toMatchObject({ headRef: ADOPTION_BRANCH, baseRef: "main" });
    expect(drifted(w).effects).toMatchObject({ createRef: 1, createPr: 1 });
    expect(drifted(w).files.get(`${ADOPTION_BRANCH}:.node-version`)?.content).toBe("24.21.0\n");
    expect(drifted(w).files.get(`${ADOPTION_BRANCH}:.github/workflows/ci.yml`)?.content).toContain("node-version-file: .node-version");
    expect(registration).toMatchObject({ task: "codewatch/toolchain", implementer: TOOLCHAIN_IMPLEMENTER, branch: ADOPTION_BRANCH, policy: { fixer: false, merge: "owner-gate", ownerGateReason: "owner-asked" } });
    const aligned = TOOLCHAIN_CONSUMERS.filter(({ repo }) => repo !== DRIFTED).map(({ repo }) => w.fakes.get(repo)!.effects.createPr);
    expect(aligned.every((count) => count === 0)).toBe(true);
  });

  it("opens nothing when the toolchain branch already has an open PR, and leaves its live registration alone", async () => {
    const w = world();
    await sweepToolchain(w.host, w.services);
    const writes = { ...drifted(w).effects };

    const notes = await sweepToolchain(w.host, w.services);

    expect(notes).toEqual([{ repo: DRIFTED, pr: 1, skipped: "open" }]);
    expect(drifted(w).effects).toEqual(writes);
    expect(shepherdRuns(w.host)).toHaveLength(1);
  });

  it("registers an open PR on the toolchain branch that Shepherd does not know yet, without writing to it", async () => {
    const w = world();
    const pr = drifted(w).addPr({ headSha: fakeSha("hand-opened"), headRef: ADOPTION_BRANCH }).number;

    const notes = await sweepToolchain(w.host, w.services);

    expect(notes).toEqual([{ repo: DRIFTED, pr, skipped: "open", registered: w.services.store.get().byPr(DRIFTED, pr)?.runId }]);
    expect(drifted(w).effects).toMatchObject({ createRef: 0, putContent: 0, createPr: 0 });
  });

  it("skips a closed PR on the toolchain branch with no write at all", async () => {
    const w = world();
    const pr = drifted(w).addPr({ headSha: fakeSha("closed"), headRef: ADOPTION_BRANCH, state: "closed" }).number;

    const notes = await sweepToolchain(w.host, w.services);

    expect(notes).toEqual([{ repo: DRIFTED, pr, skipped: "closed" }]);
    expect(drifted(w).effects).toMatchObject({ createRef: 0, updateRef: 0, putContent: 0, createPr: 0 });
    expect(shepherdRuns(w.host)).toHaveLength(0);
  });

  it("leaves an existing toolchain branch with no PR where it is, then opens the PR on it", async () => {
    const w = world();
    drifted(w).refs.set(ADOPTION_BRANCH, fakeSha("existing-branch"));

    const notes = await sweepToolchain(w.host, w.services);

    expect(drifted(w).effects).toMatchObject({ createRef: 0, createPr: 1 });
    expect(notes).toEqual([{ repo: DRIFTED, pr: 1, registered: expect.any(String) }]);
    expect(drifted(w).pr(1)).toMatchObject({ headRef: ADOPTION_BRANCH });
  });

  it("creates the toolchain branch when it does not exist", async () => {
    const w = world();
    expect(drifted(w).refs.has(ADOPTION_BRANCH)).toBe(false);

    await sweepToolchain(w.host, w.services);

    expect(drifted(w).effects.createRef).toBe(1);
    expect(drifted(w).refs.has(ADOPTION_BRANCH)).toBe(true);
  });

  it("notes a consumer it could not read, by status only, and still opens the drifted consumer's PR", async () => {
    const w = world();
    const broken = TOOLCHAIN_CONSUMERS[0]!.repo;
    w.fakes.get(broken)!.readFaults.getDefaultBranch = [Object.assign(new Error(LEAKY_MESSAGE), { status: 502 })];

    const notes = await sweepToolchain(w.host, w.services);

    expect(notes).toEqual([{ repo: broken, error: "HTTP 502" }, { repo: DRIFTED, pr: 1, registered: expect.any(String) }]);
    expectNoLeak(notes);
  });

  it("notes a failed PR open on its repo and goes on to the next drifted consumer", async () => {
    const w = world();
    const first = TOOLCHAIN_CONSUMERS[0]!.repo;
    w.fakes.get(first)!.files.set("main:.node-version", { content: "20.0.0\n", blobSha: fakeSha("old-node") });

    const notes = await sweepToolchain(w.host, w.services);

    expect(notes).toEqual([{ repo: first, error: expect.any(String) }, { repo: DRIFTED, pr: 1, registered: expect.any(String) }]);
    expect(w.fakes.get(first)!.effects.createPr).toBe(0);
  });
});
