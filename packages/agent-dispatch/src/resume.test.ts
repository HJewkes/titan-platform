import { describe, expect, it } from "vitest";

import { ResumeError, buildResumeAgentArgs, resumeArgs } from "./resume.js";

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

describe("buildResumeAgentArgs", () => {
  it("leaves a caller that does not opt in with exactly the argv it had before launchedBy", () => {
    expect(buildResumeAgentArgs("agent-x", "CI is red")).toEqual(["agent", "resume", "agent-x", "--message", "CI is red"]);
  });

  it("records a Shepherd launch and its reason", () => {
    expect(buildResumeAgentArgs("agent-x", "CI is red", { launchedBy: "shepherd", launchReason: "fix round" })).toEqual([
      "agent", "resume", "agent-x", "--message", "CI is red", "--launched-by", "shepherd", "--launch-reason", "fix round",
    ]);
  });
});
