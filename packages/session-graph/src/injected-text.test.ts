import { describe, expect, it } from "vitest";
import { isInjectedCause, isUntypedPrompt, stripInjected } from "./injected-text.js";

const HUMAN = "please rename the widget module";

describe("stripInjected cuts injected blocks and keeps the human's words", () => {
  it.each([
    ["a system reminder", "<system-reminder>\nzebra context\n</system-reminder>"],
    ["an agent-chat peer message", '<channel source="agent-chat" from="peer" msg_id="m1">\nzebra from a peer\n</channel>'],
    ["a background task notification", "<task-notification>\n<task-id>b1</task-id>\n<summary>zebra finished</summary>\n</task-notification>"],
    ["prompt-submit hook output", "<user-prompt-submit-hook>zebra hook</user-prompt-submit-hook>"],
    ["a local-command caveat", "<local-command-caveat>Caveat: zebra caveat</local-command-caveat>"],
    ["local-command output", "<local-command-stdout>zebra out</local-command-stdout><local-command-stderr>zebra err</local-command-stderr>"],
    ["shell output echoes", "<bash-stdout>zebra listing</bash-stdout><bash-stderr>zebra warning</bash-stderr>"],
    ["an interruption note", "[Request interrupted by user for tool use]"],
  ])("removes %s around human text", (_label, block) => {
    const result = stripInjected(`${block}\n${HUMAN}\n${block}`);

    expect(result).toBe(HUMAN);
  });

  it("keeps slash-command arguments and drops the command framing", () => {
    const text = "<command-message>zebra is running</command-message>\n<command-name>/zebra</command-name>\n<command-args>rename the widget</command-args>";

    expect(stripInjected(text)).toBe("rename the widget");
  });

  it("keeps a typed shell command and drops its output", () => {
    const text = "<bash-input>ls widgets</bash-input>\n<bash-stdout>zebra.ts</bash-stdout>";

    expect(stripInjected(text)).toBe("ls widgets");
  });
});

describe("stripInjected keeps a human's words that only mention injected markers", () => {
  it("keeps prose between two tag mentions inside a sentence", () => {
    const text = "why does <system-reminder> appear? also the closing </system-reminder> tag";

    expect(stripInjected(text)).toBe(text);
  });

  it("keeps a block-looking span whose close is followed by more words on its line", () => {
    const text = "<system-reminder> is odd, see the </system-reminder> tag here";

    expect(stripInjected(text)).toBe(text);
  });

  it("keeps a typed turn that carries a File Ownership heading", () => {
    const text = "Draft the brief like this:\n--- File Ownership ---\nOwned (can modify):\n  src/zebra.ts";

    expect(stripInjected(text)).toBe(text);
  });

  it("cuts a nested same-name block whole, tail included", () => {
    const text = "A\n<system-reminder>x<system-reminder>y</system-reminder> LEAK </system-reminder>\nB";

    expect(stripInjected(text)).toBe("A\n\nB");
  });
});

describe("stripInjected empties a turn nobody typed", () => {
  it.each([
    ["an agent-chat orientation brief", '# Orientation: active-work initiative "demo"\n\nInjected automatically by `agent_spawn`. Your coordinator did not write this section.\n\nBuild the zebra.'],
    ["a predecessor handover", "# Predecessor: old-agent\n\nYou are taking over from old-agent. Build the zebra."],
    ["an isolated-worktree spawn brief", "Build the zebra.\n\nYou are on branch z in an isolated worktree at /tmp/z. Commit your work there; nothing outside it is yours to change."],
    ["a shared-worktree spawn brief", "Build the zebra.\n\nYou are in a worktree assigned to this task at /tmp/z, on branch z. You may be sharing it with other agents, so stay inside the paths you were given."],
    ["a compaction summary", "This session is being continued from a previous conversation that ran out of context. Zebra summary."],
    ["an image note", "[Image: source: /tmp/zebra.png]"],
    ["a loop wakeup", "[3 prior /loop wakeups] zebra"],
    ["a local-command-only turn", "<local-command-stdout>zebra</local-command-stdout>"],
    ["a reminder-only turn", "<system-reminder>zebra</system-reminder>"],
  ])("returns nothing for %s", (_label, text) => {
    expect(stripInjected(text)).toBe("");
  });
});

describe("isInjectedCause", () => {
  it("treats only typed prompts and tool results as possibly human", () => {
    expect(isInjectedCause("human_typed")).toBe(false);
    expect(isInjectedCause("tool_result")).toBe(false);
    expect(isInjectedCause("hook_or_reminder")).toBe(true);
    expect(isInjectedCause("channel_message")).toBe(true);
  });
});

describe("isUntypedPrompt", () => {
  it("treats a headless sdk prompt as untyped unless the caller keeps sdk prompts", () => {
    const sdk = { cause: "human_typed", promptSource: "sdk" } as const;

    expect(isUntypedPrompt(sdk)).toBe(true);
    expect(isUntypedPrompt(sdk, true)).toBe(false);
    expect(isUntypedPrompt({ cause: "human_typed", promptSource: "typed" })).toBe(false);
    expect(isUntypedPrompt({ cause: "human_typed", promptSource: null })).toBe(false);
  });
});
