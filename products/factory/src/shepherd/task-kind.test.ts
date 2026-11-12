import { describe, expect, it } from "vitest";
import { relativeImports } from "../test-support/relative-imports.js";
import { kindMoveRefusal, TASK_KINDS, testOnlyMoveRefusal, type TaskKind } from "./task-kind.js";

const TESTS_ONLY = { kind: "test-only" } as const;
const SOURCE = { kind: "source", paths: ["packages/x/src/x.ts"] } as const;

describe("kindMoveRefusal", () => {
  it("lets every kind but security move into test-only on a tests-only diff, now the gate reads mutants", () => {
    const into = TASK_KINDS.filter((kind) => kind !== "test-only").map((from) => [from, kindMoveRefusal(from, "test-only", TESTS_ONLY)]);

    expect(into.filter(([, refusal]) => refusal !== undefined).map(([from]) => from)).toEqual(["security"]);
  });

  it("refuses correctness to test-only on a source change", () => {
    expect(kindMoveRefusal("correctness", "test-only", SOURCE)).toMatch(/non-test source packages\/x\/src\/x\.ts/);
  });

  it.each<TaskKind>(["feature", "refactor", "unknown"])("refuses test-only to %s, which drops the fix-proof gate", (to) => {
    expect(kindMoveRefusal("test-only", to)).toMatch(/outside the fix-proof kinds/);
  });

  it("keeps a security run out of test-only", () => {
    expect(kindMoveRefusal("security", "test-only", TESTS_ONLY)).toMatch(/security run keeps its fresh reviewer/);
  });

  it("lets a test-only run move to correctness", () => {
    expect(kindMoveRefusal("test-only", "correctness")).toBeUndefined();
  });

  it("still refuses correctness to feature", () => {
    expect(kindMoveRefusal("correctness", "feature")).toMatch(/outside the fix-proof kinds/);
  });

  const reason = "no behaviour changes";
  it.each<TaskKind>(["refactor", "feature"])("lets correctness move to %s before review with a reason (TP-5399)", (to) => {
    expect(kindMoveRefusal("correctness", to, undefined, { reviewStarted: false, reason })).toBeUndefined();
  });

  it.each([
    ["a review has started", { reviewStarted: true, reason }, /a review has started/],
    ["the run's review state is unread", { reviewStarted: undefined, reason }, /could not be read/],
    ["no reason is given", { reviewStarted: false, reason: undefined }, /without --kind-reason/],
  ])("refuses correctness to refactor when %s", (_, early, refusal) => {
    expect(kindMoveRefusal("correctness", "refactor", undefined, early)).toMatch(refusal);
  });

  it.each<[TaskKind, TaskKind]>([
    ["test-only", "refactor"],
    ["correctness", "unknown"],
    ["security", "refactor"],
  ])("keeps refusing %s to %s before review", (from, to) => {
    expect(kindMoveRefusal(from, to, undefined, { reviewStarted: false, reason })).toBeDefined();
  });
});

describe("testOnlyMoveRefusal", () => {
  it("lets correctness move to test-only on a tests-only diff", () => {
    expect(testOnlyMoveRefusal("correctness", TESTS_ONLY)).toBeUndefined();
  });

  it("refuses correctness to test-only on a source change and names the path", () => {
    expect(testOnlyMoveRefusal("correctness", SOURCE)).toMatch(/non-test source packages\/x\/src\/x\.ts/);
  });

  it("refuses correctness to test-only when the diff was not read", () => {
    expect(testOnlyMoveRefusal("correctness", { kind: "unread", reason: "the PR's changed files could not be read" })).toMatch(/could not be read/);
    expect(testOnlyMoveRefusal("correctness", undefined)).toMatch(/without reading the PR's diff/);
  });

  it("refuses correctness to test-only on a flagged diff and gives its reason", () => {
    const flagged = { kind: "flagged", reason: "the PR deletes tests packages/x/src/b.test.ts", paths: ["packages/x/src/b.test.ts"] } as const;

    expect(testOnlyMoveRefusal("correctness", flagged)).toBe("kind correctness cannot move to test-only: the PR deletes tests packages/x/src/b.test.ts");
  });

  it("needs no diff to tighten an ungated kind into test-only", () => {
    expect(testOnlyMoveRefusal("feature", undefined)).toBeUndefined();
  });
});

describe("task-kind leaf", () => {
  it("imports only test-only-diff.ts, never register-kind.ts", () => {
    expect(relativeImports("shepherd/task-kind.ts")).toEqual(["./test-only-diff.js"]);
  });

  it("store.ts and register-args.ts read KindMove from task-kind.ts, not register-kind.ts", () => {
    expect(relativeImports("shepherd/store.ts")).not.toContain("./register-kind.js");
    expect(relativeImports("shepherd/register-args.ts")).not.toContain("./register-kind.js");
  });
});
