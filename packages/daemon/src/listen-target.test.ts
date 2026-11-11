import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { holdMcpUntil, readyLatch } from "./listen-target.js";

describe("holdMcpUntil", () => {
  it("makes an /mcp request sent during startup wait for readiness", async () => {
    const handler = vi.fn(async () => undefined);
    const ready = readyLatch();
    const req = new IncomingMessage(new Socket());
    const held = holdMcpUntil(handler, ready.opened);

    const pending = held?.(req, new ServerResponse(req));
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();

    ready.open();
    await pending;
    expect(handler).toHaveBeenCalledOnce();
  });

  it("stays absent when the daemon serves no MCP", () => {
    expect(holdMcpUntil(null, readyLatch().opened)).toBeNull();
  });
});
