import { describe, expect, it } from "vitest";
import { isReviewerSpawn, isReviewerTreeName } from "./index.js";

describe("isReviewerTreeName", () => {
  it.each(["rv-o-r-4-1", "impl-task-1-reviewer", "RV-x", "seat-1-adv-review"])(
    "classifies %s as a reviewer tree",
    (name) => {
      expect(isReviewerTreeName(name)).toBe(true);
    },
  );

  it.each(["previewer-x", "preview-x", "reviewed-x", "bd-cc-1-a-r0", "driver", "a-rv"])(
    "classifies %s as an implementer tree",
    (name) => {
      expect(isReviewerTreeName(name)).toBe(false);
    },
  );
});

describe("isReviewerSpawn", () => {
  it("counts a reviewer token in the profile, or an rv- agent name", () => {
    expect(isReviewerSpawn("rv-readonly", "impl-1")).toBe(true);
    expect(isReviewerSpawn("reviewer-lite", "impl-1")).toBe(true);
    expect(isReviewerSpawn("opus", "rv-task-1")).toBe(true);
  });

  it("leaves out a bare review token, which only tree counting reads", () => {
    expect(isReviewerSpawn("opus", "seat-1-adv-review")).toBe(false);
    expect(isReviewerSpawn("previewer", "impl-rv")).toBe(false);
  });
});
