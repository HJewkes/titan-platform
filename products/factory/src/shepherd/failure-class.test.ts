import { StepFailedError, WorkflowCancelledError, type WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { classifyingFailures, failureClassOf, withFailureClass } from "./failure-class.js";
import { partialFake } from "@titan-design/test-kit";
import { errorMessage } from "../narrow.js";

describe("failureClassOf", () => {
  it("files a ci-wait timeout as ci-timeout", () => {
    expect(failureClassOf("step ci-wait:r1:0 (iteration 0) failed: ci-wait timed out after 2700000 ms: waiting on check")).toBe("ci-timeout");
  });

  it("files a land-rules refusal as land-rules", () => {
    expect(failureClassOf("step land-rules (iteration 0) failed: acme/widgets@main requires no status checks; land waits on required checks only, so it refuses")).toBe("land-rules");
  });

  it("files a GitHub server error, a dropped connection and an empty body as gh-api-5xx", () => {
    expect(failureClassOf("step merge:0 (iteration 0) failed: gh api -i -X GET failed (1): gh: HTTP 504")).toBe("gh-api-5xx");
    expect(failureClassOf("step merge:0 (iteration 0) failed: gh api -i -X GET failed (1): error connecting to api.github.com\ncheck your internet connection")).toBe("gh-api-5xx");
    expect(failureClassOf("step update-branch:r2:0 (iteration 0) failed: gh api -i -X PUT failed (1): unexpected end of JSON input")).toBe("gh-api-5xx");
    expect(failureClassOf("step merge:0 (iteration 0) failed: gh api -i -X GET failed (1): ")).toBe("gh-api-5xx");
  });

  it("files an update-branch conflict or stuck head as update-branch, not as a GitHub outage", () => {
    expect(failureClassOf("step update-branch:0 (iteration 0) failed: gh api -i -X PUT failed (1): gh: merge conflict between base and head (HTTP 422)")).toBe("update-branch");
    expect(failureClassOf("step update-branch:1 (iteration 0) failed: update-branch: head still abc123 after 300000 ms")).toBe("update-branch");
  });

  it("files a transport-marked rate limit as gh-rate-limit, on a land-rules read too, and limit text without the marker as other", () => {
    const marked = "[gh-rate-limit status=403 method=GET x-ratelimit-remaining=0 x-ratelimit-reset=1760295660] gh api -i repos/acme/widgets/pulls/1 failed (1): gh: API rate limit exceeded for user ID 1. (HTTP 403)";
    expect(failureClassOf(`step sh-observe:abc (iteration 0) failed: ${marked}`)).toBe("gh-rate-limit");
    expect(failureClassOf(`step land-rules (iteration 0) failed: ${marked}`)).toBe("gh-rate-limit");
    expect(failureClassOf("step sh-observe:abc (iteration 0) failed: gh api -i -X GET failed (1): API rate limit exceeded")).toBe("other");
  });

  it("files anything else as other", () => {
    expect(failureClassOf("step merge:0 (iteration 0) failed: gh api -i -X PUT failed (1): gh: Base branch was modified. (HTTP 405)")).toBe("other");
    expect(failureClassOf("workflow returned while step ci-wait:r3:17 still required reconciliation")).toBe("other");
  });

  it("reads the class from a prefix rather than the text after it", () => {
    expect(failureClassOf("[land-rules] ci-wait timed out after 1 ms")).toBe("land-rules");
  });
});

describe("withFailureClass", () => {
  it("prefixes the text once with its class", () => {
    const once = withFailureClass("step ci-wait:4 (iteration 0) failed: ci-wait timed out after 2700000 ms: waiting on check");

    expect(once).toBe("[ci-timeout] step ci-wait:4 (iteration 0) failed: ci-wait timed out after 2700000 ms: waiting on check");
    expect(withFailureClass(once)).toBe(once);
  });
});

describe("classifyingFailures", () => {
  const ctx = partialFake<WorkflowContext>();

  it("prefixes a failed step's message and keeps the error's identity", async () => {
    const thrown = new StepFailedError("land-rules", 0, "acme/widgets@main requires no status checks");

    const caught = await classifyingFailures(() => Promise.reject(thrown))(ctx).catch((error: unknown) => error);

    expect(caught).toBe(thrown);
    expect(thrown.message).toBe("[land-rules] step land-rules (iteration 0) failed: acme/widgets@main requires no status checks");
  });

  it("leaves a cancellation's reason alone", async () => {
    const cancelled = new WorkflowCancelledError("run-1", "acme/widgets#7 was merged outside Shepherd");

    await classifyingFailures(() => Promise.reject(cancelled))(ctx).catch(() => undefined);

    expect(cancelled.reason).toBe("acme/widgets#7 was merged outside Shepherd");
  });

  it("turns a thrown non-Error into a classified Error", async () => {
    const caught = await classifyingFailures(() => Promise.reject("boom"))(ctx).catch((error: unknown) => error);

    expect(errorMessage(caught)).toBe("[other] boom");
  });
});
