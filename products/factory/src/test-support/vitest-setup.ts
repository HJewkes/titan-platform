import type * as NodeOs from "node:os";
import { expect, vi } from "vitest";

const FACTORY_WAIT_INTERVAL_MS = 5;

// In a factory test file, the passwd entry's home becomes a fresh dir under the run's temp root, so the bot token path
// a test resolves (`bot-token-path.ts`) is never the owner's, and a serve a test starts with no `bot` option can never
// read the real bot token (TP-3419). The username stays real. Other packages keep the real entry: tool-guard's tests
// check it.
if (expect.getState().testPath?.includes("/products/factory/") === true) {
  vi.doMock("node:os", async (importOriginal) => {
    const os = await importOriginal<typeof NodeOs>();
    const { mkdtempSync } = await import("node:fs");
    const homedir = mkdtempSync(`${os.tmpdir()}/passwd-home-`);
    return { ...os, userInfo: (options?: { encoding: BufferEncoding }) => ({ ...os.userInfo(options), homedir }) };
  });
  pollWaitsFaster();
}

/**
 * vi.waitFor's 50 ms default poll was 44% of the slowest factory host files' test time: a run on a fake clock settles in
 * a few ms, then the test sat out the rest of the poll (TP-4493). An explicit interval still wins. The marker lives on
 * `vi`, so a worker that shares one module graph across files (isolate:false) wraps once, under the wait budget's wrap.
 */
function pollWaitsFaster(): void {
  const marker = Symbol.for("titan-platform.factory-wait-interval");
  const marked = vi as typeof vi & { [marker]?: true };
  if (marked[marker]) return;
  marked[marker] = true;
  const wait = vi.waitFor;
  vi.waitFor = (callback, options = {}) =>
    wait(callback, typeof options === "number" ? { timeout: options, interval: FACTORY_WAIT_INTERVAL_MS } : { ...options, interval: options.interval ?? FACTORY_WAIT_INTERVAL_MS });
}
