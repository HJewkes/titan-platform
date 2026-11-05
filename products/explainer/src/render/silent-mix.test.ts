import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeStreams } from "./render-fixtures.test-helpers.js";
import { SILENT_SAMPLE_RATE, silentMix } from "./silent-mix.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "explainer-silent-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("silent mix", { timeout: 30_000 }, () => {
  it("lasts the timeline's length to the sample", async () => {
    const out = path.join(dir, "mix.wav");

    await silentMix(2.345, out);

    const [audio] = probeStreams(out);
    expect(audio?.sample_rate).toBe(String(SILENT_SAMPLE_RATE));
    expect(audio?.duration_ts).toBe(Math.round(2.345 * SILENT_SAMPLE_RATE));
  });

  it("writes the same bytes twice", async () => {
    const [a, b] = [path.join(dir, "a.wav"), path.join(dir, "b.wav")];

    await silentMix(1, a);
    await silentMix(1, b);

    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
  });

  it("refuses a zero duration", async () => {
    const mix = () => silentMix(0, path.join(dir, "mix.wav"));

    await expect(mix()).rejects.toThrow("positive duration");
  });
});
