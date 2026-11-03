import { describe, expect, it } from "vitest";
import { relativeImports } from "../test-support/relative-imports.js";

/** The files whose port types moved into ports.ts; phases.ts reading one of them again would re-close the hub. */
const PORT_SOURCES = ["./cleanup.js", "./exit-notice.js", "./spawn-gate.js", "./review-queue.js", "./review-dispatcher.js", "./roster.js", "./suite-host.js", "./review-checkout.js", "./task-close.js"];

describe("shepherd ports leaf", () => {
  it("ports.ts imports nothing in factory but presence", () => {
    expect(relativeImports("shepherd/ports.ts")).toEqual(["./presence.js"]);
  });

  it("phases.ts takes its shepherd ports from ports.ts, never from the files that implement them", () => {
    const imports = relativeImports("shepherd/phases.ts");

    expect(imports).toContain("./ports.js");
    expect(imports.filter((specifier) => PORT_SOURCES.includes(specifier))).toEqual([]);
  });
});
