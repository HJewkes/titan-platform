import { describe, expect, it } from "vitest";
import { FactoryConfigSchema } from "../config.js";
import { movedPastOnList, type CachedOpenList, type ReviewAsk } from "./review-queue.js";
import { spawnGate, type MachineReadings, type SpawnLimits } from "./spawn-gate.js";

const idle: MachineReadings = { load5: 2, pressureLevel: 1, freeMemoryPct: 85 };
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

/** A gate on a fake clock and fake readings; `ask` reports whether the review was admitted. */
function scene(limits: Partial<SpawnLimits>, options: { readings?: MachineReadings; cached?: CachedOpenList } = {}) {
  const state = { readings: options.readings ?? idle, now: 100_000, lines: [] as string[], running: [] as number[] };
  const gate = spawnGate({ limits, read: () => state.readings, now: () => state.now, log: (line) => void state.lines.push(line), ...(options.cached && { movedPast: movedPastOnList(options.cached) }) });
  const ask = (name: string, review: ReviewAsk) => {
    try {
      gate.admit(name, state.running, review);
      return true;
    } catch {
      return false;
    }
  };
  return { state, gate, ask };
}

const intent = (intentAt: number, fixer = false): ReviewAsk => ({ fixer, intentAt });

describe("the review queue admits from its front up to the free slots", () => {
  it("admits an asker at position 3 while the head has not asked again, when three slots are free", () => {
    const { state, ask } = scene({ maxConcurrentReviews: 3 });
    state.readings = { ...idle, load5: 30 };
    ["rv-a-1", "rv-b-2", "rv-c-3"].forEach((name, index) => ask(name, intent(10_000 * (index + 1))));
    state.readings = idle;

    expect(ask("rv-c-3", intent(30_000))).toBe(true);
    expect(ask("rv-b-2", intent(20_000))).toBe(true);
  });

  it("defers an asker past the free slots, naming the head and the room", () => {
    const { state, ask } = scene({ maxConcurrentReviews: 2 });
    state.readings = { ...idle, load5: 30 };
    ["rv-a-1", "rv-b-2", "rv-c-3"].forEach((name, index) => ask(name, intent(10_000 * (index + 1))));
    state.readings = idle;

    expect(ask("rv-c-3", intent(30_000))).toBe(false);
    expect(state.lines.at(-1)).toContain("deferred rv-c-3: the review rv-a-1 with an older intent waits ahead, 2 free review slots");
  });

  it("bounds the room by what the load check allows: one review at load5 17 under buildLoad5 20", () => {
    const { state, ask } = scene({ maxConcurrentReviews: 8, reviewLoad: 4 });
    state.readings = { ...idle, load5: 30 };
    ask("rv-a-1", intent(10_000));
    ask("rv-b-2", intent(20_000));
    state.readings = { ...idle, load5: 17 };

    expect(ask("rv-b-2", intent(20_000))).toBe(false);
    expect(ask("rv-a-1", intent(10_000))).toBe(true);
  });

  it("keeps fixers first inside the room, so an ordinary review behind a fix and two older intents waits when two slots are free", () => {
    const { state, ask } = scene({ maxConcurrentReviews: 2 });
    state.readings = { ...idle, load5: 30 };
    ask("rv-old-1", intent(10_000));
    ask("rv-new-2", intent(50_000));
    ask("rv-fix-3", intent(90_000, true));
    state.readings = idle;

    expect(ask("rv-new-2", intent(50_000))).toBe(false);
    expect(state.lines.at(-1)).toContain("the review rv-fix-3 of a red main's fix waits ahead");
    expect(ask("rv-old-1", intent(10_000))).toBe(true);
  });
});

describe("admitted reviews count as unabsorbed from their admission", () => {
  const live: Partial<SpawnLimits> = { buildLoad5: 40, load5: 48, reviewLoad: 4, maxConcurrentReviews: 24 };

  it("admits six of 18 reviews asking inside one second at load5 20, not all 18", () => {
    const { state, ask } = scene(live, { readings: { ...idle, load5: 20 } });
    const admitted = Array.from({ length: 18 }, (_, index) => `rv-burst-${index}`).filter((name, index) => {
      state.now += 50;
      return ask(name, intent(10_000 + index));
    });

    expect(admitted).toHaveLength(6);
    expect(state.lines.at(-1)).toContain("load5 with 6 unabsorbed reviews 44 is past the limit 40");
  });

  it("stops counting an admitted review as pending once the roster shows it running, so it is not counted twice", () => {
    const { state, gate, ask } = scene(live, { readings: { ...idle, load5: 20 } });
    const names = ["rv-a-1", "rv-b-2", "rv-c-3", "rv-d-4"];
    names.forEach((name, index) => ask(name, intent(10_000 + index)));
    gate.noteReviewers({ running: names });
    state.running = names.map(() => state.now);

    expect(ask("rv-e-5", intent(20_000))).toBe(true);
    expect(ask("rv-f-6", intent(20_001))).toBe(true);
    expect(ask("rv-g-7", intent(20_002))).toBe(false);
  });

  it("releases an admitted review that never showed once load5 has had five minutes to take it in", () => {
    const { state, ask } = scene({ ...live, maxConcurrentReviews: 1 });
    ask("rv-a-1", intent(10_000));
    expect(ask("rv-b-2", intent(20_000))).toBe(false);

    state.now += 5 * 60_000;

    expect(ask("rv-b-2", intent(20_000))).toBe(true);
  });
});

describe("a queued ask whose run moved past it leaves the queue at once", () => {
  const target = (pr: number, head: string) => ({ repo: "octo/demo", pr, head });
  const listAt = (at: number, prs: { number: number; headSha: string }[]) => ({ at, prs });

  it.each([
    ["moved to a new head", [{ number: 7, headSha: HEAD_B }]],
    ["merged or closed, so it is off the open list", []],
  ])("drops the head of the queue whose PR %s, and lets the next asker in", (_name, prs) => {
    const state = { list: listAt(0, [{ number: 7, headSha: HEAD_A }, { number: 8, headSha: HEAD_A }]) };
    const { state: gateState, ask } = scene({ maxConcurrentReviews: 1 }, { cached: () => state.list });
    gateState.readings = { ...idle, load5: 30 };
    ask("rv-demo-7", { fixer: false, intentAt: 10_000, target: target(7, HEAD_A) });
    ask("rv-demo-8", { fixer: false, intentAt: 20_000, target: target(8, HEAD_A) });
    gateState.readings = idle;

    state.list = listAt(gateState.now, [...prs, { number: 8, headSha: HEAD_A }]);

    expect(ask("rv-demo-8", { fixer: false, intentAt: 20_000, target: target(8, HEAD_A) })).toBe(true);
    expect(gateState.lines).toContain(`shepherd: spawn_gate dropped rv-demo-7: its pull request moved past head ${HEAD_A}`);
  });

  it("judges nothing by a list read before the ask's intent", () => {
    const moved = movedPastOnList(() => listAt(9_999, []));

    expect(moved(target(7, HEAD_A), 10_000)).toBe(false);
    expect(moved(target(7, HEAD_A), 9_998)).toBe(true);
  });

  it("keeps an ask whose PR is still open at its head, and one with no list read", () => {
    expect(movedPastOnList(() => listAt(20_000, [{ number: 7, headSha: HEAD_A }]))(target(7, HEAD_A), 10_000)).toBe(false);
    expect(movedPastOnList(() => undefined)(target(7, HEAD_A), 10_000)).toBe(false);
  });
});

describe("the spawnGate config", () => {
  it("refuses burstMax with a message that says to remove it", () => {
    const parsed = FactoryConfigSchema.safeParse({ shepherd: { spawnGate: { burstMax: 4 } } });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain("burstMax is no longer read: load is the only spawn limiter, so remove the key");
  });

  it("takes the pace windows at 0", () => {
    expect(FactoryConfigSchema.safeParse({ shepherd: { spawnGate: { windowMs: 0, headroomIntervalMs: 0 } } }).success).toBe(true);
  });
});
