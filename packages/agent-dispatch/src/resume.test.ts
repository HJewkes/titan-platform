import { describe, expect, it } from "vitest";

import { ResumeError, resumeArgs } from "./resume.js";

describe("resumeArgs", () => {
  it("guards a resume message that begins with a dash", () => {
    expect(resumeArgs("sess-1", "-1 on that approach")).toEqual([
      "-p",
      "--",
      "-1 on that approach",
      "--resume",
      "sess-1",
    ]);
  });

  it("refuses an empty session id, which would resume some other conversation", () => {
    expect(() => resumeArgs("", "hi")).toThrow(ResumeError);
    expect(() => resumeArgs("sess-1", " ")).toThrow(ResumeError);
  });
});
