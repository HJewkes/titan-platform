import { describe, expect, it } from "vitest";
import { isRepo } from "./index.js";

describe("isRepo", () => {
  it.each(["owner/name", "a/b", "my-org/my.repo_1", "o/.github", `${"a".repeat(39)}/name`])("accepts %s", (value) => {
    expect(isRepo(value)).toBe(true);
  });

  it.each([
    ["a .git suffix", "owner/name.git"],
    ["an upper-case .GIT suffix", "owner/name.GIT"],
    ["an empty owner", "/name"],
    ["an empty name", "owner/"],
    ["an empty string", ""],
    ["no slash", "owner"],
    ["extra slashes", "owner/name/extra"],
    ["whitespace", "owner/na me"],
    ["leading whitespace", " owner/name"],
    ["a #N suffix", "owner/name#12"],
    ["a dot name", "owner/."],
    ["a dot-dot name", "owner/.."],
    ["a leading-hyphen owner", "-owner/name"],
    ["a trailing-hyphen owner", "owner-/name"],
    ["consecutive hyphens in the owner", "my--org/name"],
    ["an owner over 39 characters", `${"a".repeat(40)}/name`],
    ["an underscore in the owner", "my_org/name"],
  ])("refuses %s", (_label, value) => {
    expect(isRepo(value)).toBe(false);
  });
});
