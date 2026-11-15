import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { closeOnSignal } from "./close-on-signal.js";

function setup(onClose: () => Promise<void>) {
  const signals = new EventEmitter();
  const order: string[] = [];
  const close = vi.fn(async () => {
    order.push("close");
  });
  closeOnSignal({ close }, async () => {
    order.push("onClose");
    await onClose();
  }, signals);
  return { signals, order, close };
}

describe("closeOnSignal", () => {
  it("runs onClose then closes the handle once on SIGTERM", async () => {
    const { signals, order, close } = setup(async () => {});

    signals.emit("SIGTERM");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

    expect(order).toEqual(["onClose", "close"]);
  });

  it("closes the handle when onClose rejects", async () => {
    const { signals, close } = setup(async () => {
      throw new Error("vite failed to stop");
    });

    signals.emit("SIGINT");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("closes the handle without an onClose", async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => {});
    closeOnSignal({ close }, undefined, signals);

    signals.emit("SIGTERM");

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
