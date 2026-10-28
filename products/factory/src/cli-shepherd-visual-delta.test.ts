import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { fakeSha } from "@titan-design/github";
import { EXIT as SYSEXITS } from "@titan-design/registry";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import { REPO } from "./test-support/land.js";
import { shepherdFixture, type ShepherdFixture } from "./test-support/shepherd.js";
import { THRESHOLD, card } from "./shepherd/visual-delta-read.test-helpers.js";
import type { VisualDeltaReport } from "./shepherd/visual-delta-command.js";

const HEAD = fakeSha("calibration-head");
const MERGE_BASE = fakeSha("calibration-merge-base");
const CHANGED = "ui/visual/stories.spec.ts-snapshots/card--default-chromium-linux.png";
const GREY = "ui/visual/stories.spec.ts-snapshots/badge--default-chromium-linux.png";
/** IHDR's colour type byte, after the 8-byte signature, the chunk's length and type, and its width, height and bit depth. */
const COLOUR_TYPE_AT = 25;
const AGENT = { AGENT_CHAT_NAME: "demo-impl", AGENT_CHAT_AGENT_ID: "id-1" };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function deadPort(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return String(address.port);
}

/** A valid card re-labelled greyscale, which the bounded decoder refuses before it inflates anything. */
function greyscale(): Uint8Array {
  const bytes = card();
  bytes[COLOUR_TYPE_AT] = 0;
  return bytes;
}

/** One changed shot that measures, one whose head is a format the decoder refuses, and an API report. */
function calibrationPr(withThreshold: boolean): ShepherdFixture {
  const fixture = shepherdFixture(withThreshold ? { visualThreshold: THRESHOLD } : {});
  const { fake } = fixture;
  const pr = fake.addPr({ headSha: HEAD });
  fake.prFiles.set(pr.number, [{ path: CHANGED, status: "modified" }, { path: GREY, status: "modified" }, { path: "ui/api/index.api.md", status: "modified" }]);
  fake.compares.set(`main...${HEAD}`, { mergeBaseSha: MERGE_BASE, files: [] });
  const blobs = { [`${MERGE_BASE}:${CHANGED}`]: card(), [`${HEAD}:${CHANGED}`]: card(true), [`${MERGE_BASE}:${GREY}`]: card(), [`${HEAD}:${GREY}`]: greyscale() };
  for (const [key, bytes] of Object.entries(blobs)) fake.bytes.set(key, bytes);
  return fixture;
}

async function visualDelta(fixture: ShepherdFixture, extra: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const dir = mkdtempSync(join(tmpdir(), "factory-visual-delta-"));
  dirs.push(dir);
  const deps = { workflows: fixture.workflows, routes: fixture.routes, host: { gatePollMs: 5 }, logger: silentLogger, serveWaitMs: 50 };
  const argv = ["--db", join(dir, "factory.sqlite3"), "shepherd", "visual-delta", "--repo", REPO, "--pr", "1", "--port", await deadPort(), ...extra];
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env: AGENT }, deps);
  return { code, out, err };
}

describe("titan-factory shepherd visual-delta with no serve answering, in an agent env", () => {
  it("prints the measured delta as JSON and counts the shot the decoder refused as an unsupported format", async () => {
    const fixture = calibrationPr(true);

    const result = await visualDelta(fixture);

    expect(result.code).toBe(EXIT.OK);
    const report = JSON.parse(result.out) as VisualDeltaReport;
    expect(report).toMatchObject({ repo: REPO, pr: 1, head: HEAD, unsupportedFormat: 1, visualDelta: { mergeBase: MERGE_BASE, api: ["ui/api/index.api.md"] } });
    expect(report.visualDelta.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: GREY, status: "unmeasured", reason: "head: unsupported PNG format" }),
        expect.objectContaining({ path: CHANGED, status: "changed", share: expect.any(Number) }),
      ]),
    );
  });

  it("writes nothing to GitHub: no comment, merge, ref or branch update", async () => {
    const fixture = calibrationPr(true);

    await visualDelta(fixture);

    expect(Object.values(fixture.fake.effects).every((count) => count === 0)).toBe(true);
    expect(fixture.fake.comments.size).toBe(0);
  });

  it("measures nothing when --head is not the PR's head, and says its files are unread", async () => {
    const fixture = calibrationPr(true);

    const result = await visualDelta(fixture, ["--head", fakeSha("older-head")]);

    const report = JSON.parse(result.out) as VisualDeltaReport;
    expect(report).toMatchObject({ unsupportedFormat: 0, visualDelta: { snapshots: [], unread: expect.stringContaining(`the PR is at ${HEAD}`) } });
  });

  it("refuses a repo with no shepherd.visualThreshold, as there are no snapshot paths to measure", async () => {
    const result = await visualDelta(calibrationPr(false));

    expect(result.code).toBe(SYSEXITS.NOINPUT);
    expect(result.err).toContain("no shepherd.visualThreshold");
  });
});
