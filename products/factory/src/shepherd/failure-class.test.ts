import { GhError } from "@titan-design/github";
import { StepFailedError, WorkflowCancelledError, type WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { ShepherdFailure, classifyingFailures, failureClassOf, stepFailureClass } from "./failure-class.js";
import { partialFake } from "@titan-design/test-kit";
import { errorMessage } from "../narrow.js";

const ghFailure = (args: string, said: string, rateLimit = "") => new GhError(args.split(" "), { code: 1, stdout: "", stderr: said }, undefined, rateLimit);
const LIMIT = "[gh-rate-limit status=403 method=GET x-ratelimit-remaining=0 x-ratelimit-reset=1760295660]";

describe("a legacy row without the field is still classified", () => {
  it("files a ci-wait timeout as ci-timeout", () => {
    expect(failureClassOf("step ci-wait:r1:0 (iteration 0) failed: ci-wait timed out after 2700000 ms: waiting on check", null)).toBe("ci-timeout");
  });

  it("files a land-rules refusal as land-rules", () => {
    expect(failureClassOf("step land-rules (iteration 0) failed: acme/widgets@main requires no status checks; land waits on required checks only, so it refuses", null)).toBe("land-rules");
  });

  it("files a GitHub server error, a dropped connection and an empty body as gh-api-5xx", () => {
    expect(failureClassOf("step merge:0 (iteration 0) failed: gh api -i -X GET failed (1): gh: HTTP 504", null)).toBe("gh-api-5xx");
    expect(failureClassOf("step merge:0 (iteration 0) failed: gh api -i -X GET failed (1): error connecting to api.github.com\ncheck your internet connection", undefined)).toBe("gh-api-5xx");
    expect(failureClassOf("step update-branch:r2:0 (iteration 0) failed: gh api -i -X PUT failed (1): unexpected end of JSON input", null)).toBe("gh-api-5xx");
    expect(failureClassOf("step merge:0 (iteration 0) failed: gh api -i -X GET failed (1): ", null)).toBe("gh-api-5xx");
  });

  it("files a read GitHub never answered as gh-api-5xx and a timed-out write as other", () => {
    const read = "gh api -X GET repos/acme/widgets/pulls?state=open&per_page=100 failed (1): GET /repos/acme/widgets/pulls?state=open&per_page=100 timed out after 60000 ms";
    const write = "gh api -X PUT repos/acme/widgets/pulls/1/merge failed (1): PUT /repos/acme/widgets/pulls/1/merge timed out after 60000 ms";
    expect(failureClassOf(`step sh-observe:abc (iteration 0) failed: ${read} (after 1 gh-api-5xx retries)`, null)).toBe("gh-api-5xx");
    expect(failureClassOf(`step merge:0 (iteration 0) failed: ${write}`, null)).toBe("other");
  });

  it("files an update-branch conflict or stuck head as update-branch, not as a GitHub outage", () => {
    expect(failureClassOf("step update-branch:0 (iteration 0) failed: gh api -i -X PUT failed (1): gh: merge conflict between base and head (HTTP 422)", null)).toBe("update-branch");
    expect(failureClassOf("step update-branch:1 (iteration 0) failed: update-branch: head still abc123 after 300000 ms", null)).toBe("update-branch");
  });

  it("files a transport-marked rate limit as gh-rate-limit, on a land-rules read too, and limit text without the marker as other", () => {
    const marked = `${LIMIT} gh api -i repos/acme/widgets/pulls/1 failed (1): gh: API rate limit exceeded for user ID 1. (HTTP 403)`;
    expect(failureClassOf(`step sh-observe:abc (iteration 0) failed: ${marked}`, null)).toBe("gh-rate-limit");
    expect(failureClassOf(`step land-rules (iteration 0) failed: ${marked}`, null)).toBe("gh-rate-limit");
    expect(failureClassOf("step sh-observe:abc (iteration 0) failed: gh api -i -X GET failed (1): API rate limit exceeded", null)).toBe("other");
  });

  it("files anything else as other", () => {
    expect(failureClassOf("step merge:0 (iteration 0) failed: gh api -i -X PUT failed (1): gh: Base branch was modified. (HTTP 405)", null)).toBe("other");
    expect(failureClassOf("workflow returned while step ci-wait:r3:17 still required reconciliation", null)).toBe("other");
  });

  it("reads the class from a prefix rather than the text after it", () => {
    expect(failureClassOf("[land-rules] ci-wait timed out after 1 ms", null)).toBe("land-rules");
  });
});

describe("a row with the field", () => {
  it("is filed under its recorded class whatever its text says", () => {
    expect(failureClassOf("[land-rules] ci-wait timed out after 1 ms", "update-branch")).toBe("update-branch");
  });

  it("is filed as other when it recorded a class this build does not know, never by its text", () => {
    expect(failureClassOf("step ci-wait:0 (iteration 0) failed: ci-wait timed out after 1 ms", "retired-class")).toBe("other");
  });
});

describe("the class a failing code step records", () => {
  it("ci-timeout: a thrown ShepherdFailure keeps its class, wrapped or not", () => {
    const timedOut = new ShepherdFailure("ci-timeout", "ci-wait timed out after 1 ms: waiting on check");

    expect(stepFailureClass("ci-wait", timedOut)).toBe("ci-timeout");
    expect(stepFailureClass("merge", new Error("wrapped", { cause: timedOut }))).toBe("ci-timeout");
  });

  it("gh-api-5xx: a GitHub server error, a dropped connection and an unanswered read, but not a timed-out write", () => {
    expect(stepFailureClass("merge", ghFailure("api -i -X GET", "gh: HTTP 504"))).toBe("gh-api-5xx");
    expect(stepFailureClass("sh-observe", ghFailure("api -i -X GET", "error connecting to api.github.com"))).toBe("gh-api-5xx");
    expect(stepFailureClass("sh-observe", ghFailure("api -X GET repos/acme/widgets/pulls", "GET /repos/acme/widgets/pulls timed out after 60000 ms"))).toBe("gh-api-5xx");
    expect(stepFailureClass("merge", ghFailure("api -X PUT repos/acme/widgets/pulls/1/merge", "PUT /repos/acme/widgets/pulls/1/merge timed out after 60000 ms"))).toBe("other");
  });

  it("gh-rate-limit: the transport's limit field, on a land-rules read too", () => {
    const limited = ghFailure("api -i repos/acme/widgets/pulls/1", "gh: API rate limit exceeded (HTTP 403)", LIMIT);

    expect(stepFailureClass("sh-observe", limited)).toBe("gh-rate-limit");
    expect(stepFailureClass("land-rules", limited)).toBe("gh-rate-limit");
  });

  it("land-rules: any other failure of the land-rules step, a GitHub server error included", () => {
    expect(stepFailureClass("land-rules", new Error("acme/widgets@main requires no status checks"))).toBe("land-rules");
    expect(stepFailureClass("land-rules", ghFailure("api", "HTTP 503"))).toBe("land-rules");
  });

  it("update-branch: a conflict or stuck head, while a GitHub server error there stays gh-api-5xx", () => {
    expect(stepFailureClass("update-branch", ghFailure("api -i -X PUT", "gh: merge conflict between base and head (HTTP 422)"))).toBe("update-branch");
    expect(stepFailureClass("update-branch", ghFailure("api -i -X PUT", "unexpected end of JSON input"))).toBe("gh-api-5xx");
  });

  it("other: a refusal GitHub meant, or a plain error, in any other step", () => {
    expect(stepFailureClass("merge", ghFailure("api -i -X PUT", "gh: Base branch was modified. (HTTP 405)"))).toBe("other");
    expect(stepFailureClass("merge", new Error("ci-wait timed out after 1 ms"))).toBe("other");
  });
});

describe("classifyingFailures", () => {
  const ctx = partialFake<WorkflowContext>();
  const rejected = (error: unknown) => classifyingFailures(() => Promise.reject(error))(ctx).catch((caught: unknown) => caught);

  it("carries a failed step's recorded class as the run's, prefixes the message and keeps the error's identity", async () => {
    const thrown = new StepFailedError("ci-wait:0", 0, "ci-wait timed out after 1 ms", { errorClass: "ci-timeout" });

    const caught = await rejected(thrown);

    expect(caught).toBe(thrown);
    expect(caught).toMatchObject({ errorClass: "ci-timeout", message: "[ci-timeout] step ci-wait:0 (iteration 0) failed: ci-wait timed out after 1 ms" });
  });

  it("classes a failed step that recorded none by its step id", async () => {
    const thrown = new StepFailedError("land-rules", 0, "acme/widgets@main requires no status checks");

    await rejected(thrown);

    expect(thrown).toMatchObject({ errorClass: "land-rules", message: "[land-rules] step land-rules (iteration 0) failed: acme/widgets@main requires no status checks" });
  });

  it("keeps a ShepherdFailure the workflow threw itself, and files any other error as other", async () => {
    expect(await rejected(new ShepherdFailure("ci-timeout", "ci-wait timed out on orphaned checks"))).toMatchObject({ errorClass: "ci-timeout" });
    expect(await rejected(new Error("ci-wait timed out after 1 ms"))).toMatchObject({ errorClass: "other" });
  });

  it("leaves a cancellation's reason alone", async () => {
    const cancelled = new WorkflowCancelledError("run-1", "acme/widgets#7 was merged outside Shepherd");

    await rejected(cancelled);

    expect(cancelled.reason).toBe("acme/widgets#7 was merged outside Shepherd");
  });

  it("turns a thrown non-Error into a classified Error", async () => {
    const caught = await rejected("boom");

    expect(errorMessage(caught)).toBe("[other] boom");
    expect(caught).toMatchObject({ errorClass: "other" });
  });
});
