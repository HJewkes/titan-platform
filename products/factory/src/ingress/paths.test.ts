import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath } from "../config.js";
import { webhookSecretPath } from "./paths.js";

describe("webhook secret path", () => {
  it("sits in a secrets directory beside the factory config under XDG_CONFIG_HOME", () => {
    const env = { XDG_CONFIG_HOME: "/synthetic/xdg" };

    expect(webhookSecretPath(env)).toBe("/synthetic/xdg/titan-factory/secrets/github-webhook.token");
    expect(dirname(dirname(webhookSecretPath(env)))).toBe(dirname(configPath(env)));
  });

  it("ends in .token so the tool-guard token glob covers it", () => {
    expect(webhookSecretPath({ XDG_CONFIG_HOME: join("/synthetic", "x") })).toMatch(/\/titan-factory\/.+\.token$/);
  });
});
