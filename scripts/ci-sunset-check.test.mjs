import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const step = workflow.jobs.validate.steps.find((candidate) => candidate.run?.includes("sunset-manifest.mjs"));

describe("validate job sunset check", () => {
  it("runs the sunset manifest check against a clone of agent-chat", () => {
    expect(step.run).toContain("git clone --depth 1 https://github.com/HJewkes/agent-chat");
    expect(step.run).toMatch(/sunset-manifest\.mjs check --agent-chat "\$RUNNER_TEMP\/agent-chat"/);
  });

  it("only warns on agent-chat drift and records the cloned sha", () => {
    expect(step.run).toContain("--agent-chat-drift warn");
    expect(step.run).toContain("$GITHUB_STEP_SUMMARY");
  });
});
