import { fakeSha, type RepoSlug } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { CONSUMER_A, CONSUMER_B, CONSUMER_C, CONSUMER_DENIED, CONSUMER_SEATS, REGENERATED_MARK, consumerBumpWorld, pushBranchCommit, seedLeftoverBranch, type ConsumerBumpWorld } from "../test-support/consumer-bump.js";
import { shepherdFixture } from "../test-support/shepherd.js";
import { bumpConsumers, planConsumerBumps } from "./bump-consumers.js";
import { BUMP_BRANCH_PREFIX, bumpBranch, consumerBumpImplementer } from "./consumer-bump.js";
import { bumpCommitMessage } from "./leftover-bump.js";
import { RegisterArgs, policyFor } from "./register-args.js";
import { registerConsumerBump } from "./self-register.js";
import type { ShepherdServices } from "./services.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World extends ConsumerBumpWorld {
  host: FactoryHost;
  services: ShepherdServices;
}

function world(options: Parameters<typeof consumerBumpWorld>[0] = {}): World {
  const github = consumerBumpWorld(options);
  const fixture = shepherdFixture({ frozen: true, port: github.port, seats: CONSUMER_SEATS, prFiles: async ({ repo, pr }) => github.port.listPrFiles(repo, pr) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  return { ...github, host, services: fixture.routes.shepherd! };
}

/** A same-repo PR on `headRef` that edits `paths` in place, the shape a bump PR has. */
function bumpShapedPr(w: World, repo: RepoSlug, headRef: string, paths = ["package.json", "pnpm-lock.yaml"]) {
  const fake = w.fakes.get(repo)!;
  const pr = fake.addPr({ headSha: fakeSha(`${repo}:${headRef}`), headRef });
  fake.prFiles.set(pr.number, paths.map((path) => ({ path, status: "modified" })));
  return pr;
}

const writes = (w: World) => [...w.fakes.values()].map(({ effects }) => effects.createRef + effects.putContent + effects.createPr);

describe("planConsumerBumps", () => {
  it("a repo whose only titan deps were left alone is noted with the reasons, not as current", async () => {
    const w = world();
    const manifest = JSON.stringify({ name: "consumer-c", dependencies: { "@titan-design/example-c": "workspace:*" } });
    w.fakes.get(CONSUMER_C)!.files.set("main:package.json", { content: manifest, blobSha: fakeSha("left-alone") });

    const { notes } = await planConsumerBumps(w.services, w.registry, [CONSUMER_C]);

    expect(notes).toEqual([{ repo: CONSUMER_C, leftAlone: [{ path: "package.json", name: "@titan-design/example-c", spec: "workspace:*", reason: expect.any(String) }] }]);
  });

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
  it("registers each bump under its own implementer and policyFor of its own consumer seat, which grants the fixer, and no forced owner-gate", async () => {
    const w = world();
    const ctx = { warnings: [], format: "json" as const, host: w.host, shepherd: w.services };
    const { bumps } = await planConsumerBumps(w.services, w.registry);

    const policies = new Map<RepoSlug, unknown>();
    for (const { repo, branch } of bumps) {
      const pr = bumpShapedPr(w, repo, branch).number;
      const { runId } = await registerConsumerBump(ctx, repo, pr);
      const registration = w.services.store.get().byPr(repo, pr);
      const seatPolicy = policyFor(w.services.seats, RegisterArgs.parse({ repo, pr, task: "t", implementer: "i" }));
      expect(registration).toMatchObject({ runId, implementer: consumerBumpImplementer(repo, pr), branch, policy: seatPolicy });
      policies.set(repo, registration?.policy);
    }

    expect(policies.get(CONSUMER_A)).toMatchObject({ seat: "seat-a", merge: "auto", fixer: true });
    expect(policies.get(CONSUMER_B)).toMatchObject({ seat: "seat-bc", merge: "owner-gate", fixer: true });
    for (const policy of policies.values()) expect(policy).not.toHaveProperty("ownerGateReason");
  });
  it("refuses a fork head or a branch outside the bump prefix, whatever files it changes", async () => {
    const w = world();
    const ctx = { warnings: [], format: "json" as const, host: w.host, shepherd: w.services };
    const fork = w.fakes.get(CONSUMER_A)!.addPr({ headSha: fakeSha("fork"), headRef: `${BUMP_BRANCH_PREFIX}0badc0de`, headRepo: "stranger/consumer-a" });
    w.fakes.get(CONSUMER_A)!.prFiles.set(fork.number, [{ path: "package.json", status: "modified" }]);
    const topic = bumpShapedPr(w, CONSUMER_A, "topic/package-bump");

    for (const pr of [fork, topic]) await expect(registerConsumerBump(ctx, CONSUMER_A, pr.number)).rejects.toThrow(/is not on a shepherd\/bump-consumers-\* branch/);

    expect(w.services.store.get().byPr(CONSUMER_A, fork.number)).toBeUndefined();
    expect(w.services.store.get().byPr(CONSUMER_A, topic.number)).toBeUndefined();
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
    for (const note of notes.slice(0, 2)) expect(w.services.store.get().byPr(note.repo, note.pr!)).toMatchObject({ runId: note.registered, implementer: consumerBumpImplementer(note.repo, note.pr!) });
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

  it("registers a stale open bump PR when the repo plans as current", async () => {
    const w = world();
    const stale = bumpShapedPr(w, CONSUMER_C, `${BUMP_BRANCH_PREFIX}0badc0de`);

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes[2]).toEqual({ repo: CONSUMER_C, pr: stale.number, skipped: "open", registered: expect.any(String) });
    expect(w.services.store.get().byPr(CONSUMER_C, stale.number)).toMatchObject({ runId: notes[2]!.registered, implementer: consumerBumpImplementer(CONSUMER_C, stale.number) });
    expect(w.fakes.get(CONSUMER_C)!.effects).toMatchObject({ createRef: 0, putContent: 0, createPr: 0 });
  });

  it("registers an open bump PR on a repo whose tree read fails", async () => {
    const w = world({ getFileThrows: CONSUMER_A });
    const open = bumpShapedPr(w, CONSUMER_A, `${BUMP_BRANCH_PREFIX}0badc0de`);

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes[0]).toEqual({ repo: CONSUMER_A, pr: open.number, skipped: "open", registered: expect.any(String) });
    expect(w.services.store.get().byPr(CONSUMER_A, open.number)?.runId).toBe(notes[0]!.registered);
    expect(notes[1]).toMatchObject({ repo: CONSUMER_B, registered: expect.any(String) });
  });

  it("never registers a same-repo PR on a bump branch that changes more than manifests and lockfiles", async () => {
    const w = world();
    const imposter = bumpShapedPr(w, CONSUMER_C, `${BUMP_BRANCH_PREFIX}0badc0de`, ["package.json", ".github/workflows/release.yml"]);
    const renamed = bumpShapedPr(w, CONSUMER_A, `${BUMP_BRANCH_PREFIX}0badc0de`, []);
    w.fakes.get(CONSUMER_A)!.prFiles.set(renamed.number, [{ path: "package.json", previousPath: "scripts/postinstall.json", status: "renamed" }]);

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes.find(({ repo }) => repo === CONSUMER_C)).toEqual({ repo: CONSUMER_C, error: "Error" });
    expect(notes.find(({ repo }) => repo === CONSUMER_A)).toEqual({ repo: CONSUMER_A, error: "Error" });
    expect(w.services.store.get().byPr(CONSUMER_C, imposter.number)).toBeUndefined();
    expect(w.services.store.get().byPr(CONSUMER_A, renamed.number)).toBeUndefined();
  });

  it("classes a bump registration through G10, so a manifest on a guarded path is held", async () => {
    const w = world();
    const guarded = bumpShapedPr(w, CONSUMER_C, `${BUMP_BRANCH_PREFIX}0badc0de`, ["packages/authority/package.json"]);

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes.find(({ repo }) => repo === CONSUMER_C)).toMatchObject({ pr: guarded.number, skipped: "open", registered: expect.any(String) });
    expect(w.services.store.get().byPr(CONSUMER_C, guarded.number)?.holdReason).toMatch(/^g10-adversary: authority/);
  });

  it("never registers a fork PR under a bump branch name and bumps the repo as usual", async () => {
    const w = world();
    const fork = w.fakes.get(CONSUMER_A)!.addPr({ headSha: fakeSha("fork"), headRef: `${BUMP_BRANCH_PREFIX}0badc0de`, headRepo: "stranger/consumer-a" });

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(w.services.store.get().byPr(CONSUMER_A, fork.number)).toBeUndefined();
    expect(notes[0]).toEqual({ repo: CONSUMER_A, pr: expect.any(Number), registered: expect.any(String) });
    expect(notes[0]!.pr).not.toBe(fork.number);
    expect(w.fakes.get(CONSUMER_A)!.effects.createPr).toBe(1);
  });

  it("refuses a fork PR that holds the planned bump branch", async () => {
    const w = world();
    const { bumps } = await planConsumerBumps(w.services, w.registry);
    const fork = w.fakes.get(CONSUMER_A)!.addPr({ headSha: fakeSha("fork"), headRef: bumps[0]!.branch, headRepo: "stranger/consumer-a" });

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes[0]).toEqual({ repo: CONSUMER_A, error: "Error" });
    expect(w.services.store.get().byPr(CONSUMER_A, fork.number)).toBeUndefined();
    expect(w.fakes.get(CONSUMER_A)!.effects).toMatchObject({ createRef: 0, putContent: 0, createPr: 0 });
  });

  /** CONSUMER_A's planned branch, made from main with no PR and one commit on it. */
  async function leftoverWith(w: World, commit: { authorLogin: string; message: string }, files: Record<string, string>): Promise<string> {
    const { bumps } = await planConsumerBumps(w.services, w.registry);
    const fake = w.fakes.get(CONSUMER_A)!;
    seedLeftoverBranch(fake, bumps[0]!.branch);
    pushBranchCommit(fake, bumps[0]!.branch, { ...commit, committerLogin: commit.authorLogin }, files);
    return bumps[0]!.branch;
  }

  it("sweep-only leftover branch is reused: the fresh bump goes on top and its PR opens", async () => {
    const w = world();
    const fake = w.fakes.get(CONSUMER_A)!;
    const branch = await leftoverWith(w, { authorLogin: fake.actor, message: bumpCommitMessage("package.json") }, { "package.json": "{}\n" });

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes[0]).toMatchObject({ repo: CONSUMER_A, pr: expect.any(Number), registered: expect.any(String) });
    expect(fake.effects).toMatchObject({ createRef: 0, deleteRef: 0, createPr: 1 });
    expect(fake.pr(notes[0]!.pr!).headRef).toBe(branch);
    expect(fake.files.get(`${branch}:package.json`)!.content).toContain('"@titan-design/example-a": "^1.4.0"');
    expect(fake.files.get(`${branch}:pnpm-lock.yaml`)!.content).toContain(REGENERATED_MARK);
  });

  it("sweep-only leftover branch is reused after a sweep crashed before its PR opened", async () => {
    const w = world();
    const fake = w.fakes.get(CONSUMER_A)!;
    const createPr = fake.wire.createPr;
    fake.wire.createPr = async () => Promise.reject(new Error("socket hang up"));
    expect((await bumpConsumers(w.host, w.services, ports(w)))[0]).toEqual({ repo: CONSUMER_A, error: "Error" });
    fake.wire.createPr = createPr;
    const written = fake.effects.putContent;

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes[0]).toMatchObject({ repo: CONSUMER_A, pr: expect.any(Number), registered: expect.any(String) });
    expect(fake.effects).toMatchObject({ createRef: 1, putContent: written, createPr: 1 });
  });

  it("a foreign commit landing on a freshly created branch during the writes stops the PR from opening", async () => {
    const w = world();
    const fake = w.fakes.get(CONSUMER_A)!;
    const putContent = fake.wire.putContent;
    fake.wire.putContent = async (repo, request) => {
      const written = await putContent(repo, request);
      pushBranchCommit(fake, request.branch, { authorLogin: "stranger", committerLogin: "stranger", message: "unrelated change" }, {});
      return written;
    };

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes[0]).toMatchObject({ repo: CONSUMER_A, error: "LeftoverBumpBranchError" });
    expect(fake.effects).toMatchObject({ createRef: 1, createPr: 0 });
  });

  it("branch with a foreign commit stays fail-closed, naming the branch", async () => {
    const w = world();
    const branch = await leftoverWith(w, { authorLogin: "stranger", message: bumpCommitMessage("package.json") }, { "package.json": "{}\n" });

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes[0]).toEqual({ repo: CONSUMER_A, error: "LeftoverBumpBranchError", branch });
    expect(w.fakes.get(CONSUMER_A)!.effects).toMatchObject({ putContent: 0, createPr: 0, deleteRef: 0 });
    expect(notes[1]).toMatchObject({ repo: CONSUMER_B, registered: expect.any(String) });
  });

  it("branch with a sweep commit touching a non-manifest file stays fail-closed", async () => {
    const w = world();
    const fake = w.fakes.get(CONSUMER_A)!;
    const branch = await leftoverWith(w, { authorLogin: fake.actor, message: bumpCommitMessage("package.json") }, { "src/index.ts": "export {};\n" });

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes[0]).toEqual({ repo: CONSUMER_A, error: "LeftoverBumpBranchError", branch });
    expect(fake.effects).toMatchObject({ putContent: 0, createPr: 0, deleteRef: 0 });
  });

  it("branch with a sweep-authored commit whose message is not the sweep's stays fail-closed", async () => {
    const w = world();
    const fake = w.fakes.get(CONSUMER_A)!;
    const branch = await leftoverWith(w, { authorLogin: fake.actor, message: "hand edit" }, { "package.json": "{}\n" });

    const notes = await bumpConsumers(w.host, w.services, ports(w));

    expect(notes[0]).toEqual({ repo: CONSUMER_A, error: "LeftoverBumpBranchError", branch });
    expect(fake.effects).toMatchObject({ putContent: 0, createPr: 0 });
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

  it("a bump PR opened between the open-PR list and the branch check is registered as open, not reported closed", async () => {
    const w = world();
    const { bumps } = await planConsumerBumps(w.services, w.registry);
    const open = bumpShapedPr(w, CONSUMER_A, bumps[0]!.branch);
    const port = { ...w.services.port, listOpenPrs: async () => [] };

    const notes = await bumpConsumers(w.host, { ...w.services, port }, ports(w));

    expect(notes[0]).toMatchObject({ repo: CONSUMER_A, pr: open.number, skipped: "open", registered: expect.any(String) });
    expect(w.fakes.get(CONSUMER_A)!.effects).toMatchObject({ createRef: 0, putContent: 0, createPr: 0 });
    expect(w.services.store.get().byPr(CONSUMER_A, open.number)).toBeDefined();
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

describe("bumpConsumers on a tree with a pnpm patch", () => {
  it("hands the patch file to the lockfile regeneration beside the manifests", async () => {
    const w = world();
    const fake = w.fakes.get(CONSUMER_A)!;
    const root: unknown = JSON.parse(fake.files.get("main:package.json")!.content);
    const patchPath = "patches/example-a@1.2.0.patch";
    fake.files.set("main:package.json", { content: `${JSON.stringify({ ...Object(root), pnpm: { patchedDependencies: { "@titan-design/example-a@1.2.0": patchPath } } }, null, 2)}\n`, blobSha: fakeSha("patched-root") });
    fake.files.set(`main:${patchPath}`, { content: "--- a/index.js\n+++ b/index.js\n", blobSha: fakeSha("patch") });

    await bumpConsumers(w.host, w.services, { registry: w.registry, regen: w.regen });

    const forA = w.regenCalls.find((tree) => tree.files[patchPath] !== undefined);
    expect(forA?.files[patchPath]).toBe("--- a/index.js\n+++ b/index.js\n");
  });
});
