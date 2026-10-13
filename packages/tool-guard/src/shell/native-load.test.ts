import { describe, expect, it } from "vitest";
import { tokenize } from "./lexer.js";
import { loadsNativeCode } from "./native-load.js";
import type { WordToken } from "./tokens.js";
import { unwrap } from "./unwrap.js";

const loads = (line: string) => {
  const words = tokenize(line).filter((t): t is WordToken => t.type === "word");
  const cmd = unwrap(words);
  return cmd !== null && loadsNativeCode(cmd);
};

describe("bash enable that can load a shared object", () => {
  it.each([
    ["a library file and builtin name", "enable -f ./x.so name"],
    ["a bare library file", "enable -f x.so x"],
    ["-f inside a cluster", "enable -fn x.so x"],
    ["-f with its file attached", "enable -f./x.so x"],
    ["a name searched on BASH_LOADABLES_PATH, which holds . by default", "enable name"],
    ["a name after --", "enable -- name"],
    ["a name after -n, an accepted over-read since it only disables", "enable -n name"],
    ["a quoted dynamic operand", "enable \"$X\""],
    ["a dynamic option word", "enable $O x"],
    ["the builtin wrapper", "builtin enable -f ./x.so x"],
    ["the command wrapper", "command enable x"],
  ])("is a load: %s", (_how, line) => {
    expect(loads(line)).toBe(true);
  });
});

describe("lines that only list builtins or mention enable", () => {
  it.each([
    ["bare enable", "enable"],
    ["-a", "enable -a"],
    ["-p", "enable -p"],
    ["a -ps cluster", "enable -ps"],
    ["-n with no operand", "enable -n"],
    ["enable as an echo argument", "echo enable -f x"],
    ["enable -f inside a search pattern", "rg 'enable -f' src"],
    ["a stock zsh module", "zmodload zsh/datetime"],
  ])("is no load: %s", (_how, line) => {
    expect(loads(line)).toBe(false);
  });
});
