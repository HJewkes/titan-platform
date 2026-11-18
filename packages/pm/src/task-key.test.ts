import { describe, expect, it } from "vitest";
import { resolveTaskKey, type TaskKeyIndex } from "./task-key.js";

const INDEX: TaskKeyIndex = {
  tasks: [
    { id: "AL-7", initiative: "alpha" },
    { id: "BE-3", initiative: "beta" },
    { id: "BE-9", initiative: "beta" },
    { id: "BE-9", initiative: "gamma" },
    { id: "XX-1", initiative: "alpha" },
    { id: "XX-1", initiative: "beta" },
  ],
  prefixes: [
    { initiative: "alpha", taskPrefix: "AL" },
    { initiative: "beta", taskPrefix: "BE" },
    { initiative: "gamma", taskPrefix: "GA" },
  ],
};

describe("resolveTaskKey", () => {
  it("resolves a bare id to the initiative that holds it", () => {
    expect(resolveTaskKey("AL-7", INDEX)).toEqual({ ok: true, key: "alpha/AL-7", initiative: "alpha", id: "AL-7" });
  });

  it("keeps a key already prefixed with the task's initiative", () => {
    expect(resolveTaskKey("beta/BE-3", INDEX)).toMatchObject({ ok: true, key: "beta/BE-3" });
  });

  it("refuses a wrong prefix and proposes the task's own key instead of fixing it", () => {
    expect(resolveTaskKey("gamma/AL-7", INDEX)).toEqual({ ok: false, reason: "wrong-initiative", detail: "task AL-7 is in alpha, not gamma", proposed: "alpha/AL-7" });
  });

  it("refuses a repo-qualified key whose repo is not the task's initiative, and accepts one that is", () => {
    expect(resolveTaskKey("acme/gamma/AL-7", INDEX)).toMatchObject({ ok: false, reason: "wrong-initiative", proposed: "alpha/AL-7" });
    expect(resolveTaskKey("acme/alpha/AL-7", INDEX)).toMatchObject({ ok: true, key: "alpha/AL-7" });
  });

  it("picks the initiative whose task prefix issued an id that two initiatives hold", () => {
    expect(resolveTaskKey("BE-9", INDEX)).toMatchObject({ ok: true, key: "beta/BE-9" });
    expect(resolveTaskKey("gamma/BE-9", INDEX)).toMatchObject({ ok: true, key: "gamma/BE-9" });
  });

  it("refuses an id two initiatives hold when no prefix owner settles it", () => {
    expect(resolveTaskKey("XX-1", INDEX)).toEqual({ ok: false, reason: "ambiguous", detail: "task XX-1 is in 2 initiatives (alpha, beta)" });
  });

  it("refuses an id no initiative holds", () => {
    expect(resolveTaskKey("alpha/AL-99", INDEX)).toEqual({ ok: false, reason: "not-found", detail: "task AL-99 is in no initiative" });
  });

  it.each(["", "alpha/", "alpha/al-7", "a/b/c/AL-7", "alpha//AL-7", "AL7"])("refuses the malformed key %j", (input) => {
    expect(resolveTaskKey(input, INDEX)).toMatchObject({ ok: false, reason: "malformed" });
  });
});
