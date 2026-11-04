import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { createTestRegistry, startTestDaemon } from "./test-fixtures.js";

/**
 * Holds the port briefly. A parallel test's socket can take the freed port before the squatter
 * does; that is the same "briefly held" case, so EADDRINUSE resolves instead of going uncaught.
 */
function squat(port: number, holdMs: number): Promise<void> {
  const squatter: Server = createServer();
  return new Promise<void>((resolve, reject) => {
    squatter.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve() : reject(err)));
    squatter.listen(port, "127.0.0.1", () => {
      setTimeout(() => squatter.close(), holdMs);
      resolve();
    });
  });
}

describe("startTestDaemon", () => {
  it("restarts on the same port once another socket that briefly held it lets go", async () => {
    const daemon = await startTestDaemon(createTestRegistry());
    const port = daemon.handle.port;
    try {
      await daemon.handle.close();
      await squat(port, 100);

      await daemon.restart();

      expect(daemon.handle.port).toBe(port);
      expect((await fetch(`${daemon.origin}/health`)).ok).toBe(true);
    } finally {
      await daemon.close();
    }
  });
});
