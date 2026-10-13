import { describe, expect, it } from "vitest";
import { relativeImports } from "../test-support/relative-imports.js";

describe("shepherd services leaf", () => {
  it("services.ts imports only the shepherd stores and snapshot reads it describes", () => {
    expect(new Set(relativeImports("shepherd/services.ts"))).toEqual(new Set(["./freeze.js", "./seats.js", "./store.js", "./train.js", "./snapshot-reads.js", "./gh-gateway-port.js"]));
  });

  it("host.ts does not import the shepherd command registry", () => {
    expect(relativeImports("host.ts")).not.toContain("./shepherd/commands.js");
  });
});
