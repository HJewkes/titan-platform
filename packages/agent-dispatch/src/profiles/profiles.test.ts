import { describe, expect, it } from "vitest";

import { parseProfile, type AgentProfile } from "./index.js";

/**
 * Ported from agent-chat, whose cases read two of its shipped profile files. Here the files are
 * synthetic stand-ins of the same shape, so the cases check what parsing keeps of each shape. The
 * pinned prelude text and the `--tools` launch check stay with the files and the launch plan.
 */

function parsed(name: string, body: Record<string, unknown>): AgentProfile {
  const profile = parseProfile(name, body);
  if ("error" in profile) throw new Error(profile.error);
  return profile;
}

const ACTING_AGENT_VERBS = ["spawn", "resume", "retire", "background", "surface", "teleport"];

function triager(): AgentProfile {
  return parsed("triager", {
    description: "Synthetic triager: releases a stalled claim or files a follow-up.",
    model: "fable",
    allowedTools: [
      "Read",
      "Grep",
      "Bash(agent-chat burndown release:*)",
      "Bash(example-tracker task add:*)",
      "Bash(example-tracker task edit:*)",
      "Bash(agent-chat agent logs:*)",
    ],
    disallowedTools: [
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash(agent-chat send:*)",
      "Bash(agent-chat debug send:*)",
      "Bash(agent-chat approve:*)",
      "Bash(agent-chat ask:*)",
      ...ACTING_AGENT_VERBS.map((verb) => `Bash(agent-chat agent ${verb}:*)`),
      "Bash(agent-chat port:*)",
      "Bash(agent-chat teleport:*)",
      "Bash(agent-chat seats:*)",
      "Bash(git push:*)",
    ],
    isolation: "none",
    surface: "headless",
    surfaceLifetime: "close-on-exit",
    pushPolicy: "no-rewrite",
    promptPrelude: "You triage one stalled claim.",
  });
}

describe("a triager-shaped profile (CC-650)", () => {
  it("loads as a headless, read-only job", () => {
    const profile = triager();

    expect(profile).toMatchObject({ model: "fable", surface: "headless", isolation: "none" });
    expect(profile.surfaceLifetime).toBe("close-on-exit");
  });

  it("keeps the write verbs and the log read it allows", () => {
    expect(triager().allowedTools).toEqual(
      expect.arrayContaining([
        "Bash(agent-chat burndown release:*)",
        "Bash(example-tracker task add:*)",
        "Bash(example-tracker task edit:*)",
        "Bash(agent-chat agent logs:*)",
      ]),
    );
  });

  it("denies editing code and pushing", () => {
    expect(triager().disallowedTools).toEqual(expect.arrayContaining(["Edit", "NotebookEdit", "Bash(git push:*)"]));
  });

  // Mutation caught: a derived blanket `agent-chat agent:*` deny, which would hide logs.
  it("denies every agent verb that acts, by name, and not the blanket that would hide logs", () => {
    const denied = triager().disallowedTools ?? [];

    for (const verb of ACTING_AGENT_VERBS) expect(denied).toContain(`Bash(agent-chat agent ${verb}:*)`);
    expect(denied).toContain("Bash(agent-chat port:*)");
    expect(denied).not.toContain("Bash(agent-chat agent:*)");
  });

  it("denies Write and does not allow it", () => {
    expect(triager().disallowedTools).toContain("Write");
    expect(triager().allowedTools).not.toContain("Write");
  });

  // Mutation caught: a derived deny that swallows `agent logs`, which the triager reads its transcript through.
  it("has no deny that matches `agent-chat agent logs`", () => {
    const probe = "agent-chat agent logs";
    const matches = (rule: string): boolean => {
      const m = /^Bash\((.*):\*\)$/.exec(rule);
      return m?.[1] !== undefined && probe.startsWith(m[1]);
    };

    expect((triager().disallowedTools ?? []).filter(matches)).toEqual([]);
  });
});

const BUILDER_DENIES = [
  "Bash",
  "WebSearch",
  "WebFetch",
  "ToolSearch",
  "AskUserQuestion",
  "Bash(agent-chat send:*)",
  "Bash(agent-chat debug send:*)",
  "Bash(agent-chat teleport:*)",
  "Bash(agent-chat seats:*)",
  "Bash(agent-chat burndown:*)",
  "Bash(agent-chat endorse:*)",
  "Bash(agent-chat approve:*)",
  "Bash(agent-chat inbox:*)",
  "Bash(agent-chat ask:*)",
  "Bash(agent-chat agent:*)",
  "mcp__plugin_agent-chat_agent-chat__chat_send",
  "mcp__plugin_agent-chat_agent-chat__agent_spawn",
];

function beatBuilder(): AgentProfile {
  return parsed("beat-builder", {
    description: "Synthetic builder: writes one module inside its scratch cwd.",
    model: "sonnet",
    allowedTools: ["Read(./**)", "Write(./**)", "Edit(./**)"],
    disallowedTools: BUILDER_DENIES,
    isolation: "none",
    surface: "headless",
    surfaceLifetime: "close-on-exit",
    pushPolicy: "no-rewrite",
    promptPrelude: "Write the module named in your brief.",
  });
}

describe("a beat-builder-shaped profile (TP-2608)", () => {
  it("loads as a headless sonnet worker in the cwd it is given, with no warnings", () => {
    const profile = beatBuilder();

    expect(profile).toMatchObject({ model: "sonnet", surface: "headless", isolation: "none" });
    expect(profile.warnings).toBeUndefined();
  });

  // Mutation caught: rewriting a path-scoped grant, which lets the worker roam outside its cwd.
  it("allows Read, Write and Edit inside its cwd and nothing else", () => {
    expect(beatBuilder().allowedTools).toEqual(["Read(./**)", "Write(./**)", "Edit(./**)"]);
  });

  it("grants no file tool without a path scope", () => {
    for (const tool of ["Read", "Write", "Edit"]) expect(beatBuilder().allowedTools).not.toContain(tool);
  });

  it("denies the shell, the web, MCP discovery and the human-authority verbs, exactly as listed", () => {
    expect(beatBuilder().disallowedTools).toEqual(BUILDER_DENIES);
  });
});
