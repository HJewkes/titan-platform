import { fakeSha, type RepoSlug } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { CONSUMER_A, CONSUMER_B, CONSUMER_C, CONSUMER_DENIED, CONSUMER_SEATS, REGENERATED_MARK, consumerBumpWorld, type ConsumerBumpWorld } from "../test-support/consumer-bump.js";
import { shepherdFixture } from "../test-support/shepherd.js";
import { bumpConsumers, planConsumerBumps } from "./bump-consumers.js";
import { BUMP_BRANCH_PREFIX, bumpBranch } from "./consumer-bump.js";
import { RegisterArgs, policyFor } from "./register-args.js";
import { CONSUMER_BUMP_IMPLEMENTER, registerConsumerBump } from "./self-register.js";
import type { ShepherdServices } from "./services.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World extends ConsumerBumpWorld {
  host: FactoryHost;
  services: ShepherdServices;
}

function world(options: Parameters<typeof consumerBumpWorld>[0] = {}): World {
  const github = consumerBumpWorld(options);
  const fixture = shepherdFixture({ frozen: true, port: github.port, seats: CONSUMER_SEATS });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  return { ...github, host, services: fixture.routes.shepherd! };
}

const writes = (w: World) => [...w.fakes.values()].map(({ effects }) => effects.createRef + effects.putContent + effects.createPr);

describe("planConsumerBumps", () => {
  it("plans a bump for each behind consumer and notes the current one current", async () => {
    const w = world();

    const { bumps, notes } = await planConsumerBumps(w.services, w.registry);

    expect(bumps.map(({ repo, plan }) => ({ repo, edits: plan.edits.map(({ path, name, from, to }) => ({ path, name, from, to })) }))).toEqual([
      {
        repo: CONSUMER_A,
        edits: [
          { path: "package.json", name: "@titan-design/example-a", from: "^1.2.0", to: "^1.4.0" },
          { path: "packages/app/package.json", name: "@titan-design/example-b", from: "~0.9.0", to: "~0.10.0" },
        ],
      },
      { repo: CONSUMER_B, edits: [{ path: "package.json", name: "@titan-design/example-b", from: "0.9.1", to: "0.10.0" }] },
    ]);
    for (const bump of bumps) expect(bump).toMatchObject({ tree: { ref: "main" }, branch: bumpBranch(bump.plan.edits) });
    expect(bumps[0]!.branch.startsWith(BUMP_BRANCH_PREFIX)).toBe(true);
    expect(notes).toEqual([{ repo: CONSUMER_C, current: true }]);
    expect(writes(w).every((count) => count === 0)).toBe(true);
  });

  it("never reads a repo the seat book denies", async () => {
    const w = world();

    const { bumps, notes } = await planConsumerBumps(w.services, w.registry);

    expect(w.fakes.get(CONSUMER_DENIED)!.calls).toEqual([]);
    expect([...bumps, ...notes].map(({ repo }) => repo)).not.toContain(CONSUMER_DENIED);
  });

  it("keeps planning B when A's getFile throws", async () => {
    const w = world({ getFileThrows: CONSUMER_A });

    const { bumps, notes } = await planConsumerBumps(w.services, w.registry);

    expect(notes).toEqual([{ repo: CONSUMER_A, error: expect.any(String) }, { repo: CONSUMER_C, current: true }]);
    expect(bumps.map(({ repo }) => repo)).toEqual([CONSUMER_B]);
  });
});

describe("registerConsumerBump", () => {
  it("registers each bump under policyFor of its own consumer seat, fixer false and no forced owner-gate", async () => {
    const w = world();
    const ctx = { warnings: [], format: "json" as const, host: w.host, shepherd: w.services };
    const { bumps } = await planConsumerBumps(w.services, w.registry);

    const policies = new Map<RepoSlug, unknown>();
    for (const { repo, branch } of bumps) {
      const pr = w.fakes.get(repo)!.addPr({ headSha: fakeSha(repo), headRef: branch }).number;
      const { runId } = await registerConsumerBump(ctx, repo, pr);
      const registration = w.services.store.get().byPr(repo, pr);
      const seatPolicy = policyFor(w.services.seats, RegisterArgs.parse({ repo, pr, task: "t", implementer: "i", policy: { fixer: false } }));
      expect(registration).toMatchObject({ runId, implementer: CONSUMER_BUMP_IMPLEMENTER, branch, policy: seatPolicy });
      policies.set(repo, registration?.policy);
    }

    expect(policies.get(CONSUMER_A)).toMatchObject({ seat: "seat-a", merge: "auto", fixer: false });
    expect(policies.get(CONSUMER_B)).toMatchObject({ seat: "seat-bc", merge: "owner-gate", fixer: false });
    for (const policy of policies.values()) expect(policy).not.toHaveProperty("ownerGateReason");
  });
});

describe("bumpConsumers", () => {
  const branchFile = (w: World, repo: RepoSlug, branch: string, path: string) => w.fakes.get(repo)!.files.get(`${branch}:${path}`)?.content;
  const ports = (w: World) => ({ registry: w.registry, regen: w.regen });

  it("opens one PR each for two behind consumers with raised specifiers and the regenerated lockfile, and none for the current one", async () => {
    const w = world();
    const { bumps } = await planConsumerBumps(w.services, w.registry);
    const [branchA, branchB] = bumps.map(({ branch }) => branch);

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes).toEqual([
      { repo: CONSUMER_A, pr: expect.any(Number), registered: expect.any(String) },
      { repo: CONSUMER_B, pr: expect.any(Number), registered: expect.any(String) },
      { repo: CONSUMER_C, current: true },
    ]);
    expect(branchFile(w, CONSUMER_A, branchA!, "package.json")).toContain(`"@titan-design/example-a": "^1.4.0"`);
    expect(branchFile(w, CONSUMER_A, branchA!, "packages/app/package.json")).toContain(`"@titan-design/example-b": "~0.10.0"`);
    expect(branchFile(w, CONSUMER_A, branchA!, "pnpm-lock.yaml")).toMatch(new RegExp(`${REGENERATED_MARK}$`));
    expect(branchFile(w, CONSUMER_B, branchB!, "package.json")).toContain(`"@titan-design/example-b": "0.10.0"`);
    expect(branchFile(w, CONSUMER_B, branchB!, "package-lock.json")).toMatch(new RegExp(`${REGENERATED_MARK}$`));
    expect(w.regenCalls.map((tree) => tree.files["package.json"])).toEqual([branchFile(w, CONSUMER_A, branchA!, "package.json"), branchFile(w, CONSUMER_B, branchB!, "package.json")]);
    expect([...w.fakes].map(([repo, fake]) => [repo, fake.effects.createPr])).toEqual([[CONSUMER_A, 1], [CONSUMER_B, 1], [CONSUMER_C, 0], [CONSUMER_DENIED, 0]]);
    const prA = await w.services.port.getPr(CONSUMER_A, notes[0]!.pr!);
    expect(prA).toMatchObject({ headRef: branchA, baseRef: "main" });
    for (const note of notes.slice(0, 2)) expect(w.services.store.get().byPr(note.repo, note.pr!)).toMatchObject({ runId: note.registered, implementer: CONSUMER_BUMP_IMPLEMENTER });
  });

  it("lists each raised name and each left-alone pair in the PR body", async () => {
    const w = world();

    await bumpConsumers(w.host, w.services, ports(w));
    const opened = w.openedBodies;

    expect(opened[0]).toContain("- `@titan-design/example-a`: ^1.2.0 → ^1.4.0 (`package.json`)");
    expect(opened[0]).toContain("- `@titan-design/example-b`: ~0.9.0 → ~0.10.0 (`packages/app/package.json`)");
    expect(opened[0]).toContain("Left alone:\n- `@titan-design/example-c`: workspace:* (`packages/app/package.json`, workspace: specifier)");
    expect(opened[1]).not.toContain("Left alone");
  });

  it("opens none and keeps the same runIds on a rerun", async () => {
    const w = world();
    const first = await bumpConsumers(w.host, w.services, ports(w));

    const second = await bumpConsumers(w.host, w.services, ports(w));

    expect(second).toEqual([
      { repo: CONSUMER_A, pr: first[0]!.pr, skipped: "open" },
      { repo: CONSUMER_B, pr: first[1]!.pr, skipped: "open" },
      { repo: CONSUMER_C, current: true },
    ]);
    for (const note of first.slice(0, 2)) expect(w.services.store.get().byPr(note.repo, note.pr!)?.runId).toBe(note.registered);
    expect([...w.fakes.values()].map(({ effects }) => effects.createPr + effects.createRef)).toEqual([2, 2, 0, 0]);
    expect(w.regenCalls).toHaveLength(2);
  });

  it("does not reopen a closed bump PR", async () => {
    const w = world();
    const { bumps } = await planConsumerBumps(w.services, w.registry);
    const closed = w.fakes.get(CONSUMER_A)!.addPr({ headSha: fakeSha("rejected"), headRef: bumps[0]!.branch, state: "closed" });

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes[0]).toEqual({ repo: CONSUMER_A, pr: closed.number, skipped: "closed" });
    expect(w.fakes.get(CONSUMER_A)!.effects).toMatchObject({ createRef: 0, putContent: 0, createPr: 0 });
    expect(w.services.store.get().byPr(CONSUMER_A, closed.number)).toBeUndefined();
    expect(notes[1]).toMatchObject({ repo: CONSUMER_B, registered: expect.any(String) });
  });

  it("creates no branch when the lockfile regen fails", async () => {
    const w = world({ regenFails: true });

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes).toEqual([
      { repo: CONSUMER_A, error: "Error" },
      { repo: CONSUMER_B, error: "Error" },
      { repo: CONSUMER_C, current: true },
    ]);
    expect(w.regenCalls).toHaveLength(2);
    expect(writes(w).every((count) => count === 0)).toBe(true);
  });
});
