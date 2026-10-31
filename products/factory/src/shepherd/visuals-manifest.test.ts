import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pairVisuals } from "./visuals-manifest.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SHOT = { story: "Card/Default", width: "375", before: "c-before.png", after: "c-after.png" };

function dirWith(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "visuals-manifest-"));
  mkdirSync(join(dir, "pr-9"));
  writeFileSync(join(dir, "pr-9", "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  return dir;
}

const manifest = (over: object = {}) => ({ v: 1, repo: "octo/demo", pr: 9, baseSha: BASE, headSha: HEAD, rendered: true, shots: [SHOT], ...over });

describe("pairVisuals", () => {
  it("pairs each shot's before and after under the manifest's folder", async () => {
    const dir = dirWith(manifest());

    expect(await pairVisuals(dir, 9, HEAD)).toEqual({ base: BASE, pairs: [{ story: "Card/Default", width: "375", before: join(dir, "pr-9", "c-before.png"), after: join(dir, "pr-9", "c-after.png") }] });
  });

  it("states a missing manifest", async () => {
    expect(await pairVisuals(mkdtempSync(join(tmpdir(), "visuals-empty-")), 9, HEAD)).toMatchObject({ none: expect.stringContaining("No visuals manifest") });
  });

  it("states a manifest that is not JSON or does not match the schema", async () => {
    expect(await pairVisuals(dirWith("{"), 9, HEAD)).toMatchObject({ none: expect.stringContaining("not valid JSON") });
    expect(await pairVisuals(dirWith({ v: 2 }), 9, HEAD)).toMatchObject({ none: expect.stringContaining("does not match its schema") });
  });

  it("gives the reason when nothing was rendered", async () => {
    expect(await pairVisuals(dirWith(manifest({ rendered: false, reason: "storybook failed to build", shots: [] })), 9, HEAD)).toEqual({ none: "Nothing was rendered: storybook failed to build" });
  });

  it("never offers an after-only set", async () => {
    const result = await pairVisuals(dirWith(manifest({ shots: [SHOT, { story: "Card/New", width: "375", after: "n-after.png" }] })), 9, HEAD);

    expect(result).toMatchObject({ none: expect.stringContaining("1 shot(s) missing a before or an after") });
    expect("pairs" in result).toBe(false);
  });

  it("refuses visuals captured at another head", async () => {
    expect(await pairVisuals(dirWith(manifest({ headSha: "d".repeat(40) })), 9, HEAD)).toMatchObject({ none: expect.stringContaining("captured at ddddddd, not the PR head aaaaaaa") });
  });
});
