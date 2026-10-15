import { describe, expect, it } from "vitest";
import { ghLineSource, MAX_READ_FILES, type GhExec } from "./gh-line-source.js";

const HEAD = "a".repeat(40);

function recordingExec(answer: (args: readonly string[]) => string = () => "one\ntwo\n") {
  const calls: (readonly string[])[] = [];
  const exec: GhExec = (args) => {
    calls.push(args);
    return answer(args);
  };
  return { exec, calls };
}

describe("ghLineSource", () => {
  it("reads a file's raw text at the head through gh api, one entry per line", () => {
    const { exec, calls } = recordingExec();

    const lines = ghLineSource("o/r", HEAD, exec).lines("src/a b.ts");

    expect(lines).toEqual(["one", "two"]);
    expect(calls).toEqual([["api", "-H", "Accept: application/vnd.github.raw", `repos/o/r/contents/src/a%20b.ts?ref=${HEAD}`]]);
  });

  it("reads a path once however often the check asks for it", () => {
    const { exec, calls } = recordingExec();
    const source = ghLineSource("o/r", HEAD, exec);

    source.lines("src/a.ts");
    const again = source.lines("src/a.ts");

    expect(again).toEqual(["one", "two"]);
    expect(calls).toHaveLength(1);
  });

  it("answers undefined for a file gh cannot read, and does not ask again", () => {
    const { exec, calls } = recordingExec(() => {
      throw new Error("gh: Not Found (HTTP 404)");
    });
    const source = ghLineSource("o/r", HEAD, exec);

    expect(source.lines("gone.ts")).toBeUndefined();
    expect(source.lines("gone.ts")).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("stops reading new paths past the cap", () => {
    const { exec, calls } = recordingExec();
    const source = ghLineSource("o/r", HEAD, exec);
    for (let i = 0; i < MAX_READ_FILES; i += 1) source.lines(`f${i}.ts`);

    const past = source.lines("one-more.ts");

    expect(MAX_READ_FILES).toBe(20);
    expect(past).toBeUndefined();
    expect(calls).toHaveLength(MAX_READ_FILES);
    expect(source.lines("f0.ts")).toEqual(["one", "two"]);
  });
});
