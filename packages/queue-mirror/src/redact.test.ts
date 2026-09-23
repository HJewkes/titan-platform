import { describe, expect, it } from "vitest";
import { redactPreview } from "./redact.js";

describe("redactPreview", () => {
  it("masks bearer and basic credentials but keeps the scheme word", () => {
    expect(redactPreview("Authorization: Bearer abc.def-ghi")).toEqual({
      text: "Authorization: Bearer [REDACTED]",
      redacted: true,
    });
    expect(redactPreview("authorization: basic dXNlcjpwYXNz==").text).toBe("authorization: basic [REDACTED]");
  });

  it("masks key, token and password values and keeps the next query parameter", () => {
    expect(redactPreview("API_KEY=x ./run").text).toBe("API_KEY=[REDACTED] ./run");
    expect(redactPreview("deploy --token=x --force").text).toBe("deploy --token=[REDACTED] --force");
    expect(redactPreview('{"password": "hunter 2"}').text).toBe('{"password": [REDACTED]}');
    expect(redactPreview("GET /api?access_token=x&y=1").text).toBe("GET /api?access_token=[REDACTED]&y=1");
  });

  it("masks 32- and 64-character hex runs and a mixed 44-character base64 key", () => {
    const b64 = "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9d=";
    expect(redactPreview(`sha256 ${"ab12".repeat(16)}`).text).toBe("sha256 [REDACTED]");
    expect(redactPreview(`id ${"0f".repeat(16)}`).text).toBe("id [REDACTED]");
    expect(redactPreview(`secret ${b64} end`)).toEqual({ text: "secret [REDACTED] end", redacted: true });
  });

  it("leaves a 40-character git SHA alone", () => {
    const text = "git checkout 0123456789abcdef0123456789abcdef01234567";
    expect(redactPreview(text)).toEqual({ text, redacted: false });
  });

  it("leaves paths, URLs, kebab names and a 31-character hex run alone", () => {
    const clean = [
      "ls /Users/x/projects/titan-platform/packages",
      "open https://github.com/HJewkes/titan-platform/pull/123",
      "pnpm add titan-platform-queue-mirror-package-name",
      "echo 0123456789abcdef0123456789abcde",
      "cat src/Sub2Dir/queue-mirror/src/MemoryMirrorState2.test.ts",
    ];
    for (const text of clean) expect(redactPreview(text)).toEqual({ text, redacted: false });
  });
});
