import { describe, expect, it } from "vitest";
import { tokenize } from "../shell/lexer.js";
import type { WordToken } from "../shell/lexer.js";
import { readOptions, set } from "./options.js";
import { XH_VALUES } from "./xh-options.js";

const words = (src: string) => tokenize(src).filter((t): t is WordToken => t.type === "word");
const positionals = (src: string, values = XH_VALUES) => readOptions(words(src), values).positionals.map((w) => w.value);

describe("XH_VALUES reads an xh command line as xh does", () => {
  it.each([
    ["auth and timeout values", "-a u:p --timeout 5 https://x", ["https://x"]],
    ["a bearer token", "--bearer t PUT https://x", ["PUT", "https://x"]],
    ["a raw body", "--raw x https://x", ["https://x"]],
    ["an auth type in a cluster", "-vA bearer https://x", ["https://x"]],
    ["a history print format", "-P hb https://x", ["https://x"]],
    ["max redirects", "--max-redirects 3 https://x", ["https://x"]],
    ["an output file", "-o f https://x", ["https://x"]],
    ["a session file", "--session s POST https://x a=1", ["POST", "https://x", "a=1"]],
  ])("consumes %s", (_name, src, expected) => {
    expect(positionals(src)).toEqual(expected);
  });

  it.each([
    ["follow", "-F https://x"],
    ["form", "-f https://x"],
    ["download", "-d https://x"],
    ["body only", "-b https://x"],
    ["continue", "-c https://x"],
    ["compress", "-x https://x"],
  ])("leaves the URL after the %s switch", (_name, src) => {
    expect(positionals(src)).toEqual(["https://x"]);
  });

  it("would eat the URL if -F took a value as it does in curl", () => {
    expect(positionals("-F https://x", set(...XH_VALUES, "-F"))).toEqual([]);
  });
});
