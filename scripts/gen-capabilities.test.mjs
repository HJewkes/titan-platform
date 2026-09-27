import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keyExports, parseExports, parseUseWhen } from "./gen-capabilities.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

describe("reading a package's exports from its index", () => {
  it("records each re-exported name with its module and whether it is a type", () => {
    const source = [
      'export type { RunConfig } from "./types.js";',
      'export { runAgent, type AgentInit, prepareEnv as scrubEnv } from "./run.js";',
    ].join("\n");
    expect(parseExports(source)).toEqual([
      { name: "RunConfig", type: true, from: "./types.js" },
      { name: "runAgent", type: false, from: "./run.js" },
      { name: "AgentInit", type: true, from: "./run.js" },
      { name: "scrubEnv", type: false, from: "./run.js" },
    ]);
  });

  it("follows export-star through the resolver and keeps the star's module as the concern", () => {
    const resolveStar = () => [{ name: "resolveNode", type: false, from: "./nodes.js" }];
    expect(parseExports('export * from "./query/index.js";', resolveStar)).toEqual([
      { name: "resolveNode", type: false, from: "./query/index.js" },
    ]);
  });

  it("counts declarations written in the index itself", () => {
    const source = "export interface Identity { id: string }\nexport function conversationRef() {}\n";
    expect(parseExports(source)).toEqual([
      { name: "Identity", type: true, from: "./index.js" },
      { name: "conversationRef", type: false, from: "./index.js" },
    ]);
  });
});

describe("choosing the key exports", () => {
  const entry = (name, from, type = false) => ({ name, from, type });

  it("puts callables before constants and types, then regroups the picks by module", () => {
    const entries = [entry("Config", "./types.js", true), entry("MAX_RETRIES", "./env.js"), entry("prepareEnv", "./env.js"), entry("runAgent", "./run.js")];
    expect(keyExports(entries, 3)).toEqual({
      groups: [
        { concern: "env", names: ["MAX_RETRIES", "prepareEnv"] },
        { concern: "run", names: ["runAgent"] },
      ],
      more: 1,
    });
  });

  it("names a directory index by its directory", () => {
    expect(keyExports([entry("resolveNode", "./query/index.js")]).groups).toEqual([{ concern: "query", names: ["resolveNode"] }]);
  });
});

describe("reading a CAPABILITY.md", () => {
  it("drops the heading and the authoring comment and joins the prose onto one line", () => {
    const markdown = "# agent: use this when\n\n<!-- guidance for authors -->\n\nYou run one agent.\nIt needs a token.\n";
    expect(parseUseWhen(markdown)).toBe("You run one agent. It needs a token.");
  });

  it("ships in the package template so every stamped package starts with one", () => {
    const template = readFileSync(join(REPO, "templates", "package", "CAPABILITY.md"), "utf8");
    expect(parseUseWhen(template)).toContain("__NAME__");
  });
});
