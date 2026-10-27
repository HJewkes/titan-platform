import { fakeGitHub, fakeSha, successRun, type FakeGitHub, type GitHubPort, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { PNG } from "pngjs";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import type { VisualThreshold } from "./visual-delta-read.js";

const REPO = "octo/ui";
export const HEAD = fakeSha("visual-delta-head");
export const MERGE_BASE = fakeSha("visual-delta-merge-base");
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

/** A 100×100 white frame with a black 10×10 square at (20, 20); `marked` turns one pixel of the square red. */
export function card(marked = false): Uint8Array {
  const image = new PNG({ width: 100, height: 100 });
  image.data.fill(255);
  for (let y = 20; y < 30; y += 1) for (let x = 20; x < 30; x += 1) image.data.set([0, 0, 0, 255], (y * 100 + x) * 4);
  if (marked) image.data.set([255, 0, 0, 255], (25 * 100 + 25) * 4);
  return PNG.sync.write(image);
}

export function world(files: PrFile[], blobs: Record<string, Uint8Array> = {}): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1)]);
  fake.prFiles.set(1, files);
  fake.compares.set(`main...${HEAD}`, { mergeBaseSha: MERGE_BASE, files: [] });
  for (const [key, bytes] of Object.entries(blobs)) fake.bytes.set(key, bytes);
  return fake;
}

export const changedShot = (): FakeGitHub => world([{ path: SHOT, status: "modified" }], { [`${MERGE_BASE}:${SHOT}`]: card(), [`${HEAD}:${SHOT}`]: card(true) });

export const evidence = (port: GitHubPort, threshold?: VisualThreshold) => mergeEvidence(port, input, noFreezeStoreUntilTp523, { kind: "feature" }, undefined, { threshold });
