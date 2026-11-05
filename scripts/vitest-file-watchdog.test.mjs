import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import FileWatchdog, { FILE_LIMIT_MS } from "./vitest-file-watchdog.mjs";

const moduleAt = (path, project = "threads") => ({ project: { name: project }, moduleId: join(process.cwd(), path) });

function watchdog() {
  let at = 0;
  const log = vi.fn();
  const exit = vi.fn();
  const dog = new FileWatchdog({ now: () => at, log, exit });
  return { dog, log, exit, advance: (ms) => (at += ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the file watchdog", () => {
  // TP-4287: a poll under a frozen clock spun its worker; vitest printed nothing for 74 minutes.
  it("names a file still running at the limit and fails the run", () => {
    const { dog, log, exit, advance } = watchdog();
    dog.onTestModuleQueued(moduleAt("products/demo/src/spin.test.ts"));
    dog.onTestModuleQueued(moduleAt("products/demo/src/quick.test.ts", "forks"));
    advance(1_000);
    dog.onTestModuleEnd(moduleAt("products/demo/src/quick.test.ts", "forks"));

    advance(FILE_LIMIT_MS);
    dog.check();

    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("threads products/demo/src/spin.test.ts");
    expect(log.mock.calls[0][0]).not.toContain("quick.test.ts");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("stays quiet while every running file is under the limit", () => {
    const { dog, log, exit, advance } = watchdog();
    dog.onTestModuleQueued(moduleAt("products/demo/src/slow.test.ts"));

    advance(FILE_LIMIT_MS - 1);
    dog.check();

    expect(log).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("checks on its own timer from init until the run ends", () => {
    vi.useFakeTimers();
    const { dog, exit, advance } = watchdog();
    dog.onInit();
    dog.onTestModuleQueued(moduleAt("products/demo/src/spin.test.ts"));
    advance(FILE_LIMIT_MS);

    vi.advanceTimersByTime(30_000);
    dog.onTestRunEnd();

    expect(exit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
