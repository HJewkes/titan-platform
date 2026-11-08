import { describe, expect, it } from "vitest";
import { alive } from "./eval-driver.test-helpers.js";

const failing = (code: string) => (): never => {
  throw Object.assign(new Error(`${code}: simulated`), { code });
};

describe("alive", () => {
  it("reports a live process whose stat reads normally", () => {
    expect(alive(process.pid)).toBe(true);
  });

  it.each(["ESRCH", "ENOENT"])("reports not alive when the stat read fails with %s after the process exited", (code) => {
    expect(alive(process.pid, failing(code))).toBe(false);
  });

  it("rethrows any other read failure", () => {
    expect(() => alive(process.pid, failing("EACCES"))).toThrow("EACCES");
  });
});
