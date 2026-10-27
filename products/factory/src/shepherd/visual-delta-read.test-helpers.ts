import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import type { VisualThreshold } from "./visual-delta-read.js";

const REPO = "octo/ui";
const HEAD = fakeSha("visual-delta-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
export const SHOT = "ui/visual/stories.spec.ts-snapshots/card--default-chromium-linux.png";

const input: MergeEvidenceInput = {
  runId: "run-1",
  repo: REPO,
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator: partialFake<SourceTextLocator>() },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
};

export const THRESHOLD: VisualThreshold = {
  mode: "shadow",
  snapshotPaths: ["ui/visual/**/*-chromium-linux.png"],
  apiPaths: ["ui/api/*.api.md"],
  tokenPaths: ["ui/src/theme/**"],
  harnessPaths: ["ui/playwright*.config.ts", "ui/visual/*.spec.ts"],
};

export function world(files: PrFile[]): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1)]);
  fake.prFiles.set(1, files);
  return fake;
}

export const changedShot = (): FakeGitHub => world([{ path: SHOT, status: "modified" }]);

export const evidence = (fake: FakeGitHub, threshold?: VisualThreshold) => mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "feature" }, undefined, { threshold });
