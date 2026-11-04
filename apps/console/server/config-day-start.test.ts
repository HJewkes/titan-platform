import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";

const HOME = "/srv/tester";

describe("console config day start", () => {
  it("defaults the coordinator day to 07:00 and keeps its summaries under the state dir", () => {
    const config = resolveConfig({}, HOME);

    expect(config).toMatchObject({ dayStart: "07:00", shippedDir: path.join(HOME, ".local/state/titan-console/shipped") });
  });

  it("takes TITAN_CONSOLE_DAY_START and refuses a value that is not HH:MM", () => {
    expect(resolveConfig({ TITAN_CONSOLE_DAY_START: "06:30" }, HOME).dayStart).toBe("06:30");
    expect(() => resolveConfig({ TITAN_CONSOLE_DAY_START: "7am" }, HOME)).toThrow(/TITAN_CONSOLE_DAY_START/);
  });
});
