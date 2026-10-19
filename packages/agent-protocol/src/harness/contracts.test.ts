import { describe, expect, expectTypeOf, it } from "vitest";
import { EXECUTION_CAPABILITIES } from "./index.js";
import type { BoundedRunBase, HarnessCapabilityDescriptor, HarnessRunProgress, HarnessRunResult } from "./index.js";

describe("SDK-free harness contracts", () => {
  it("carries a third harness through request callbacks and results", () => {
    const progress: HarnessRunProgress<"fixture-third"> = {
      harness: "fixture-third", atMs: 1, kind: "execution_started", execution: { executionId: "run-1" },
    };
    const events: HarnessRunProgress<"fixture-third">[] = [];
    const request: BoundedRunBase<"fixture-third"> = {
      prompt: "review", cwd: "/fixture", target: { kind: "fresh", namespace: "corpus" }, wallTimeMs: 1,
      onProgress(event) {
        expectTypeOf(event.harness).toEqualTypeOf<"fixture-third">();
        events.push(event);
      },
    };
    request.onProgress?.(progress);
    const result: HarnessRunResult<string, "fixture-third"> = {
      ok: false, harness: "fixture-third", usage: [], failure: { kind: "cancelled_unknown", reason: "unknown outcome" },
    };
    expect(events).toEqual([progress]);
    expect(result.failure.kind).toBe("cancelled_unknown");
  });

  it("keeps unsupported and unverified assessments explicit", () => {
    const capabilities = Object.fromEntries(EXECUTION_CAPABILITIES.map((name) => [name, {
      status: "unverified" as const, reason: "fixture has no runtime evidence",
    }]));
    expect(capabilities).toHaveProperty("resume", { status: "unverified", reason: "fixture has no runtime evidence" });
    expectTypeOf<HarnessCapabilityDescriptor<"fixture-third">["harness"]>().toEqualTypeOf<"fixture-third">();
  });
});
