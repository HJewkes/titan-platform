import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STORY_PORT, resolveConfig } from "../config.js";
import { smokeEnv } from "./node-ports.js";

const HOME = "/srv/tester";

describe("the smoke build's environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // TP-3934: the smoke build bound the default story port, which the served console holds, and never answered /health.
  it("binds no story origin, even when the served console's unit names one", () => {
    vi.stubEnv("TITAN_CONSOLE_STORY_PORT", String(DEFAULT_STORY_PORT));

    const config = resolveConfig(smokeEnv(41234, "/srv/tester/smoke-state"), HOME);

    expect(config.storyPort).toBeNull();
    expect(config).toMatchObject({ port: 41234, stateDir: "/srv/tester/smoke-state" });
  });

  it("binds no story origin when the served console runs on the default", () => {
    vi.stubEnv("TITAN_CONSOLE_STORY_PORT", undefined);

    expect(resolveConfig(smokeEnv(41234, "/srv/tester/smoke-state"), HOME).storyPort).toBeNull();
  });
});
