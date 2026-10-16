import { describe, expect, it } from "vitest";
import { zshRunsValue } from "./zsh-value-flags.js";

const RUNS_VALUE = [
  "$~x",
  "$=~x",
  "$~~x",
  "$^~x",
  "$\\\n~x",
  "$=\\\n~x",
  "${~x}",
  "${~~x}",
  "${=~x}",
  "${^~x}",
  "${(e)x}",
  "${(Le)x}",
  "${(j:,:e)x}",
  "${(s.).e)x}",
  "${(l:10::x::y:e)x}",
  "${(j[)]e)x}",
  "${(L)~x}",
  "${(L)(e)x}",
  "${\\\n(e)x}",
  "${(e",
  "${(s:x",
  "${(L",
  "${",
];

const LEAVES_VALUE = [
  "$x",
  "$",
  "${x}",
  "${#x}",
  "${+x}",
  "${=x}",
  "${^x}",
  "${(L)x}",
  "${(j:,:)x}",
  "${(s:e:)x}",
  "${(s[e])x}",
  "${(l:10::e:)x}",
  "${(r:3::e::e:)x}",
  "${x:-~}",
  "${x/#\\~/h}",
  "${x:-$(e)}",
  "$(echo ~)",
  "$'~'",
  "$((~1))",
];

describe("zshRunsValue", () => {
  it.each(RUNS_VALUE)("refuses %j, whose value zsh globs or substitutes", (src) => {
    expect(zshRunsValue(src, 0)).toBe(true);
  });

  it.each(LEAVES_VALUE)("passes %j, which leaves the value as text", (src) => {
    expect(zshRunsValue(src, 0)).toBe(false);
  });

  it("reads the dollar at the given index, not the first one", () => {
    const src = "echo $x ${~y}";

    expect([zshRunsValue(src, 5), zshRunsValue(src, 8)]).toEqual([false, true]);
  });
});
