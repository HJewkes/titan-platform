import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePng } from "@titan-design/png-delta";
import { BY_REC_RESOLVER, BY_REC_ROW_SCHEMA, type ByRecRow } from "@titan-design/owner-queue";
import { readLogFrame, type Captured, type CaptureTarget, type FramesCapture } from "./log-frames.js";
import { MAX_CAPTURES_PER_BUILD, withFrames } from "./log-frames-rows.js";
import { mergeLog, type ShipInput } from "./log-rows.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const HEAD = "d".repeat(40);
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const swatch = (shade: number): Buffer => encodePng({ width: 2, height: 2, rgba: new Uint8Array(16).fill(shade) });

function ship(pr: number, head: string | undefined = HEAD): ShipInput {
  return { repo: "Orbit/Relay", pr, task: `OR-${pr}`, url: `https://github.com/Orbit/Relay/pull/${pr}`, mergedAt: NOW - 3_600_000, approval: "auto-by-rec", ...(head && { head }) };
}

/** A live by-rec gate row for the PR; `D2` makes its ship a visual row. */
function gate(pr: number, decisionClass?: string): ByRecRow {
  return {
    schema: BY_REC_ROW_SCHEMA, subject: { source: "gate", id: `gate-${pr}` }, recommendation: { answer: "merge", by: "relay-reviewer" },
    openedAt: new Date(NOW - 30 * 3_600_000).toISOString(), resolvedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    facts: { repo: "Orbit/Relay", pr, ...(decisionClass && { decisionClass }) }, mode: "live", result: "resolved", resolver: { ...BY_REC_RESOLVER },
  };
}

function build(ships: ShipInput[], gates: ByRecRow[], stateDir: string, capture: FramesCapture) {
  return withFrames(mergeLog({ ships, gateRows: gates, consoleRows: [], dayOf }), ships, { stateDir, capture });
}

/** What Shepherd's verb does for an artifact with one changed shot: the pair written into the folder it was given. */
const onePair: FramesCapture = async ({ dir }: CaptureTarget): Promise<Captured> => {
  await mkdir(dir, { recursive: true });
  const [before, after] = [path.join(dir, "0-relay-card--compact@1280-before.png"), path.join(dir, "0-relay-card--compact@1280-after.png")];
  await writeFile(before, swatch(200));
  await writeFile(after, swatch(90));
  return { line: "pr-visual: 2 shots, 1 changed", variantKeys: [before, after] };
};

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "log-frames-"));
});
afterEach(() => rm(stateDir, { recursive: true, force: true }));

describe("the log's visual ship frames", () => {
  it("writes the pairs once: a second build is a no-op", async () => {
    const capture = vi.fn(onePair);

    await build([ship(41)], [gate(41, "D2")], stateDir, capture);
    const framesFile = path.join(stateDir, "log-frames", "orbit", "relay", "41", "frames.json");
    const first = await readFile(framesFile, "utf8");
    const second = await build([ship(41)], [gate(41, "D2")], stateDir, capture);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ repo: "Orbit/Relay", pr: 41, head: HEAD }));
    expect(await readFile(framesFile, "utf8")).toBe(first);
    expect(JSON.parse(first)).toMatchObject({ schema: "titan-review/frames@1", evidence: "pr-visual: 2 shots, 1 changed" });
    expect(second.rows[0]!.frames).toEqual({ repo: "Orbit/Relay", pr: 41, pairs: [{ key: "shot-0", label: "relay-card--compact@1280" }] });
    expect(second.gaps).toEqual([]);
  });

  it("gives one reason line when the artifact is missing, and keeps it", async () => {
    const capture = vi.fn(async (): Promise<Captured> => ({ line: "pr-visual: no before and after shown", variantKeys: [], reason: "no pr-visual artifact for this head" }));

    await build([ship(41)], [gate(41, "D2")], stateDir, capture);
    const { rows } = await build([ship(41)], [gate(41, "D2")], stateDir, capture);

    expect(rows[0]!.frames).toEqual({ repo: "Orbit/Relay", pr: 41, pairs: [], note: "no visual evidence: no pr-visual artifact for this head" });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("gives a non-visual PR no frames block and reads no artifact", async () => {
    const capture = vi.fn(onePair);

    const { rows } = await build([ship(36)], [gate(36)], stateDir, capture);

    expect(rows[0]!.frames).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it("writes nothing for a failed read, names it in a gap line, and tries again on the next build", async () => {
    const capture = vi.fn(async (): Promise<Captured> => ({ line: "pr-visual: no before and after shown", variantKeys: [], reason: "the read failed: timeout", failed: true }));

    const first = await build([ship(41)], [gate(41, "D2")], stateDir, capture);
    await build([ship(41)], [gate(41, "D2")], stateDir, capture);

    expect(first.rows[0]!.frames).toBeNull();
    expect(first.gaps).toEqual(["frames for Orbit/Relay#41: the read failed: timeout"]);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("starts at most the per-build cap of captures", async () => {
    const prs = Array.from({ length: MAX_CAPTURES_PER_BUILD + 2 }, (_, at) => 50 + at);
    const capture = vi.fn(onePair);

    const { rows } = await build(prs.map((pr) => ship(pr)), prs.map((pr) => gate(pr, "D2")), stateDir, capture);

    expect(capture).toHaveBeenCalledTimes(MAX_CAPTURES_PER_BUILD);
    expect(rows.filter((row) => row.frames === null)).toHaveLength(2);
  });

  it("serves each side checked against its recorded sha256, and refuses a changed file", async () => {
    await build([ship(41)], [gate(41, "D2")], stateDir, onePair);

    const after = await readLogFrame(stateDir, "orbit/relay", 41, "shot-0", "after");
    await writeFile(path.join(stateDir, "log-frames", "orbit", "relay", "41", "0-relay-card--compact@1280-before.png"), swatch(10));

    expect(Buffer.from(after.base64, "base64").equals(swatch(90))).toBe(true);
    await expect(readLogFrame(stateDir, "orbit/relay", 41, "shot-0", "before")).rejects.toThrow(/does not match/);
    await expect(readLogFrame(stateDir, "../relay", 41, "shot-0", "after")).rejects.toThrow(/owner\/repo/);
  });
});
