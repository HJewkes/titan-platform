import { describe, expect, it } from "vitest";
import type { WordToken } from "../shell/lexer.js";
import { tokenize } from "../shell/lexer.js";
import { mayBeOption } from "../shell/command-rebinding.js";
import { CURL_LONG, WGET_LONG, resolveLong } from "./long-options.js";
import { readOptions, set, takesNextWord } from "./options.js";

const words = (src: string): WordToken[] => tokenize(src).filter((t): t is WordToken => t.type === "word");
const curl = resolveLong(CURL_LONG, true);

const summary = (src: string, resolve?: (flag: string) => string) => {
  const options = readOptions(words(src), set("--config"), resolve);
  return {
    opts: options.opts.map((o) => [o.flag, o.value?.value ?? null]),
    positionals: options.positionals.map((w) => w.value),
  };
};

describe("readOptions with a long-option resolver", () => {
  it("gives an abbreviated option the value the full option takes", () => {
    expect(summary("--conf f u", curl)).toEqual({ opts: [["--config", "f"]], positionals: ["u"] });
  });

  it("resolves the flag of an attached value", () => {
    expect(summary("--CONFIG=f u", curl)).toEqual({ opts: [["--config", "f"]], positionals: ["u"] });
  });

  it("leaves a hidden wget flag bare so the body option after it still reads", () => {
    const options = readOptions(words("--hsts --post-data=x u"), WGET_LONG.values, resolveLong(WGET_LONG, false));
    expect(options.opts.map((o) => [o.flag, o.value?.value ?? null])).toEqual([["--hsts", null], ["--post-data", "x"]]);
    expect(options.positionals.map((w) => w.value)).toEqual(["u"]);
  });

  it("reads as before without a resolver", () => {
    expect(summary("--conf f u")).toEqual({ opts: [["--conf", null]], positionals: ["f", "u"] });
  });
});

describe("a run-time word that may expand to an option", () => {
  it.each([
    ['"$OPT"', true],
    ["$X", true],
    ['"$URL"', true],
    ['"-$X"', true],
    ['"https://$HOST/x"', false],
    ["PATH=$HOME", false],
  ])("%s may be an option: %s", (src, expected) => {
    const [word] = words(src);
    expect(word && mayBeOption(word)).toBe(expected);
  });
});

describe("takesNextWord", () => {
  const values = set("--config", "--header", "-H", "-d");

  it.each(["-H", "--header", "-sH", "-d"])("%s takes the next word as its value", (word) => {
    expect(takesNextWord(word, values)).toBe(true);
  });

  it.each(["-Hx", "--header=x", "-s", "--", "-", "url", "-sHx", "-Hs", "--next", "-:"])("%s leaves the next word alone", (word) => {
    expect(takesNextWord(word, values)).toBe(false);
  });

  it("resolves an abbreviated long option before looking up its value", () => {
    expect(takesNextWord("--conf", values, curl)).toBe(true);
    expect(takesNextWord("--conf", values)).toBe(false);
  });

  it.each(["-H", "--header", "-sH", "-d", "-Hx", "--header=x", "-s", "--", "-", "url", "-sHx", "-Hs", "--next", "--conf"])(
    "agrees with readOptions on whether %s consumes the next word",
    (word) => {
      const read = readOptions(words(`${word} next`), values, curl);
      const consumed = !read.positionals.some((w) => w.value === "next");
      expect(takesNextWord(word, values, curl)).toBe(consumed);
    },
  );
});
