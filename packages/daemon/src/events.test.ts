import { describe, expect, it } from "vitest";
import { EventHub, type SseMessage } from "./events.js";

const message: SseMessage = { event: "change", data: "root" };

describe("EventHub", () => {
  it("delivers broadcasts to every subscriber", () => {
    const hub = new EventHub();
    const seen: string[] = [];
    hub.subscribe(() => {
      seen.push("a");
    });
    hub.subscribe(() => {
      seen.push("b");
    });

    hub.broadcast(message);

    expect(seen).toEqual(["a", "b"]);
    expect(hub.size).toBe(2);
  });

  it("stops delivering after unsubscribe", () => {
    const hub = new EventHub();
    let count = 0;
    const unsubscribe = hub.subscribe(() => {
      count++;
    });

    hub.broadcast(message);
    unsubscribe();
    hub.broadcast(message);

    expect(count).toBe(1);
    expect(hub.size).toBe(0);
  });

  it("drops a throwing subscriber without disturbing the others", () => {
    const hub = new EventHub();
    let delivered = 0;
    hub.subscribe(() => {
      throw new Error("dead connection");
    });
    hub.subscribe(() => {
      delivered++;
    });

    expect(() => hub.broadcast(message)).not.toThrow();
    hub.broadcast(message);

    expect(delivered).toBe(2);
    expect(hub.size).toBe(1);
  });

  it("drops a subscriber whose async send rejects", async () => {
    const hub = new EventHub();
    hub.subscribe(() => Promise.reject(new Error("closed")));

    hub.broadcast(message);
    await Promise.resolve();

    expect(hub.size).toBe(0);
  });
});
