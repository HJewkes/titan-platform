import { describe, expect, it } from "vitest";
import { audienceOf, forAudience } from "./audience.js";
import { item } from "./test-fixtures.js";

const owner = item({ id: "a", audience: "owner" });
const operator = item({ id: "b", audience: "operator" });
const unset = item({ id: "c" });

describe("forAudience", () => {
  it("counts an item with no audience as the owner's, in input order", () => {
    expect(forAudience([owner, operator, unset], "owner")).toEqual([owner, unset]);
  });

  it("gives the operator only items filed for the operator", () => {
    expect(forAudience([owner, operator, unset], "operator")).toEqual([operator]);
  });
});

describe("audienceOf", () => {
  it("reads an absent audience as owner", () => {
    expect(audienceOf(unset)).toBe("owner");
  });
});
