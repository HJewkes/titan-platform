import { describe, expect, it } from "vitest";
import { runTtsConformance } from "./conformance.js";
import { TtsUnsupportedError } from "./errors.js";
import { fakeTts } from "./fake-tts.js";

const MINIMAL = { phonemeInput: [], wordTimestamps: false, speedControl: false } as const;

// Mutations caught: timings returned when undeclared; the deadline does not bound latency.
runTtsConformance("fakeTts, full capabilities", {
  working: () => fakeTts(),
  unavailable: () => fakeTts({ unavailable: true }),
  hung: () => fakeTts({ latencyMs: 60_000 }),
});

runTtsConformance("fakeTts, text only", {
  working: () => fakeTts({ capabilities: MINIMAL }),
  unavailable: () => fakeTts({ capabilities: MINIMAL, unavailable: true }),
  hung: () => fakeTts({ capabilities: MINIMAL, latencyMs: 60_000 }),
});

describe("fakeTts", () => {
  // Mutation caught: the capability check runs after the engine, so an unsupported call still does work.
  // The engine sleeps 60 s on a timer, so a call that reached it is still pending at the next setImmediate turn.
  it("rejects an unsupported call before any audio is rendered", async () => {
    const tts = fakeTts({ capabilities: MINIMAL, latencyMs: 60_000 });
    const nextTurn = new Promise((resolve) => setImmediate(() => resolve("still pending")));

    const first = await Promise.race([tts.synthesize({ text: "hi" }, "fake-a", { speed: 1.5 }).catch((e: unknown) => e), nextTurn]);

    expect(first).toBeInstanceOf(TtsUnsupportedError);
  });

  // Mutation caught: speed is ignored, so every take has the same length.
  it("renders 0.4 s per word at speed 1, and half that at speed 2", async () => {
    const tts = fakeTts();

    const normal = await tts.synthesize({ text: "a b c" }, "fake-a");
    const fast = await tts.synthesize({ text: "a b c" }, "fake-a", { speed: 2 });

    expect(normal.durationS).toBeCloseTo(1.2, 5);
    expect(fast.durationS).toBeCloseTo(0.6, 5);
    expect(tts.calls).toHaveLength(2);
  });
});
