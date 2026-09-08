import { describe, expect, it } from "vitest";
import { applyMasks } from "./masks.js";
import { extractSignature, hasErrorSignal } from "./signature.js";

describe("extractSignature", () => {
  it("anchors a Bash blob on the first Error line, then stack frame, then exit status, then last line", () => {
    expect(extractSignature("Bash", "setup\nTypeError: boom\nnoise").anchorLine).toBe("TypeError: boom");
    expect(extractSignature("Bash", "run\n  at Object.<anonymous> (index.js:10:5)\ndone").anchorLine).toBe(
      "at Object.<anonymous> (index.js:10:5)",
    );
    expect(extractSignature("Bash", "run\nprocess exited with exit code 1").anchorLine).toBe(
      "process exited with exit code 1",
    );
    expect(extractSignature("Bash", "first\nsecond\n\n   ").anchorLine).toBe("second");
  });

  it("classifies error codes and test-runner summaries", () => {
    expect(extractSignature("test", "error TS2304: Cannot find name 'foo'.").errorClass).toBe("TS2304");
    expect(extractSignature("test", "Running...\n3 passed, 2 failed\nsee report").anchorLine).toBe("3 passed, 2 failed");
    expect(extractSignature("git", "fatal: not a git repository\nmore").anchorLine).toBe("fatal: not a git repository");
  });

  it("buckets line counts and marks whether the anchor came from a rule", () => {
    expect(extractSignature("Bash", "").lineCountBucket).toBe("0");
    expect(extractSignature("Bash", "a\nb\nc").lineCountBucket).toBe("2-5");
    expect(extractSignature("Bash", Array(8).fill("x").join("\n")).lineCountBucket).toBe("6+");
    expect(extractSignature("Bash", "TypeError: boom").anchored).toBe(true);
    expect(extractSignature("Bash", "total 48\ndrwxr-xr-x").anchored).toBe(false);
  });
});

describe("hasErrorSignal", () => {
  it("accepts failure shapes and rejects ordinary successful output", () => {
    expect(hasErrorSignal("Bash", "ok\nTypeError: boom")).toBe(true);
    expect(hasErrorSignal("Bash", "command failed with exit code 2")).toBe(true);
    expect(hasErrorSignal("Bash", "src/index.ts\nsrc/other.ts")).toBe(false);
    expect(hasErrorSignal("Bash", "")).toBe(false);
  });
});

describe("applyMasks", () => {
  it("masks typed values in rule order and records the first match of each", () => {
    expect(applyMasks("generic", "error TS2304: Cannot find name")).toEqual({
      maskedSignature: "error TS<NUM>: Cannot find name",
      extractedParams: { NUM: "2304" },
    });
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(applyMasks("generic", `request ${uuid} failed`).maskedSignature).toBe("request <UUID> failed");
    expect(applyMasks("generic", "test timed out after 30000 ms").maskedSignature).toBe("test timed out after <DURATION>");
    expect(applyMasks("generic", "retry 1 then retry 2").extractedParams.NUM).toBe("1");
  });

  it("gives structurally identical lines the same masked signature", () => {
    const a = applyMasks("generic", "Cannot find module 'src/a/foo.ts'");
    const b = applyMasks("generic", "Cannot find module 'src/b/bar.ts'");
    expect(a.maskedSignature).toBe(b.maskedSignature);
    expect(a.extractedParams.PATH).toBe("src/a/foo.ts");
  });

  it("falls back to generic for an unregistered partition and honors custom configs", () => {
    expect(applyMasks("SomeTool", "code 404").maskedSignature).toBe(applyMasks("generic", "code 404").maskedSignature);
    const custom = { generic: [{ name: "WORD", pattern: "\\bfoo\\b", flags: "g" }] };
    expect(applyMasks("x", "foo 42 foo", custom)).toEqual({
      maskedSignature: "<WORD> 42 <WORD>",
      extractedParams: { WORD: "foo" },
    });
  });
});
