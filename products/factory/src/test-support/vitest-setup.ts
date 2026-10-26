import type * as NodeOs from "node:os";
import { expect, vi } from "vitest";

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
}
