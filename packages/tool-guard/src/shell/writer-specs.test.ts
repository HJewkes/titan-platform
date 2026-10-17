import { describe, expect, it } from "vitest";
import { HOOKED_WRITERS } from "./hooked-params.js";
import { WRITERS } from "./name-slots.js";
import { STORE_OPTION_BUILTINS } from "./store-option-zone.js";
import { REMOVERS, WRITER_SPECS } from "./writer-specs.js";

/** Builtins with a store option that the option zone leaves out, each for a reason it states. */
const OPTION_ZONE_EXEMPT: Record<string, string> = {
  stat: "bash's stat is the external GNU or BSD tool, and zsh's stat builtin needs zmodload zsh/stat; zstat is read",
  compadd: "zsh refuses compadd outside a completion widget",
};

describe("the builtins that store into a named parameter", () => {
  it("are the same for the rebinding reader and the hooked-parameter reader, but for those that only remove a name", () => {
    const onlyNameSlots = [...WRITERS].filter((name) => !HOOKED_WRITERS.has(name));
    const onlyHooked = [...HOOKED_WRITERS].filter((name) => !WRITERS.has(name));

    expect(onlyNameSlots).toEqual([...REMOVERS]);
    expect(onlyHooked).toEqual([]);
  });

  it("each have an option-zone entry when an option names the parameter", () => {
    const withStoreOption = Object.keys(WRITER_SPECS).filter((name) => (WRITER_SPECS[name]?.names ?? "") !== "");

    const missing = withStoreOption.filter((name) => !STORE_OPTION_BUILTINS.has(name) && !(name in OPTION_ZONE_EXEMPT));

    expect(missing).toEqual([]);
  });

  it.each(["zpty", "zgetattr", "zlistattr", "zcurses", "ztie", "zsystem", "integer", "float", "stat"])(
    "include %s in both readers",
    (name) => {
      expect([WRITERS.has(name), HOOKED_WRITERS.has(name)]).toEqual([true, true]);
    },
  );
});
