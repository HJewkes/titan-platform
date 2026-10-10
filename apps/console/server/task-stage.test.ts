import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_STAGES, deriveStage, taskIdsIn, type StageEvidence, type StagedTask } from "./task-stage.js";

// A local titan-design checkout; CI has none, so the parity check runs where one exists and is skipped elsewhere.
const TITAN_DESIGN = process.env.TITAN_DESIGN_DIR ?? path.join(os.homedir(), "projects", "titan-design");
const STAGE_SOURCE = path.join(TITAN_DESIGN, "packages/ui/src/components/custom/ActiveWork/task-stage.ts");

describe("the stage vocabulary", () => {
  it.skipIf(!existsSync(STAGE_SOURCE))("matches titan-design's TaskStage union, value for value", () => {
    const union = /export type TaskStage\s*=([^\n]+)/.exec(readFileSync(STAGE_SOURCE, "utf8"))?.[1] ?? "";
    const upstream = [...union.matchAll(/'([^']+)'|"([^"]+)"/g)].map((match) => match[1] ?? match[2]);
    expect([...TASK_STAGES].sort()).toEqual(upstream.sort());
  });
});

const NONE: StageEvidence = { openIds: new Set(), openChildren: new Map(), openPrs: new Map(), refs: new Map(), mergedAt: new Map() };
const open = (fields: Partial<StagedTask> = {}): StagedTask => ({ id: "XY-10", status: "open", dep: [], ...fields });
const withEvidence = (fields: Partial<StageEvidence>): StageEvidence => ({ ...NONE, ...fields });

describe("task ids in a name", () => {
  it("finds the id inside a lower-case branch name and not inside a longer token", () => {
    expect(taskIdsIn("agent-chat/pc-xy-10-retry")).toEqual(["XY-10"]);
    expect(taskIdsIn("feat/xy-100")).toEqual(["XY-100"]);
    expect(taskIdsIn("codex/xy10-old")).toEqual([]);
  });
});

describe("a derived stage", () => {
  it("is done when the task status is done, whatever else is found", () => {
    expect(deriveStage({ ...open(), status: "done" }, NONE)).toMatchObject({ stage: "done", rule: "status-done", guessed: false });
  });

  it("is review when an open pull request carries the id", () => {
    const evidence = withEvidence({ openPrs: new Map([["XY-10", [{ repo: "example/repo", number: 7, headRef: "pc-xy-10-retry" }]]]) });
    expect(deriveStage(open(), evidence)).toMatchObject({ stage: "review", rule: "open-pr", reason: "PR example/repo#7 is open (head pc-xy-10-retry)" });
  });

  it("is in progress for a live worktree, preferring it over a plain branch", () => {
    const refs = new Map([["XY-10", [
      { repo: "repo", name: "origin/pc-xy-10-retry", kind: "branch" as const, tipAt: 200 },
      { repo: "repo", name: "pc-xy-10-retry", kind: "worktree" as const, tipAt: 200 },
    ]]]);
    expect(deriveStage(open(), withEvidence({ refs }))).toMatchObject({ stage: "in-progress", rule: "live-ref", reason: "Worktree on branch pc-xy-10-retry in repo" });
  });

  it("drops a branch left over from a merge, so the task reads as merged and still open", () => {
    const refs = new Map([["XY-10", [{ repo: "repo", name: "origin/pc-xy-10-retry", kind: "branch" as const, tipAt: 100 }]]]);
    const verdict = deriveStage(open(), withEvidence({ refs, mergedAt: new Map([["XY-10", 150]]) }));
    expect(verdict).toMatchObject({ stage: "ready", rule: "merged-commit", reason: "PR merged; task still open", guessed: false });
  });

  it("keeps a branch pushed after an earlier merge of the same task", () => {
    const refs = new Map([["XY-10", [{ repo: "repo", name: "origin/pc-xy-10-part-2", kind: "branch" as const, tipAt: 300 }]]]);
    expect(deriveStage(open(), withEvidence({ refs, mergedAt: new Map([["XY-10", 150]]) })).stage).toBe("in-progress");
  });

  it("is blocked by a dep edge or a dependency clause naming an open task, and not by a done one", () => {
    const evidence = withEvidence({ openIds: new Set(["XY-1", "XY-2", "XY-3", "XY-4"]) });
    expect(deriveStage(open({ dep: ["XY-1"] }), evidence).reason).toBe("Depends on XY-1 (open)");
    expect(deriveStage(open({ notes: "Waits on XY-2 and XY-9. Then ship." }), evidence).reason).toBe("Depends on XY-2 (open)");
    expect(deriveStage(open({ notes: "Blocked by XY-3; after XY-4 lands" }), evidence).reason).toBe("Depends on XY-3 (open), XY-4 (open)");
    expect(deriveStage(open({ notes: "depends on XY-9 (done)" }), evidence)).toMatchObject({ stage: "ready", rule: "default" });
  });

  it("reads no dependency from a tag, since edges arrive already read from the field or the tags", () => {
    expect(deriveStage(open({ tags: ["dep:XY-1"] }), withEvidence({ openIds: new Set(["XY-1"]) })).rule).toBe("default");
  });

  it("does not let a sentence after the clause add a dependency", () => {
    const evidence = withEvidence({ openIds: new Set(["XY-5"]) });
    expect(deriveStage(open({ notes: "Runs after the fixes land. See XY-5 for context." }), evidence).rule).toBe("default");
  });

  it("is blocked on a slice label it cannot resolve, read across the label's own period", () => {
    expect(deriveStage(open({ notes: "Depends: P3.14, S2. Owner A5." }), NONE)).toMatchObject({ stage: "blocked", rule: "unresolved-dependency", reason: "Unresolved dependency P3.14, S2" });
  });

  it("is blocked by a hold tag or a no-dispatch note", () => {
    expect(deriveStage(open({ tags: ["hold:owner"] }), NONE)).toMatchObject({ stage: "blocked", rule: "hold", reason: "Hold: tag hold:owner" });
    expect(deriveStage(open({ notes: "Owner: file, no dispatch." }), NONE)).toMatchObject({ stage: "blocked", rule: "hold" });
  });

  it("is blocked while it has open slices", () => {
    expect(deriveStage(open(), withEvidence({ openChildren: new Map([["XY-10", 3]]) }))).toMatchObject({ stage: "blocked", rule: "open-slices", reason: "3 open slices" });
  });

  it("is a guessed ready when nothing is found", () => {
    expect(deriveStage(open(), NONE)).toEqual({ stage: "ready", rule: "default", reason: "No pull request, live branch, worktree, open dependency or hold found", guessed: true });
  });
});
