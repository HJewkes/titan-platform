import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { sleep } from "../workflows/land.js";
import { shepherdEventMigration } from "./events.js";
import { FreezeStore, freezeCancelOnlyMigration, freezeFixPrMigration, freezeGuard, freezeMigration, type FreezeStoreRef } from "./freeze.js";
import { formatShepherd } from "./format.js";
import { repoFreezeCommand } from "./repo-freeze-command.js";
import { repoFreezeMigration } from "./repo-freeze.js";
import type { ShepherdServices } from "./services.js";
import { shepherdMigration, shepherdStoreRef, ShepherdStore } from "./store.js";

const RED = fakeSha("repo-freeze-red");
const GREEN = fakeSha("repo-freeze-green");
const REASON = "version packages merges first";

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function landingWorld() {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: shepherdStoreRef(), sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { fake, host, freezes: () => routes.shepherd!.freeze!.get() };
}

function freezeRig() {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), freezeMigration(6), freezeCancelOnlyMigration(12), shepherdEventMigration(16), freezeFixPrMigration(23), repoFreezeMigration(33)]);
  const freezes = new FreezeStore(db, () => Date.parse("2026-10-18T00:00:00Z"));
  const guard = freezeGuard({ freezes: () => freezes, registrations: () => new ShepherdStore(db) });
  const reason = () => guard.reason(githubPort(fakeGitHub().wire), REPO, 1, "main");
  return { freezes, reason };
}

describe("a coordinator's repo freeze", () => {
  it("keeps a ready-to-merge run from merging until the repo is unfrozen, then merges it", async () => {
    const w = landingWorld();
    w.fake.addPr({ headSha: H1 });
    w.freezes().repoFreezes.freeze(REPO, REASON, "coordinator");
    const runId = w.host.runtime.start("land-pr", { repo: REPO, pr: "1" });

    await gateOpened(w.host, gateId(runId, "approve-merge", 0));
    w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toBe("merge:0"));
    await sleep(100, new AbortController().signal);
    const whileFrozen = { merges: w.fake.effects.merge, status: w.host.runtime.status(runId)?.status };
    w.freezes().repoFreezes.unfreeze(REPO);
    await w.host.runtime.wait(runId);

    expect(whileFrozen).toEqual({ merges: 0, status: "running" });
    expect(w.fake.effects.merge).toBe(1);
  });

  it("stays independent of the main-red freeze: lifting either leaves the other holding", async () => {
    const r = freezeRig();
    const { episode } = r.freezes.freeze(REPO, RED);
    r.freezes.repoFreezes.freeze(REPO, REASON, "coordinator");

    r.freezes.repoFreezes.unfreeze(REPO);
    const afterManualLift = await r.reason();
    r.freezes.repoFreezes.freeze(REPO, REASON, "coordinator");
    r.freezes.release(REPO, episode, "owner");
    const afterRedThaw = await r.reason();
    r.freezes.repoFreezes.unfreeze(REPO);

    expect(afterManualLift).toMatch(/main is red/);
    expect(afterRedThaw).toMatch(/frozen by coordinator since .*: version packages merges first/);
    expect(await r.reason()).toBeUndefined();
    expect(r.freezes.unfreeze(REPO, GREEN)).toBe(false);
  });

  it("replaces the reason on a repeat freeze, keeps its start, and refuses an empty reason", () => {
    const r = freezeRig();
    const first = r.freezes.repoFreezes.freeze(REPO, REASON, "coordinator");

    const again = r.freezes.repoFreezes.freeze(REPO.toUpperCase(), "release train", "seat");

    expect(again).toEqual({ repo: REPO, reason: "release train", actor: "seat", since: first.since });
    expect(() => r.freezes.repoFreezes.freeze(REPO, "  ", "seat")).toThrow(/reason/);
    expect(r.freezes.repoFreezes.list()).toHaveLength(1);
  });

  it("survives reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-freeze-"));
    dirs.push(dir);
    const path = join(dir, "factory.db");
    const first = openDatabase(path);
    runMigrations(first, [freezeMigration(6), repoFreezeMigration(33)]);
    new FreezeStore(first).repoFreezes.freeze(REPO, REASON, "coordinator");
    first.close();

    const reopened = openDatabase(path);
    const frozen = new FreezeStore(reopened).repoFreezes.get(REPO);
    reopened.close();

    expect(frozen).toMatchObject({ repo: REPO, reason: REASON, actor: "coordinator" });
  });
});

describe("shepherd.freeze", () => {
  const ctxOf = (freezes: FreezeStore) => partialFake<FactoryContext>({ shepherd: partialFake<ShepherdServices>({ freeze: partialFake<FreezeStoreRef>({ get: () => freezes }) }) });

  it("answers an unfreeze of a repo that is not frozen with a message, not an error", async () => {
    const ctx = ctxOf(freezeRig().freezes);

    const result = await repoFreezeCommand.run({ action: "unfreeze", repo: REPO }, ctx);

    expect(result).toEqual({ changed: false, detail: `${REPO} was not frozen; nothing changed`, freezes: [] });
    expect(formatShepherd("shepherd.freeze", result)).toBe(`${REPO} was not frozen; nothing changed\nno repo freezes\n`);
  });

  it("refuses a freeze with a blank reason before anything is written", () => {
    expect(repoFreezeCommand.args.safeParse({ action: "freeze", repo: REPO, reason: "   " }).success).toBe(false);
  });

  it("lists the freeze with its repo, reason, setter and start", async () => {
    const ctx = ctxOf(freezeRig().freezes);

    const result = await repoFreezeCommand.run({ action: "freeze", repo: REPO, reason: REASON, actor: "coordinator" }, ctx);

    expect(formatShepherd("shepherd.freeze", result)).toContain(`${REPO}  ${REASON} (by coordinator, since 2026-10-18T00:00:00.000Z)`);
  });
});
