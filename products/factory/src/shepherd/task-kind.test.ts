import { describe, expect, it } from "vitest";
import { kindMoveRefusal, TASK_KINDS, testOnlyMoveRefusal, type TaskKind } from "./task-kind.js";

const TESTS_ONLY = { kind: "test-only" } as const;
const SOURCE = { kind: "source", paths: ["packages/x/src/x.ts"] } as const;

describe("kindMoveRefusal", () => {
  it("refuses every move into test-only while the gate does not read test-only diffs", () => {
    const into = TASK_KINDS.filter((kind) => kind !== "test-only").map((from) => kindMoveRefusal(from, "test-only", TESTS_ONLY));

    expect(into.every((refusal) => refusal !== undefined)).toBe(true);
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
});

describe("testOnlyMoveRefusal, the guard once the kind is live", () => {
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

  it("needs no diff to tighten an ungated kind into test-only", () => {
    expect(testOnlyMoveRefusal("feature", undefined)).toBeUndefined();
  });
});
