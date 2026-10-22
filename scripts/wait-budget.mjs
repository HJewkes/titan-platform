// testing-library's findBy*/waitFor, vi.waitFor/waitUntil and expect.poll each give up after 1 s, and a loaded
// 4-vCPU runner stretches a 0.3 s render past that (TP-3983: inbox.test.tsx missed inbox-confirm-outcome and froze
// main). A wait that passes returns as soon as its check holds, so the size costs only a failing test's time. 10 s
// sits well under the 30 s testTimeout, so a missed wait still fails with its own message, not the test's timeout.
export const WAIT_BUDGET_MS = 10_000;
