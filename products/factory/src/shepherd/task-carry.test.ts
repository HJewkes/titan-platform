import { describe, expect, it } from "vitest";
import { carriesUnlanded } from "./task-close.js";

describe("carriesUnlanded", () => {
  it("carries every slice a body names, as #3257 named slices a and b", () => {
    expect(carriesUnlanded(["a", "b"], "Slices a and b ship together.", [])).toBe(true);
  });

  it("carries the only slice left when no other PR is open, though the body names none", () => {
    expect(carriesUnlanded(["a"], "Bridge task.", [])).toBe(true);
  });

  it("does not carry when the body names only some of the unlanded slices", () => {
    expect(carriesUnlanded(["a", "b", "c"], "Slices a and b ship together.", [])).toBe(false);
  });

  it("does not carry the only slice left while another registered PR is open", () => {
    expect(carriesUnlanded(["a"], "", ["octo/demo#2"])).toBe(false);
  });

  it("does not carry on a Last slice: no line, and carries on Last slice: yes", () => {
    expect(carriesUnlanded(["a"], "Last slice: no", [])).toBe(false);
    expect(carriesUnlanded(["a", "b"], "Last slice: yes", ["octo/demo#2"])).toBe(true);
  });
});
