import { SURFACE_NAMES as WIRE_SURFACE_NAMES } from "@titan-design/agent-protocol/wire";
import { describe, expect, it } from "vitest";
import { SURFACE_NAMES } from "./types.js";

describe("surface names", () => {
  it("match the copy agent-protocol's wire contract keeps, since it sits a tier below and cannot import this one", () => {
    expect([...WIRE_SURFACE_NAMES]).toEqual([...SURFACE_NAMES]);
  });
});
