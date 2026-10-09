import { afterEach, describe, expect, it, vi } from "vitest";
import { timestampConsole } from "./serve-log.js";

const AT = new Date("2026-10-08T21:14:03.120Z");
const restores: (() => void)[] = [];
afterEach(() => {
  restores.splice(0).forEach((restore) => restore());
  vi.restoreAllMocks();
});

describe("timestampConsole", () => {
  it("prefixes each stderr line with its ISO time and leaves the message text as it was", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    restores.push(timestampConsole(() => AT));

    console.error("[info] daemon started", { pid: 7 });
    console.warn("shepherd: spawn_gate deferred rv-1");

    expect(error).toHaveBeenCalledWith("2026-10-08T21:14:03.120Z [info] daemon started", { pid: 7 });
    expect(warn).toHaveBeenCalledWith("2026-10-08T21:14:03.120Z shepherd: spawn_gate deferred rv-1");
  });

  it("puts the console back as it was once restored", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    timestampConsole(() => AT)();

    console.error("plain");

    expect(error).toHaveBeenCalledWith("plain");
  });
});
