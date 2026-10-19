import { fakeGitHub, fakeSha, githubPort, successRun, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";

const HEAD = fakeSha("visual-render-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = partialFake<SourceTextLocator>({ selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } });
const VISUAL_PATHS = ["packages/ui/src/components/**"];

const input: MergeEvidenceInput = {
  runId: "run-1",
  repo: "octo/design",
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
  visualPaths: VISUAL_PATHS,
};

async function decisionFor(paths: string[]) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, paths.map((path): PrFile => ({ path, status: "added" })));
  const evidence = await mergeEvidence(githubPort(fake.wire), input, null, noFreezeStoreUntilTp523, { kind: "feature" });
  return evidence.record.decision;
}

describe("visual paths count only files that can render", () => {
  it("merges a PR whose only files under a visual glob are a README, tests, specs and type declarations", async () => {
    const decision = await decisionFor([
      "packages/ui/src/components/ui/README.md",
      "packages/ui/src/components/ui/motion/Beat.test.tsx",
      "packages/ui/src/components/ui/motion/Beat.SPEC.ts",
      "packages/ui/src/components/ui/motion/types.d.ts",
    ]);

    expect(decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
  });

  it("still gates a rendering component added beside its tests and docs (td#835), naming only the component", async () => {
    const decision = await decisionFor([
      "packages/ui/src/components/ui/motion/Beat.tsx",
      "packages/ui/src/components/ui/motion/Beat.test.tsx",
      "packages/ui/src/components/ui/motion/README.md",
    ]);

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" } });
    expect(decision.reason).toContain("Beat.tsx");
    expect(decision.reason).not.toContain("Beat.test.tsx");
    expect(decision.reason).not.toContain("README.md");
  });

  it("still gates a PR with no changed files as visual", async () => {
    const decision = await decisionFor([]);

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "files-unread" }, reason: expect.stringContaining("counts as visual") });
  });

  it("does not read a file merely named like a test word as a test", async () => {
    const decision = await decisionFor(["packages/ui/src/components/Contest.tsx"]);

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" } });
  });
});
