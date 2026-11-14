import type { GateResolver } from "@titan-design/hitl";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { fakeLocator } from "../test-support/fakes.js";
import { SHEPHERD_MIGRATIONS } from "../workflows.js";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { runVisualGate } from "./registered-kind.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";
import type { VisualGateMode } from "./visual-gate-config.js";

const REPO = "example-org/example-repo";
const TASK = "example/TP-1";
const RUN = "run-1";
const HEAD = fakeSha("visual-signoff-head");
const BUTTON = "packages/ui/src/Button.tsx";
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const CONSOLE: GateResolver = { class: "owner-remote", id: "titan-console", channel: "console:inbox", confirmEvent: "action:1" };

/** A bound store holding one registered run of TASK, and the owner's console approval of TASK when `visualSignoff` is given. */
function storeWith(visualSignoff?: boolean): ShepherdStoreRef {
  const db = openDatabase(":memory:");
  runMigrations(db, SHEPHERD_MIGRATIONS);
  const ref = shepherdStoreRef(() => Date.parse("2026-11-13T12:00:00Z"));
  ref.bind(db);
  const scope = { doneWhen: "The widget renders in both themes.", reason: "new-direction" as const, visualSignoff: visualSignoff ?? false };
  if (visualSignoff !== undefined) ref.get().planApprovals().record({ gate: "task", scope, round: "validate-r1", task: TASK, repo: REPO }, CONSOLE);
  ref.get().register({ repo: REPO, pr: 1, runId: RUN, task: TASK, implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return ref;
}

const input: MergeEvidenceInput = {
  runId: RUN,
  repo: REPO,
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator: fakeLocator({ sourceId: "transcript-1", selector: { kind: "subrecord-text" } }) },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
  visualPaths: ["packages/ui/src/**"],
};

/** The merge guard's decision on a reviewed, green visual PR, under the mode the run's store gives. */
async function visualDecision(store: ShepherdStoreRef, configured: VisualGateMode | undefined) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, [{ path: BUTTON, status: "modified" }]);
  const visualGate = runVisualGate(store, RUN, configured);
  const evidence = await mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "feature" }, undefined, { ...(visualGate && { visualGate }) });
  return evidence.record.decision;
}

const GATED = { outcome: "gate", rule: { rowId: "visual-path" } };
const ALLOWED = { outcome: "allow", rule: { rowId: "MRG-AU-RV" } };

describe("the visual sign-off flag on a task approval", () => {
  it("under async a task approved with visual sign-off keeps the visual owner gate", async () => {
    expect(await visualDecision(storeWith(true), "async")).toMatchObject(GATED);
  });

  it.each([
    ["approved without it", false],
    ["with no approval", undefined],
  ] as const)("under async a task %s merges visual on reviews", async (_case, visualSignoff) => {
    expect(await visualDecision(storeWith(visualSignoff), "async")).toMatchObject(ALLOWED);
  });

  it.each([
    ["owner", true],
    ["owner", false],
    [undefined, true],
    [undefined, false],
  ] as const)("under owner the flag changes nothing: mode %s, sign-off %s", async (configured, visualSignoff) => {
    expect(runVisualGate(storeWith(visualSignoff), RUN, configured)).toBe(configured);
    expect(await visualDecision(storeWith(visualSignoff), configured)).toMatchObject(GATED);
  });

  it("under async an unreadable approval store keeps the visual owner gate", () => {
    const unbound = shepherdStoreRef();

    expect(runVisualGate(unbound, RUN, "async")).toBe("owner");
  });
});
