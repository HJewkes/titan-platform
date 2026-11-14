import { describe, expect, it } from "vitest";
import { classifyError, denialOf } from "./tool-error-class.js";

describe("denialOf", () => {
  it("reads the classifier's bracketed reason", () => {
    const text = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Merge Without Review]";
    expect(denialOf(text)).toEqual({ kind: "classifier", reason: "Merge Without Review" });
  });

  it("reads a classifier refusal that carries no reason", () => {
    expect(denialOf("denied by the Claude Code auto mode classifier")).toEqual({ kind: "classifier" });
  });

  it("reads the deny-list and the was-denied wordings as permission", () => {
    expect(denialOf("Error: Permission to use Bash with command ls has been denied.")).toEqual({ kind: "permission" });
    expect(denialOf("The call was denied")).toEqual({ kind: "permission" });
  });

  it("reads the permission-hook deadline", () => {
    expect(denialOf("permission-hook deadline exceeded")).toEqual({ kind: "hook-deadline" });
  });

  it("returns null for other text and agrees with classifyError on denials", () => {
    expect(denialOf("Exit code 1")).toBeNull();
    expect(classifyError("classifier. Reason: [x]")).toBe("classifier-denial");
  });
});
