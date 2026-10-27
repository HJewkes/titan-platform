import { FakeHttpError, githubPort, type GitHubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { evidenceComment } from "./evidence-comment.js";
import { MergeEvidenceSchema } from "./review-schemas.js";
import { HEAD, MERGE_BASE, SHOT, THRESHOLD, card, changedShot, evidence, world } from "./visual-delta-read.test-helpers.js";

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

  it("lists added and removed snapshots unmeasured by share, and measures none past maxSnapshots", async () => {
    const files = [{ path: SHOT, status: "modified" }, { path: "ui/visual/s.spec.ts-snapshots/new--a-chromium-linux.png", status: "added" }, { path: "ui/visual/s.spec.ts-snapshots/old--b-chromium-linux.png", status: "removed" }];

    const capped = await evidence(githubPort(world(files).wire), { ...THRESHOLD, maxSnapshots: 2 });

    expect(capped.record.visualDelta?.snapshots.map((s) => [s.component, s.status])).toEqual([["card", "unmeasured"], ["old", "removed"], ["new", "added"]]);
    expect(capped.record.visualDelta?.snapshots[0]?.reason).toBe("3 changed snapshots are over the cap of 2");
  });

  it("measures a renamed snapshot against its old path at the merge base, and reads one renamed away as removed", async () => {
    const OLD = "ui/visual/stories.spec.ts-snapshots/card--plain-chromium-linux.png";
    const files = [{ path: SHOT, previousPath: OLD, status: "renamed" }, { path: "ui/docs/b.png", previousPath: "ui/visual/s.spec.ts-snapshots/b--x-chromium-linux.png", status: "renamed" }];

    const { record } = await evidence(githubPort(world(files, { [`${MERGE_BASE}:${OLD}`]: card(), [`${HEAD}:${SHOT}`]: card(true) }).wire), THRESHOLD);

    expect(record.visualDelta?.snapshots.map((s) => [s.component, s.status, s.share])).toEqual([["b", "removed", undefined], ["card", "changed", 0.01]]);
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
