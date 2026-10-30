import { describe, expect, it } from "vitest";

import { parseProfile } from "./index.js";

function load(body: Record<string, unknown>) {
  const base = { model: "opus", allowedTools: ["Read"], isolation: "none", surface: "iterm-pane" };
  return parseProfile("p", { ...base, ...body });
}

describe("the remoteControl profile field (CC-924)", () => {
  it("loads on a coordinator profile", () => {
    expect(load({ role: "coordinator", remoteControl: true })).toMatchObject({ remoteControl: true });
  });

  it("refuses a worker profile that sets it, and one with no role", () => {
    expect(load({ role: "worker", remoteControl: true })).toMatchObject({
      error: expect.stringMatching(/"remoteControl" needs "role": "coordinator"/),
    });
    expect(load({ remoteControl: true })).toHaveProperty("error");
  });

  it("refuses a value that is not a boolean", () => {
    expect(load({ role: "coordinator", remoteControl: "yes" })).toMatchObject({
      error: expect.stringMatching(/"remoteControl" must be true or false/),
    });
  });

  it("accepts false on a worker, and leaves it off the loaded profile", () => {
    const profile = load({ role: "worker", remoteControl: false });
    expect(profile).not.toHaveProperty("error");
    expect(profile).not.toHaveProperty("remoteControl");
  });
});
