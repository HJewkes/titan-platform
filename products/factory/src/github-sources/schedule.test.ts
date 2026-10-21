import type { Logger } from "@titan-design/daemon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sweep } from "../sweep.js";
import { resolveSources, type SourcesReader } from "./mode.js";
import { DUE_CHECK_TICK_MS, startReconcilerSchedule } from "./schedule.js";

type GithubBlock = NonNullable<Parameters<typeof resolveSources>[0]["github"]>;

const WEBHOOK: GithubBlock = { sources: "webhook", ingress: "on" };
const KILL_SWITCH: GithubBlock = { sources: "webhook", ingress: "off" };
const MINUTE = 60_000;

interface Harness {
  sweep: Sweep;
  passes: number[];
  lines: { msg: string; fields: Record<string, unknown> }[];
  set(github: GithubBlock): void;
}

/** A mutable config read through the real resolver, as serve's file reader re-reads the file each tick. */
function harness(github: GithubBlock, pass: () => Promise<void> = async () => undefined): Harness {
  let block = github;
  const sources: SourcesReader = () => resolveSources({ github: block });
  const passes: number[] = [];
  const lines: Harness["lines"] = [];
  const record = (fields: Record<string, unknown>, msg: string) => void lines.push({ msg, fields });
  const log: Logger = { info: record, warn: record, error: record };
  const sweep = startReconcilerSchedule({ sources, now: Date.now, log, pass: () => (passes.push(Date.now() - T0), pass()) });
  sweeps.push(sweep);
  return { sweep, passes, lines, set: (next) => void (block = next) };
}

const T0 = Date.parse("2027-01-15T08:00:00Z");
const sweeps: Sweep[] = [];

/** Serve fires the start pass itself, then the fixed tick takes over. */
async function started(h: Harness): Promise<Harness> {
  await h.sweep.tick();
  return h;
}

const sourceLines = (h: Harness) => h.lines.filter((line) => line.msg.startsWith("github sources:"));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  for (const sweep of sweeps.splice(0)) sweep.halt();
  vi.useRealTimers();
});

describe("reconciler schedule cadence (I4)", () => {
  it("passes every pollingIntervalMs under polling and every backstopIntervalMs under webhook", async () => {
    const polling = await started(harness({ sources: "polling", pollingIntervalMs: MINUTE }));
    const webhook = await started(harness({ ...WEBHOOK, backstopIntervalMs: 5 * MINUTE }));

    await vi.advanceTimersByTimeAsync(10 * MINUTE);

    expect(polling.passes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((minutes) => minutes * MINUTE));
    expect(webhook.passes).toEqual([0, 5 * MINUTE, 10 * MINUTE]);
  });

  it("checks on a fixed 15 s tick, so a pass is never later than one tick past due", async () => {
    const h = await started(harness({ sources: "polling", pollingIntervalMs: 50_000 }));

    await vi.advanceTimersByTimeAsync(2 * MINUTE);

    expect(DUE_CHECK_TICK_MS).toBe(15_000);
    expect(h.passes).toEqual([0, 60_000, 120_000]);
  });

  it("applies an interval edit on the next tick, with no restart", async () => {
    const h = await started(harness({ sources: "polling", pollingIntervalMs: MINUTE }));
    await vi.advanceTimersByTimeAsync(MINUTE);

    h.set({ sources: "polling", pollingIntervalMs: 3 * MINUTE });
    await vi.advanceTimersByTimeAsync(6 * MINUTE);

    expect(h.passes).toEqual([0, 1, 4, 7].map((minutes) => minutes * MINUTE));
  });

  it("runs one pass at a time: ticks while a pass is in flight start none", async () => {
    let release = (): void => undefined;
    let held = true;
    const pass = () => (held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve());
    const h = harness({ sources: "polling", pollingIntervalMs: MINUTE }, pass);
    void h.sweep.tick();

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(h.passes).toEqual([0]);

    held = false;
    release();
    await vi.advanceTimersByTimeAsync(DUE_CHECK_TICK_MS);
    expect(h.passes).toEqual([0, 5 * MINUTE + DUE_CHECK_TICK_MS]);
  });

  it("starts no pass once halted", async () => {
    const h = await started(harness({ sources: "polling", pollingIntervalMs: MINUTE }));

    h.sweep.halt();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(h.passes).toEqual([0]);
  });
});

describe("reconciler schedule mode change (I5)", () => {
  it("logs one line and runs a catch-up pass within one tick when the kill switch flips", async () => {
    const h = await started(harness(WEBHOOK));
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.passes).toEqual([0]);

    h.set(KILL_SWITCH);
    await vi.advanceTimersByTimeAsync(DUE_CHECK_TICK_MS);

    expect(h.passes).toEqual([0, MINUTE + DUE_CHECK_TICK_MS]);
    expect(sourceLines(h)).toEqual([{ msg: "github sources: webhook → polling (kill-switch)", fields: { from: "webhook", to: "polling", reason: "kill-switch" } }]);
  });

  it("then passes at the polling interval, and logs again only on the next change", async () => {
    const h = await started(harness(WEBHOOK));
    h.set(KILL_SWITCH);
    await vi.advanceTimersByTimeAsync(DUE_CHECK_TICK_MS);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(h.passes).toEqual([0, 15_000, 75_000, 135_000]);

    h.set(WEBHOOK);
    await vi.advanceTimersByTimeAsync(DUE_CHECK_TICK_MS);
    expect(sourceLines(h).map((line) => line.fields)).toEqual([
      { from: "webhook", to: "polling", reason: "kill-switch" },
      { from: "polling", to: "webhook", reason: "configured" },
    ]);
    expect(h.passes.at(-1)).toBe(150_000);
  });

  it("logs nothing when only the interval changes", async () => {
    const h = await started(harness({ sources: "polling" }));

    h.set({ sources: "polling", pollingIntervalMs: 2 * MINUTE });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(sourceLines(h)).toEqual([]);
  });
});
