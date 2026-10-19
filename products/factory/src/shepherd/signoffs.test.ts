import { describe, expect, it } from "vitest";
import { requiredSignoffs } from "./signoffs.js";

describe("the sign-offs a PR class needs", () => {
  it("asks a standard PR for one correctness sign-off", () => {
    expect(requiredSignoffs({ touches: [], paths: ["packages/x/src/a.ts"] })).toEqual(["correctness"]);
  });

  it("asks a g10 PR (large, dependency, migration, security kind) for correctness alone", () => {
    expect(requiredSignoffs({ touches: ["migration", "dependency", "perf"], paths: ["products/factory/src/shepherd/store.ts", "package.json"] })).toEqual(["correctness"]);
  });

  it.each(["authority", "policy", "security"])("adds an adversary for a %s path touch", (touch) => {
    expect(requiredSignoffs({ touches: [touch], paths: ["packages/x/src/a.ts"] })).toEqual(["correctness", "adversary"]);
  });

  it("adds the owner to the adversary for the owner's own rule file", () => {
    expect(requiredSignoffs({ touches: ["authority"], paths: ["packages/authority/src/table.json"] })).toEqual(["correctness", "adversary", "owner"]);
  });

  it("asks a visual PR for correctness and the owner's visual approval", () => {
    expect(requiredSignoffs({ touches: ["visual"], paths: ["apps/console/src/home.tsx"] })).toEqual(["correctness", "owner"]);
  });
});
