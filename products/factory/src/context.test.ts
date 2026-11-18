import { describe, expect, it } from "vitest";
import { relativeImports } from "./test-support/relative-imports.js";

describe("factory context leaf", () => {
  it("context.ts imports only the host, the autoresearch config, the shepherd services type and the needs caller leaves", () => {
    expect(relativeImports("context.ts").sort()).toEqual(["./autoresearch/config.js", "./caller.js", "./host.js", "./needs/agent-allow-list.js", "./shepherd/services.js"]);
  });

  it("resolve-command.ts imports nothing in factory", () => {
    expect(relativeImports("resolve-command.ts")).toEqual([]);
  });
});
