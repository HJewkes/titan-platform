import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { ShepherdStore, shepherdMigration, shepherdStoreRef, type RegistrationInput } from "./store.js";

function openStore(): ShepherdStore {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4)]);
  return new ShepherdStore(db, () => Date.parse("2026-01-01T00:00:00Z"));
}

const base: RegistrationInput = { repo: "octo/demo", pr: 7, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY };

describe("shepherd registration store", () => {
  it("stores a registration without a kind as unknown", () => {
    const store = openStore();

    const registration = store.register(base);

    expect(registration).toMatchObject({ repo: "octo/demo", pr: 7, branch: null, kind: "unknown", held: false, reviewer: null, policy: OWNER_GATE_POLICY });
  });

  it("refuses a kind outside the known set instead of treating it as unknown", () => {
    expect(() => openStore().register({ ...base, kind: "hotfix" })).toThrow();
  });

  it("keeps the kind and the effective policy it was given", () => {
    const policy: EffectivePolicy = { merge: "never", mergeMethod: "rebase", reviewer: "rev-a", fixer: true, seat: "demo-seat" };

    const registration = openStore().register({ ...base, kind: "correctness", policy });

    expect(registration).toMatchObject({ kind: "correctness", policy });
  });

  it("allows one registration per PR and one per branch in a repo", () => {
    const store = openStore();
    store.register(base);
    store.register({ ...base, pr: undefined, branch: "feat/a", runId: "run-2" });

    expect(() => store.register({ ...base, runId: "run-3" })).toThrow(/UNIQUE/);
    expect(() => store.register({ ...base, pr: undefined, branch: "feat/a", runId: "run-4" })).toThrow(/UNIQUE/);
    expect(() => store.register({ ...base, repo: "octo/other", runId: "run-5" })).not.toThrow();
  });

  it("refuses a registration with neither a PR nor a branch", () => {
    expect(() => openStore().register({ ...base, pr: undefined })).toThrow(/pr or a branch/);
  });

  it("records the PR a branch registration was waiting for, and refuses an unregistered run", () => {
    const store = openStore();
    store.register({ ...base, pr: undefined, branch: "feat/a" });

    store.setPr("run-1", 12);

    expect(store.byPr("octo/demo", 12)?.branch).toBe("feat/a");
    expect(() => store.setPr("run-9", 13)).toThrow(/no registration/);
  });

  it("reports a hold on any spelling of the repo until it is released", () => {
    const store = openStore();
    store.register(base);

    store.hold("run-1", "owner review");
    const held = store.heldReason("Octo/Demo", 7);
    store.release("run-1");

    expect(held).toBe("owner review");
    expect(store.heldReason("octo/demo", 7)).toBeUndefined();
    expect(store.heldReason("octo/demo", 8)).toBeUndefined();
  });
});

describe("shepherd store ref", () => {
  it("throws while unbound, so a guard reading it fails closed", () => {
    expect(() => shepherdStoreRef().get()).toThrow(/not bound/);
  });

  it("refuses a second bind until the first is released", () => {
    const ref = shepherdStoreRef();
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4)]);
    const unbind = ref.bind(db);

    expect(() => ref.bind(db)).toThrow(/already bound/);
    unbind();
    expect(() => ref.get()).toThrow(/not bound/);
  });
});
