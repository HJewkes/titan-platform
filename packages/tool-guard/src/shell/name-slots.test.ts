import { describe, expect, it } from "vitest";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import { nameSlots } from "./name-slots.js";

function slotsOf(src: string): string[] | string {
  const [command, ...args] = tokenize(src).filter((t): t is WordToken => t.type === "word");
  const slots = nameSlots(command?.value ?? "", args);
  return typeof slots === "string" ? slots : slots.map((w) => w.value);
}

describe("nameSlots", () => {
  it.each([
    ["read -r a b", ["a", "b"]],
    ["read -a arr", ["arr"]],
    ["read -ra?FS", ["?FS"]],
    ["printf -vNAME %s x", ["NAME"]],
    ["printf %s x", []],
    ["declare -n R=target X=1", ["R=target", "X=1"]],
    ["unset -f fn", ["fn"]],
    ["wait -n -p pid", ["pid"]],
    ["set -A arr a b", ["arr"]],
    ["zparseopts a=opts", ["opts"]],
    ["for x y in 1 2", ["x", "y"]],
    ["getopts ab opt", ["opt"]],
    ["git push origin x", []],
  ])("reads the name slots of %s", (src, slots) => {
    expect(slotsOf(src)).toEqual(slots);
  });

  it("fails closed on an option letter the table does not know", () => {
    expect(slotsOf("declare -Q x")).toBe("-Q");
  });

  it("keeps a sliced slot's refs indexing into its own value", () => {
    const [, ...args] = tokenize("zparseopts a=$x").filter((t): t is WordToken => t.type === "word");
    const slots = nameSlots("zparseopts", args);

    expect(slots).toEqual([expect.objectContaining({ value: "$x", refs: [{ name: "x", start: 0, end: 2 }] })]);
  });
});
