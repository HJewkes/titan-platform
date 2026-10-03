import { describe, expect, it } from "vitest";
import { normalizeKey } from "./normalize.js";

describe("normalizeKey", () => {
  it.each([
    ["Merge_Gate", "merge_gate"],
    [" release-publish ", "release_publish"],
    ["touch  prod!", "touch_prod"],
    ["hard_stop:config edits", "hard_stop_config_edits"],
    ["--", ""],
  ])("folds %j to %j", (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
  });
});
