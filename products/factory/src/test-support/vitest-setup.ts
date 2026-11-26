import { existsSync, mkdtempSync } from "node:fs";
import type * as NodeOs from "node:os";
import path from "node:path";
import { afterAll, expect, vi } from "vitest";

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
  givePerFileStores();
}

/**
 * The run's setup drops TITAN_FACTORY_DB and TITAN_SCORECARD_STORE, so with nothing set every factory file fell back to
 * one default under the run's shared state home, and parallel files locked each other on it (TP-6754). Each file now
 * names its own pair. A file that still creates either shared default fails here; a file that runs at the same moment
 * in another fork can be blamed instead, so check the other files in flight too.
 */
function givePerFileStores(): void {
  // Read from the environment, not node:os, so this setup never loads the node:os a test file mocks.
  const { XDG_STATE_HOME, XDG_DATA_HOME, HOME = "", TMPDIR = "/tmp" } = process.env;
  const sharedDefaults = [
    path.join(XDG_STATE_HOME ?? path.join(HOME, ".local", "state"), "titan-factory", "factory.sqlite3"),
    path.join(XDG_DATA_HOME ?? path.join(HOME, ".local", "share"), "titan-scorecard", "scorecard.sqlite3"),
  ];
  const presentBefore = sharedDefaults.filter((file) => existsSync(file));
  const dir = mkdtempSync(path.join(TMPDIR, "factory-stores-"));
  process.env.TITAN_FACTORY_DB = path.join(dir, "factory.sqlite3");
  process.env.TITAN_SCORECARD_STORE = path.join(dir, "scorecard.sqlite3");
  afterAll(() => {
    const created = sharedDefaults.filter((file) => !presentBefore.includes(file) && existsSync(file));
    if (created.length > 0) throw new Error(`a factory test created the run-wide shared store ${created.join(", ")}; name a per-test TITAN_FACTORY_DB or TITAN_SCORECARD_STORE instead`);
  });
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
