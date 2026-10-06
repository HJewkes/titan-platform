import { describe, expect, it } from "vitest";
import { bucketViolations, type BucketableViolation } from "./violation-buckets.js";

const v = (ruleId: string, nodeId: string, value?: number): BucketableViolation => ({ ruleId, nodeId, value });

describe("bucketViolations without a store", () => {
  it("buckets new, resolved, worsened and improved violations by key", () => {
    const from = [v("loc", "a.ts", 10), v("loc", "b.ts", 10), v("loc", "gone.ts", 5), v("cycle", "c.ts")];
    const to = [v("loc", "a.ts", 12), v("loc", "b.ts", 8), v("cycle", "c.ts"), v("loc", "new.ts", 3)];

    const buckets = bucketViolations(from, to);

    expect(buckets.newViolations.map((x) => x.nodeId)).toEqual(["new.ts"]);
    expect(buckets.resolvedViolations.map((x) => x.nodeId)).toEqual(["gone.ts"]);
    expect(buckets.worsened.map((x) => [x.to.nodeId, x.delta])).toEqual([["a.ts", 2]]);
    expect(buckets.improved.map((x) => [x.to.nodeId, x.delta])).toEqual([["b.ts", -2]]);
    expect(buckets.unchanged.map((x) => x.to.nodeId)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("carries from-side ids through the resolver, so a moved file's violation is unchanged", () => {
    const moved = bucketViolations([v("loc", "old.ts", 4)], [v("loc", "new.ts", 4)], (id) => (id === "old.ts" ? "new.ts" : id));

    expect(moved.newViolations).toEqual([]);
    expect(moved.resolvedViolations).toEqual([]);
    expect(moved.unchanged).toHaveLength(1);
  });
});
