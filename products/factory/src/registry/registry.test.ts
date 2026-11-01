import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStep, type BaseEntry, type FactEntry, type StepEntry } from "./entry.js";
import { openFactoryHost } from "../host.js";
import { defineWorkflow } from "../definition.js";
import { createRegistry, entryFor, pinClassOf, schemaHash } from "./registry.js";
import { abandonsOrphan, factoryRegistry } from "./steps/index.js";

function base(overrides: Partial<BaseEntry> = {}): BaseEntry {
  return defineStep({ name: "check-ci", op: "seed", kind: "software", effect: { class: "read" }, callSites: ["check-ci"], version: { bump: 0 }, ...overrides });
}

function factEntry(overrides: Partial<FactEntry> = {}): FactEntry {
  return defineStep({
    ...base({ name: "ci-wait" }),
    fact: "ci:green",
    input: z.object({ head: z.string() }),
    output: z.object({ green: z.boolean() }),
    materialInputs: [{ fact: "head:pushed", fields: ["sha"] }],
    projection: ["green"],
    idempotencyKey: (input) => JSON.stringify(input),
    body: "products/factory/src/workflows/ci-wait.ts",
    ...overrides,
  });
}

/** A well-typed entry with fields the types forbid patched on, the way a malformed one would reach the registry. */
function loose(entry: StepEntry, patch: object): StepEntry {
  return Object.assign(entry, patch);
}

describe("step registry entries", () => {
  it("an entry naming a fact absent from the pin-class rule file is refused", () => {
    expect(() => createRegistry([factEntry({ fact: "ci:greenish" })])).toThrow(/ci:greenish.*pin-class rule file/);
    expect(() => createRegistry([factEntry({ fact: "toString" })])).toThrow(/pin-class rule file/);
  });

  it("an entry's pin class comes from the rule file, and an entry cannot declare one", () => {
    const entry = factEntry();
    expect(createRegistry([entry]).entries).toEqual([entry]);
    expect(pinClassOf(entry, { visual: false })).toBe("tree");
    expect(() => createRegistry([loose(factEntry(), { pinClass: "diff" })])).toThrow(/pinClass/);
    expect(() => createRegistry([loose(base(), { pinClass: "diff" })])).toThrow(/pinClass/);
  });

  it("owner:approved is tree-pinned on a visual item and diff-pinned otherwise", () => {
    const entry = factEntry({ name: "owner-approve", fact: "owner:approved" });
    expect(pinClassOf(entry, { visual: true })).toBe("tree");
    expect(pinClassOf(entry, { visual: false })).toBe("diff");
  });

  it("claim:ci:green takes the pin class of ci:green", () => {
    expect(pinClassOf(factEntry({ fact: "claim:ci:green" }), { visual: false })).toBe("tree");
    expect(pinClassOf(factEntry({ fact: "redrive:verdict:merge" }), { visual: false })).toBe("diff");
    expect(() => createRegistry([factEntry({ fact: "claim:nothing" })])).toThrow(/pin-class rule file/);
  });

  it("an effect or irreversible entry without a target or reason is refused", () => {
    expect(() => createRegistry([loose(base(), { effect: { class: "effect", reason: "posts a comment" } })])).toThrow(/invalid/);
    expect(() => createRegistry([loose(base(), { effect: { class: "irreversible", target: "pr" } })])).toThrow(/invalid/);
    expect(() => createRegistry([base({ effect: { class: "irreversible", target: "pr", reason: "" } })])).toThrow(/invalid/);
    expect(createRegistry([base({ effect: { class: "effect", target: "pr", reason: "posts a comment" } })]).entries).toHaveLength(1);
  });

  it("two entries with one name are refused", () => {
    expect(() => createRegistry([base(), base({ op: "dispatch" })])).toThrow(/two entries are named "check-ci"/);
  });

  it("an entry without a kind is refused", () => {
    expect(() => createRegistry([loose(base(), { kind: undefined })])).toThrow(/kind/);
  });

  it("the schema hash changes when the output schema gains a field, and not when an entry's name changes", () => {
    const original = schemaHash(factEntry());
    expect(schemaHash(factEntry({ name: "ci-wait-renamed" }))).toBe(original);
    expect(schemaHash(factEntry({ output: z.object({ green: z.boolean(), url: z.string() }) }))).not.toBe(original);
  });

  it("resolves a family call to the longest entry name", () => {
    const registry = createRegistry([base({ name: "ci-wait" }), base({ name: "ci-wait-long" })]);
    expect(entryFor(registry, "ci-wait:2")?.name).toBe("ci-wait");
    expect(entryFor(registry, "ci-wait-long:1")?.name).toBe("ci-wait-long");
    expect(entryFor(registry, "unregistered")).toBeUndefined();
  });
});

describe("abandonsOrphan", () => {
  it("allows dropping the read-only land and observe steps, matched by family", () => {
    expect(["ci-wait:r3:17", "land-rules:r4", "base-check:r4:0", "sh-observe:456a09"].filter(abandonsOrphan)).toHaveLength(4);
  });

  it("refuses steps that write, and ids no entry covers", () => {
    expect(["merge:r4:0", "update-branch:r3:16", "rerun:2", "approve-merge", "sh-landed", "ci-wait-long:1"].filter(abandonsOrphan)).toEqual([]);
  });
});

describe("registered recipes", () => {
  it("A17: recipes call only registered steps: a workflow declaring an unregistered step does not open", () => {
    const unregistered = defineWorkflow({ name: "stray", steps: [{ id: "invented-step", kind: "seed" }], run: async () => undefined });
    const routes = Object.assign([], { database: { extraMigrations: [], bind: () => () => undefined } });

    expect(() => openFactoryHost({ dbPath: ":memory:", workflows: [unregistered], routes, registry: factoryRegistry })).toThrow(/stray.*no registry entry: invented-step/);
  });
});
