import { describe, expect, it } from "vitest";
import { EXIT } from "./envelope.js";
import { EVENTS_PATH, HEALTH_PATH, RPC_PREFIX, VERSION_PATH, rpcFailureStatus } from "./routes.js";
import { SSE_EVENTS, SSE_HEARTBEAT_MS, SSE_READY_DATA } from "./sse.js";

describe("routes", () => {
  it("names the paths existing daemons and clients already use", () => {
    expect([RPC_PREFIX, EVENTS_PATH, HEALTH_PATH, VERSION_PATH]).toEqual(["/rpc/", "/events", "/health", "/version"]);
  });

  it("maps only DATAERR failures to 400", () => {
    expect(rpcFailureStatus(EXIT.DATAERR)).toBe(400);
    expect(rpcFailureStatus(EXIT.USAGE)).toBe(500);
    expect(rpcFailureStatus(EXIT.CONFIG)).toBe(500);
  });
});

describe("sse vocabulary", () => {
  it("reserves ready and ping with a 25 second heartbeat", () => {
    expect(SSE_EVENTS).toEqual({ READY: "ready", PING: "ping" });
    expect(SSE_READY_DATA).toBe("connected");
    expect(SSE_HEARTBEAT_MS).toBe(25_000);
  });
});
