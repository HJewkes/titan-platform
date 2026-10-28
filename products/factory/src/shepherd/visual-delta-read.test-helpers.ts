import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort, type PrFile } from "@titan-design/github";
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

/** A `size`×`size` white frame with a black square from a tenth to a fifth of the way in; `marked` turns its middle pixel red. */
export function card(marked = false, size = 100): Uint8Array {
  const image = new PNG({ width: size, height: size });
  image.data.fill(255);
  const [from, to] = [Math.floor(size / 10), Math.floor(size / 5)];
  for (let y = from; y < to; y += 1) for (let x = from; x < to; x += 1) image.data.set([0, 0, 0, 255], (y * size + x) * 4);
  const middle = Math.floor((from + to) / 2);
  if (marked) image.data.set([255, 0, 0, 255], (middle * size + middle) * 4);
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

/** `head` at the head and `base` at the merge base for one modified snapshot at `path`. */
export const pair = (path: string, base: Uint8Array, head: Uint8Array) => ({ [`${MERGE_BASE}:${path}`]: base, [`${HEAD}:${path}`]: head });

export const changedShot = (): FakeGitHub => world([{ path: SHOT, status: "modified" }], pair(SHOT, card(), card(true)));

export const evidence = (fake: FakeGitHub, threshold?: VisualThreshold, port: GitHubPort = githubPort(fake.wire)) =>
  mergeEvidence(port, input, noFreezeStoreUntilTp523, { kind: "feature" }, undefined, { threshold });
