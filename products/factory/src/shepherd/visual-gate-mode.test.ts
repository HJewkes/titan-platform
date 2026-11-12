import { fakeGitHub, fakeSha, githubPort, successRun, type PrFile } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { fakeLocator } from "../test-support/fakes.js";
import { decideAutoMerge, mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import { ownerHoldOf, riskFactsOf, riskTier } from "./risk-tier.js";
import { requiredSignoffs } from "./signoffs.js";
import type { Registration } from "./store.js";
import type { VisualGateMode } from "./visual-gate-mode.js";

const HEAD = fakeSha("visual-gate-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const VISUAL_PATHS = ["packages/ui/src/**"];
const BUTTON = "packages/ui/src/Button.tsx";
const MODES: (VisualGateMode | undefined)[] = ["owner", "async", undefined];
const label = (mode: VisualGateMode | undefined): string => mode ?? "absent";

const input: MergeEvidenceInput = {
  runId: "run-1",
  repo: "octo/demo",
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator: fakeLocator({ sourceId: "transcript-1", selector: { kind: "subrecord-text" } }) },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
  visualPaths: VISUAL_PATHS,
};

/** An open PR at HEAD with green required checks, a clean test merge and a reviewer MERGE. */
async function evidenceAt(files: PrFile[] | number, visualGate: VisualGateMode | undefined) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  if (typeof files === "number") fake.prChangedFiles.set(1, files);
  else fake.prFiles.set(1, files);
  return mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "feature" }, undefined, { ...(visualGate && { visualGate }) });
}

const visualPr: PrFile[] = [{ path: BUTTON, status: "modified" }];

describe("shepherd.visualGate on the merge guard's visual-path row", () => {
  it.each(MODES)("under %s gates a reviewed, green visual PR only when the mode is not async", async (mode) => {
    const evidence = await evidenceAt(visualPr, mode);

    const expected = mode === "async" ? { outcome: "allow", rule: { rowId: "MRG-AU-RV" } } : { outcome: "gate", rule: { rowId: "visual-path" } };
    expect(evidence.record.decision, label(mode)).toMatchObject(expected);
  });

  it("records the visualChanged fact and the mode under async, and names the paths on the allow", async () => {
    const evidence = await evidenceAt(visualPr, "async");

    expect(evidence.record).toMatchObject({ visualChanged: [BUTTON], visualGate: "async" });
    expect(evidence.record.decision.reason).toContain(`visual changed ${BUTTON}, reviewed after merge`);
  });

  it.each(["owner", undefined] as const)("records no visualChanged fact under %s", async (mode) => {
    const evidence = await evidenceAt(visualPr, mode);

    expect(evidence.record).not.toHaveProperty("visualChanged");
    expect(evidence.record).not.toHaveProperty("visualGate");
  });

  it("keeps the owner gate under async when the changed files could not be read whole", async () => {
    const evidence = await evidenceAt(5, "async");

    expect(evidence.record.decision).toMatchObject({ outcome: "gate", rule: { rowId: "files-unread" } });
  });

  it("decides a stored async record the same way at decide time, and an unstamped one as owner", async () => {
    const stored = await evidenceAt(visualPr, "async");
    const unstamped = { ...stored, visualGate: undefined };

    expect(decideAutoMerge(HEAD, stored, VISUAL_PATHS).outcome).toBe("allow");
    expect(decideAutoMerge(HEAD, unstamped, VISUAL_PATHS)).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" } });
  });
});

describe("shepherd.visualGate on the owner sign-off", () => {
  it.each(MODES)("under %s asks the owner for a visual touch only when the mode is not async", (mode) => {
    const signoffs = requiredSignoffs({ touches: ["visual"], paths: [BUTTON], ...(mode && { visualGate: mode }) });

    expect(signoffs, label(mode)).toEqual(mode === "async" ? ["correctness"] : ["correctness", "owner"]);
  });

  it("keeps the owner for the owner's own rule file under async", () => {
    expect(requiredSignoffs({ touches: ["authority"], paths: ["packages/authority/src/table.json"], visualGate: "async" })).toContain("owner");
  });
});

const tierOf = (paths: string[], visualGate: VisualGateMode | undefined) =>
  riskTier(riskFactsOf({ paths, changedLines: 10, unread: undefined, visualPaths: VISUAL_PATHS, ownerHold: undefined, ...(visualGate && { visualGate }) }));

describe("shepherd.visualGate on the risk tier", () => {
  it.each(MODES)("under %s makes a visual path alone high only when the mode is not async", (mode) => {
    expect(tierOf([BUTTON], mode).tier, label(mode)).toBe(mode === "async" ? "low" : "high");
  });

  it("keeps another high fact high under async", () => {
    const tier = tierOf([BUTTON, ".github/workflows/ci.yml"], "async");

    expect(tier.tier).toBe("high");
    expect(tier.reasons.filter((reason) => reason.startsWith("high:"))).toEqual(["high: CI workflow file .github/workflows/ci.yml"]);
  });
});

const registered = (overrides: Partial<Registration>): Registration =>
  partialFake<Registration>({ held: false, holdReason: null, ownerHold: null, policy: { merge: "auto", mergeMethod: "squash", fixer: true, seat: "none" }, ...overrides });

const gate2 = registered({ policy: { merge: "owner-gate", mergeMethod: "squash", fixer: true, seat: "s", ownerGateReason: "gate-2-visual" } });

describe("shepherd.visualGate on visual-gate2 holds", () => {
  it.each(MODES)("under %s reads a visual-gate2 hold and a Gate 2 registration as the owner's only when the mode is not async", (mode) => {
    const owner = mode !== "async";

    expect(ownerHoldOf(registered({ held: true, holdReason: "visual-gate2: sign-off" }), mode), label(mode)).toBe(owner ? "visual-gate2: sign-off" : undefined);
    expect(ownerHoldOf(gate2, mode), label(mode)).toBe(owner ? "owner gate gate-2-visual" : undefined);
  });

  it("keeps an owner-asked hold and the owner slot the owner's under async", () => {
    const at = "2026-11-12T00:00:00.000Z";

    expect(ownerHoldOf(registered({ held: true, holdReason: "owner-asked: discuss" }), "async")).toBe("owner-asked: discuss");
    expect(ownerHoldOf(registered({ ownerHold: { reason: "owner-asked: freeze", at, askedAt: null } }), "async")).toBe("owner-asked: freeze");
  });
});
