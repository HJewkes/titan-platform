import { FakeHttpError, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { evidenceComment } from "./evidence-comment.js";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import { MergeEvidenceSchema } from "./review-schemas.js";
import type { VisualThreshold } from "./visual-delta-read.js";

const REPO = "octo/ui";
const HEAD = fakeSha("visual-delta-head");
const MERGE_BASE = fakeSha("visual-delta-merge-base");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const SHOT = "ui/visual/stories.spec.ts-snapshots/card--default-chromium-linux.png";

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

const THRESHOLD: VisualThreshold = {
  mode: "shadow",
  snapshotPaths: ["ui/visual/**/*-chromium-linux.png"],
  apiPaths: ["ui/api/*.api.md"],
  tokenPaths: ["ui/src/theme/**"],
  harnessPaths: ["ui/playwright*.config.ts", "ui/visual/*.spec.ts"],
};

/** A 100×100 white frame with a black 10×10 square at (20, 20); `marked` turns one pixel of the square red. */
function card(marked = false): Uint8Array {
  const image = new PNG({ width: 100, height: 100 });
  image.data.fill(255);
  for (let y = 20; y < 30; y += 1) for (let x = 20; x < 30; x += 1) image.data.set([0, 0, 0, 255], (y * 100 + x) * 4);
  if (marked) image.data.set([255, 0, 0, 255], (25 * 100 + 25) * 4);
  return PNG.sync.write(image);
}

function world(files: PrFile[], blobs: Record<string, Uint8Array> = {}): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1)]);
  fake.prFiles.set(1, files);
  fake.compares.set(`main...${HEAD}`, { mergeBaseSha: MERGE_BASE, files: [] });
  for (const [key, bytes] of Object.entries(blobs)) fake.bytes.set(key, bytes);
  return fake;
}

const changedShot = (): FakeGitHub => world([{ path: SHOT, status: "modified" }], { [`${MERGE_BASE}:${SHOT}`]: card(), [`${HEAD}:${SHOT}`]: card(true) });

const evidence = (port: GitHubPort, threshold?: VisualThreshold) => mergeEvidence(port, input, noFreezeStoreUntilTp523, { kind: "feature" }, undefined, { threshold });

describe("the merge evidence under shepherd.visualThreshold shadow", () => {
  it("records a changed snapshot's share of the content box, read from the merge base and the head", async () => {
    const { record } = await evidence(githubPort(changedShot().wire), THRESHOLD);

    expect(record.visualDelta?.mergeBase).toBe(MERGE_BASE);
    expect(record.visualDelta?.snapshots).toEqual([{ path: SHOT, component: "card", status: "changed", share: 0.01 }]);
    expect(record.visualDelta?.policy).toEqual({ mode: "shadow", maxChangedShare: 0.01, pixelTolerance: 0.1 });
  });

  it("records an unreadable head blob as unmeasured with the reason, and still posts the evidence", async () => {
    const port = githubPort(changedShot().wire);
    const failing: GitHubPort = { ...port, fileBytes: async (repo, path, ref) => (ref === HEAD ? Promise.reject(new FakeHttpError(502, "bad gateway")) : port.fileBytes(repo, path, ref)) };

    const { record } = await evidence(failing, THRESHOLD);

    expect(record.visualDelta?.snapshots).toEqual([{ path: SHOT, component: "card", status: "unmeasured", reason: expect.stringMatching(new RegExp(`^unreadable at ${HEAD}: .*502`)) }]);
  });

  it("records a blob that is not a PNG, or over maxBytes, as unmeasured", async () => {
    const notPng = world([{ path: SHOT, status: "modified" }], { [`${MERGE_BASE}:${SHOT}`]: card(), [`${HEAD}:${SHOT}`]: new TextEncoder().encode("not an image") });

    const [text, big] = [await evidence(githubPort(notPng.wire), THRESHOLD), await evidence(githubPort(changedShot().wire), { ...THRESHOLD, maxBytes: 10 })];

    expect(text.record.visualDelta?.snapshots[0]).toMatchObject({ status: "unmeasured", reason: `not a PNG at ${HEAD}` });
    expect(big.record.visualDelta?.snapshots[0]).toMatchObject({ status: "unmeasured", reason: `over 10 bytes at ${MERGE_BASE}` });
  });

  it("refuses before decoding a PNG whose header declares more than maxPixels, or that is interlaced", async () => {
    const huge = card(true);
    new DataView(huge.buffer, huge.byteOffset).setUint32(16, 20_000);
    new DataView(huge.buffer, huge.byteOffset).setUint32(20, 20_000);
    const interlaced = card(true);
    interlaced[28] = 1;
    const shot = (head: Uint8Array) => githubPort(world([{ path: SHOT, status: "modified" }], { [`${MERGE_BASE}:${SHOT}`]: card(), [`${HEAD}:${SHOT}`]: head }).wire);

    const reasons = [await evidence(shot(huge), THRESHOLD), await evidence(shot(interlaced), THRESHOLD), await evidence(shot(card(true)), { ...THRESHOLD, maxPixels: 9_999 })].map(
      ({ record }) => record.visualDelta?.snapshots[0]?.reason,
    );

    expect(reasons).toEqual([`over ${16 * 1024 * 1024} pixels at ${HEAD}`, `interlaced at ${HEAD}`, `over 9999 pixels at ${MERGE_BASE}`]);
  });

  it("lists added and removed snapshots unmeasured by share, and measures none past maxSnapshots", async () => {
    const files = [{ path: SHOT, status: "modified" }, { path: "ui/visual/s.spec.ts-snapshots/new--a-chromium-linux.png", status: "added" }, { path: "ui/visual/s.spec.ts-snapshots/old--b-chromium-linux.png", status: "removed" }];

    const capped = await evidence(githubPort(world(files).wire), { ...THRESHOLD, maxSnapshots: 2 });

    expect(capped.record.visualDelta?.snapshots.map((s) => [s.component, s.status])).toEqual([["card", "unmeasured"], ["old", "removed"], ["new", "added"]]);
    expect(capped.record.visualDelta?.snapshots[0]?.reason).toBe("3 changed snapshots are over the cap of 2");
  });

  it("measures a renamed snapshot against its old path at the merge base, and reads one renamed away as removed and one renamed in as added", async () => {
    const OLD = "ui/visual/stories.spec.ts-snapshots/card--plain-chromium-linux.png";
    const IN = "ui/visual/s.spec.ts-snapshots/c--y-chromium-linux.png";
    const files = [
      { path: SHOT, previousPath: OLD, status: "renamed" },
      { path: "ui/docs/b.png", previousPath: "ui/visual/s.spec.ts-snapshots/b--x-chromium-linux.png", status: "renamed" },
      { path: IN, previousPath: "ui/docs/c.png", status: "renamed" },
    ];

    const { record } = await evidence(githubPort(world(files, { [`${MERGE_BASE}:${OLD}`]: card(), [`${HEAD}:${SHOT}`]: card(true) }).wire), THRESHOLD);

    expect(record.visualDelta?.snapshots.map((s) => [s.component, s.status, s.share])).toEqual([["b", "removed", undefined], ["card", "changed", 0.01], ["c", "added", undefined]]);
  });

  it("keeps the evidence comment under 60,000 characters when a PR regenerates hundreds of snapshots, counting what it leaves out", async () => {
    const long = "x".repeat(400);
    const shot = (i: number) => `ui/visual/stories.spec.ts-snapshots/${long}-${i}--default-chromium-linux.png`;
    const added = Array.from({ length: 400 }, (_, i) => ({ path: shot(i), status: "added" }));
    const reports = Array.from({ length: 400 }, (_, i) => ({ path: `ui/api/${long}-${i}.api.md`, status: "modified" }));
    const files = [...added, { path: shot(999), status: "removed" }, ...reports];

    const { record } = await evidence(githubPort(world(files).wire), THRESHOLD);

    expect(evidenceComment(record).length).toBeLessThan(60_000);
    expect(record.visualDelta?.omitted).toEqual({ snapshots: 361, api: 380 });
    expect(record.visualDelta?.snapshots[0]?.status).toBe("removed");
  });

  it("matches the public API, token and harness paths, a token test aside", async () => {
    const files = [{ path: "ui/api/index.api.md", status: "modified" }, { path: "ui/src/theme/config.ts", status: "modified" }, { path: "ui/src/theme/config.test.ts", status: "modified" }, { path: "ui/playwright.config.ts", status: "modified" }];

    const { record } = await evidence(githubPort(world(files).wire), THRESHOLD);

    expect([record.visualDelta?.api, record.visualDelta?.tokens, record.visualDelta?.harness]).toEqual([["ui/api/index.api.md"], ["ui/src/theme/config.ts"], ["ui/playwright.config.ts"]]);
  });

  it("leaves the decision as it is without the threshold, and keeps a record the evidence schema reads", async () => {
    const [shadow, none] = [await evidence(githubPort(changedShot().wire), THRESHOLD), await evidence(githubPort(changedShot().wire))];

    expect(shadow.record.decision).toEqual(none.record.decision);
    expect(MergeEvidenceSchema.parse(shadow).record.visualDelta?.snapshots[0]?.share).toBe(0.01);
  });

  it("reads no blob and records nothing when the repo's mode is off", async () => {
    const fake = changedShot();

    const { record } = await evidence(githubPort(fake.wire), { ...THRESHOLD, mode: "off" });

    expect(record.visualDelta).toBeUndefined();
    expect(fake.calls).not.toContain("getContentBytes");
  });
});
