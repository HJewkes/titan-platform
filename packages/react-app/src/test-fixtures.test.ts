import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { createTestRegistry, startTestDaemon } from "./test-fixtures.js";

describe("startTestDaemon", () => {
  it("restarts on the same port once another socket that briefly held it lets go", async () => {
    const daemon = await startTestDaemon(createTestRegistry());
    const port = daemon.handle.port;
    try {
      await daemon.handle.close();
      const squatter = createServer();
      await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));
      setTimeout(() => squatter.close(), 100);

      await daemon.restart();

      expect(daemon.handle.port).toBe(port);
      expect((await fetch(`${daemon.origin}/health`)).ok).toBe(true);
    } finally {
      await daemon.close();
    }
  });
});
