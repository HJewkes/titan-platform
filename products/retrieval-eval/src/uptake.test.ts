import { describe, expect, it } from "vitest";
import { classify } from "./uptake.js";

describe("classify", () => {
  it("counts Grep and Glob as filesystem search", () => {
    expect(classify("Grep", {})).toBe("fs-search");
    expect(classify("Glob", {})).toBe("fs-search");
  });

  it("finds a search hiding inside a Bash command", () => {
    expect(classify("Bash", { command: "rg -n pattern src" })).toBe("bash-search");
    expect(classify("Bash", { command: "find . -name '*.ts'" })).toBe("bash-search");
  });

  it("counts workspace recall through the CLI as recall, not as a bash search", () => {
    expect(classify("Bash", { command: "active-work search retrieval --limit 5" })).toBe("recall-cli");
    expect(classify("Bash", { command: "titan-miner search foo | grep bar" })).toBe("recall-cli");
  });

  it("leaves an ordinary Bash call out of both search buckets", () => {
    expect(classify("Bash", { command: "pnpm test" })).toBe("bash-other");
  });

  it("separates recall MCP tools from the rest by name", () => {
    expect(classify("mcp__active-work__active__search", {})).toBe("recall-mcp");
    expect(classify("mcp__active-work__active__task__add", {})).toBe("mcp-other");
  });

  it("buckets reads and web fetches away from search", () => {
    expect(classify("Read", { file_path: "/a" })).toBe("read");
    expect(classify("WebSearch", {})).toBe("web");
    expect(classify("AskUserQuestion", {})).toBe("other");
  });

  it("does not read a command argument as a tool name", () => {
    expect(classify("Bash", { command: "echo mcp__active__search" })).toBe("bash-other");
  });
});
