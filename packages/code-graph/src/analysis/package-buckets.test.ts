import { describe, expect, it } from "vitest";
import { bucketFilesByPackage } from "./package-buckets.js";

describe("bucketFilesByPackage", () => {
  it("assigns files by longest-prefix match", () => {
    const buckets = bucketFilesByPackage(
      ["packages/cli/src/a.ts", "packages/graph/src/b.ts", "scripts/run.ts"],
      [
        { id: "packages/cli", name: "@x/cli" },
        { id: "packages/graph", name: "@x/graph" },
      ],
    );
    expect(buckets.get("packages/cli")).toEqual(["packages/cli/src/a.ts"]);
    expect(buckets.get("packages/graph")).toEqual(["packages/graph/src/b.ts"]);
    expect(buckets.get("")).toEqual(["scripts/run.ts"]);
  });
});
