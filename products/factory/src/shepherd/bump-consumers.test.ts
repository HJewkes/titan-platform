import { fakeSha, type RepoSlug } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { CONSUMER_A, CONSUMER_B, CONSUMER_C, CONSUMER_DENIED, CONSUMER_SEATS, consumerBumpWorld, type ConsumerBumpWorld } from "../test-support/consumer-bump.js";
import { shepherdFixture } from "../test-support/shepherd.js";
import { planConsumerBumps } from "./bump-consumers.js";
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
