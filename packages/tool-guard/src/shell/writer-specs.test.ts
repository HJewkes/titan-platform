import { describe, expect, it } from "vitest";
import { HOOKED_WRITERS } from "./hooked-params.js";
import { WRITERS } from "./name-slots.js";
import type { WordToken } from "./lexer.js";
import { tokenize } from "./lexer.js";
import { expandsInStoreOptions, STORE_OPTION_BUILTINS } from "./store-option-zone.js";
import { REMOVERS, WRITER_SPECS } from "./writer-specs.js";
import type { WriterSpec } from "./writer-specs.js";

const inOptions = (src: string) => {
  const [name, ...args] = tokenize(src).filter((t): t is WordToken => t.type === "word");
  if (!name) throw new Error(`no command in ${src}`);
  return expandsInStoreOptions(name.value, args);
};

const ZONE = Object.entries(WRITER_SPECS).filter(([, spec]) => spec.names !== undefined || spec.stores !== undefined);

/** A run-time word in each option slot the spec knows: first, after each letter's value, and after each flag. */
function optionSlots(name: string, spec: WriterSpec): string[] {
  const valued = [...(spec.names ?? ""), ...(spec.values ?? ""), ...(spec.either ?? "")].map((l) => `${name} -${l} v`);
  const flagged = [...(spec.flags ?? ""), ...(spec.stores ?? "")].map((l) => `${name} -${l}`);
  return [name, ...valued, ...flagged].flatMap((lead) => [`${lead} "$o" x`, `${lead} $o x`]);
}

const DASHES = (spec: WriterSpec) => (spec.skipsLeadingDashes ? "-- --" : "--");

describe("the builtins that store into a named parameter", () => {
  it("are the same for the rebinding reader and the hooked-parameter reader, but for those that only remove a name", () => {
    const onlyNameSlots = [...WRITERS].filter((name) => !HOOKED_WRITERS.has(name));
    const onlyHooked = [...HOOKED_WRITERS].filter((name) => !WRITERS.has(name));

    expect(onlyNameSlots).toEqual([...REMOVERS]);
    expect(onlyHooked).toEqual([]);
  });

  it("include every builtin with a name option, stat and compadd among them, in the option zone", () => {
    const named = Object.keys(WRITER_SPECS).filter((name) => WRITER_SPECS[name]?.names !== undefined);

    expect(named.filter((name) => !STORE_OPTION_BUILTINS.has(name))).toEqual([]);
    expect(named).toEqual(expect.arrayContaining(["stat", "compadd"]));
  });

  it.each(ZONE)("refuse a run-time word in each of %s's option slots", (name, spec) => {
    const passed = optionSlots(name, spec).filter((src) => !inOptions(src));

    expect(passed).toEqual([]);
  });

  it.each(ZONE.filter(([, spec]) => spec.skipsLeadingDashes))("refuse %s's run-time word behind the one -- zsh skips", (name) => {
    expect(inOptions(`${name} -- "$o" x`)).toBe(true);
  });

  it.each(ZONE)("pass %s's run-time word once -- ends its options", (name, spec) => {
    expect([inOptions(`${name} ${DASHES(spec)} "$o" x`), inOptions(`${name} ${DASHES(spec)} $o x`)]).toEqual([false, false]);
  });

  it.each(["zpty", "zgetattr", "zlistattr", "zcurses", "ztie", "zsystem", "integer", "float", "stat"])(
    "include %s in both readers",
    (name) => {
      expect([WRITERS.has(name), HOOKED_WRITERS.has(name)]).toEqual([true, true]);
    },
  );
});
