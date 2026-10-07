import { afterEach, describe, expect, it } from "vitest";
import { utc } from "./define.js";

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("utc", () => {
  it.each(["UTC", "America/New_York"])("reads a zone-less timestamp as UTC under TZ=%s", (zone) => {
    process.env.TZ = zone;

    expect(utc("2026-10-01T12:00")).toBe("2026-10-01T12:00:00.000Z");
  });

  it("honours an explicit offset", () => {
    expect(utc("2026-10-01T12:00:00-04:00")).toBe("2026-10-01T16:00:00.000Z");
  });

  it("passes undefined through", () => {
    expect(utc(undefined)).toBeUndefined();
  });
});
