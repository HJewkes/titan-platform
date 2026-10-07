import { it } from "vitest";

// Opt-in probe for the per-worker heap cap in vitest.config.ts: VITEST_HEAP_PROBE=1 pnpm vitest run scripts/heap-cap.probe.mjs.
// It mirrors tp#607's runaway: a wait whose sleep resolves at once loops on microtasks only, so testTimeout never fires.
it("ends with an out-of-memory error once the worker passes its heap cap", async () => {
  const retained = [];
  for (;;) {
    retained.push(new Array(1_000_000).fill(retained.length));
    await Promise.resolve();
  }
});
