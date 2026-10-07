import { describe, expect, it } from "vitest";
import { seatConfigSchema } from "./seat-config.js";
import seatA from "./fixtures/seat-a.json" with { type: "json" };
import seatB from "./fixtures/seat-b.json" with { type: "json" };
import seatC from "./fixtures/seat-c.json" with { type: "json" };
import seatD from "./fixtures/seat-d.json" with { type: "json" };
import seatE from "./fixtures/seat-e.json" with { type: "json" };
import seatF from "./fixtures/seat-f.json" with { type: "json" };

const fixtures = { "seat-a": seatA, "seat-b": seatB, "seat-c": seatC, "seat-d": seatD, "seat-e": seatE, "seat-f": seatF };

describe("seatConfigSchema", () => {
  it.each(Object.entries(fixtures))("parses the %s seat front matter", (_name, fixture) => {
    expect(seatConfigSchema.safeParse(fixture).success).toBe(true);
  });

  it("keeps an unknown key on the parsed seat", () => {
    const parsed = seatConfigSchema.parse({ ...seatF, new_key: "kept" });
    expect(parsed.new_key).toBe("kept");
  });

  it("keeps an unknown key inside a repo row", () => {
    const parsed = seatConfigSchema.parse({
      ...seatF,
      repos: [{ path: "~/p", extra: 1 }],
    });
    expect(parsed.repos?.[0]?.extra).toBe(1);
  });

  it.each(["name", "prefix", "pool", "config_dir", "concurrency", "spend"] as const)(
    "rejects a seat missing %s",
    (key) => {
      const seat: Record<string, unknown> = structuredClone(seatF);
      delete seat[key];
      expect(seatConfigSchema.safeParse(seat).success).toBe(false);
    },
  );

  it("rejects a non-number concurrency.implementers", () => {
    const seat = { ...seatF, concurrency: { ...seatF.concurrency, implementers: "3" } };
    expect(seatConfigSchema.safeParse(seat).success).toBe(false);
  });

  it("rejects an unknown schema version", () => {
    expect(seatConfigSchema.safeParse({ ...seatF, schema: "autonomy-seat/v2" }).success).toBe(false);
  });
});
