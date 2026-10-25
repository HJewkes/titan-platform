import { describe, expect, it } from "vitest";
import { assertDurationAgreement } from "./duration-check.js";

describe("page and mix duration agreement", () => {
  it("refuses a page half a second longer than the mix, naming both lengths", () => {
    const check = () => assertDurationAgreement(10.5, 10);

    expect(check).toThrow("page lasts 10.5 s but the audio mix 10 s");
  });

  it("refuses a page shorter than the mix", () => {
    const check = () => assertDurationAgreement(9.9, 10);

    expect(check).toThrow(/page lasts 9.9 s/);
  });

  it("accepts lengths that differ by less than the float tolerance", () => {
    const check = () => assertDurationAgreement(10, 10 + 5e-7);

    expect(check).not.toThrow();
  });

  it("refuses lengths that differ by just over the tolerance", () => {
    const check = () => assertDurationAgreement(10, 10 + 2e-6);

    expect(check).toThrow();
  });
});
