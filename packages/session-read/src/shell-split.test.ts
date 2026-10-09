import { describe, expect, it } from "vitest";
import { simpleCommandHead } from "./command-heads.js";
import { splitCommands, splitPipelines, type ShellWord } from "./shell-split.js";

const texts = (pipelines: ShellWord[][][]) => pipelines.map((p) => p.map((words) => words.map((w) => w.text).join(" ")));

describe("splitPipelines", () => {
  it("keeps the stages joined by a pipe together and splits on every other separator", () => {
    expect(texts(splitPipelines("cd /tmp && agent-chat agent ls 2>&1 | grep -E x | head -5; gh pr view 1 || true"))).toEqual([
      ["cd /tmp"],
      ["agent-chat agent ls 2>&1", "grep -E x", "head -5"],
      ["gh pr view 1"],
      ["true"],
    ]);
  });

  it("reads a pipe inside quotes, a substitution or a heredoc body as data", () => {
    expect(texts(splitPipelines("gh api x --jq '.a | .b' | jq -r \"$(echo a | wc -l)\"\ncat <<'EOF'\na | b\nEOF\n"))).toEqual([
      ["gh api x --jq .a | .b", "jq -r $(echo a | wc -l)"],
      ["cat"],
    ]);
  });

  it("flattens to the same simple commands splitCommands returns", () => {
    const raw = "a | b && c; d | e | f &\ng";

    expect(splitPipelines(raw).flat()).toEqual(splitCommands(raw));
  });
});

describe("simpleCommandHead", () => {
  it("names the program and its subcommands without redirect targets", () => {
    const [stage] = splitCommands("timeout 60 active-work task list demo > out.txt 2>&1");

    expect(simpleCommandHead(stage!)).toBe("active-work task list");
  });

  it("returns null for cd and for a command with no program", () => {
    expect(simpleCommandHead(splitCommands("cd /tmp")[0]!)).toBeNull();
    expect(simpleCommandHead(splitCommands("A=1")[0]!)).toBeNull();
  });
});
