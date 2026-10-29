import { describe, expect, it } from "vitest";
import { dataFence, lastFencedJson } from "./fence.js";

describe("lastFencedJson", () => {
  it("reads the report block that ends an agent's final message", () => {
    const text = 'Done.\n\n```json\n{"head": "abc", "targetsCovered": ["c1"]}\n```\n';

    expect(lastFencedJson(text)).toEqual({ head: "abc", targetsCovered: ["c1"] });
  });

  it("takes the last block when an earlier one quotes an example", () => {
    const text = 'Example:\n```json\n{"head": "old"}\n```\nReport:\n```json\n{"head": "new"}\n```';

    expect(lastFencedJson(text)).toEqual({ head: "new" });
  });

  it("finds no report in text with no json fence, or only a plain code fence", () => {
    expect(lastFencedJson("no report here")).toBeUndefined();
    expect(lastFencedJson('```\n{"head": "abc"}\n```')).toBeUndefined();
  });

  it("closes a longer fence only on the same run of backticks, so a nested ``` stays in the body", () => {
    const text = '````json\n{"note": "```"}\n````';

    expect(lastFencedJson(text)).toEqual({ note: "```" });
  });

  it("throws on a block that is not JSON, rather than reading it as no report", () => {
    expect(() => lastFencedJson("```json\n{head: abc}\n```")).toThrow(SyntaxError);
  });

  it("ignores an unclosed block", () => {
    expect(lastFencedJson('```json\n{"head": "a"}\n```\n```json\n{"head": ')).toEqual({ head: "a" });
  });

  it("reads back what dataFence wrote when it is labelled json", () => {
    expect(lastFencedJson(dataFence("json", '{"a": 1}'))).toEqual({ a: 1 });
  });
});
