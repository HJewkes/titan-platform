import { describe, expect, it } from "vitest";
import { HARD_STOP_CLASSES, charterPolicySchema, parseCharterPolicy } from "./charter-policy.js";
import charter from "./fixtures/charter.json" with { type: "json" };

function withoutKey(path: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = structuredClone(charter);
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  delete node[path.at(-1) as string];
  return copy;
}

describe("parseCharterPolicy", () => {
  it("parses the charter front matter with every default, fund and pool", () => {
    const result = parseCharterPolicy(charter);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.seats).toHaveLength(5);
    expect(result.policy.hard_stops).toEqual([...HARD_STOP_CLASSES]);
    expect(result.policy.defaults.gate_free_bonus).toBe(1.15);
    expect(result.policy.defaults.retire_k.reviewer).toBe(300);
    expect(result.policy.defaults.teleport_k).toBe(250);
    expect(result.policy.funds.default).toEqual(["pool-a", "pool-b", "pool-c"]);
    expect(result.policy.pools["pool-d"]?.reserve_seven_day).toBe(14);
  });

  it.each([
    ["seats"],
    ["hub"],
    ["hard_stops"],
    ["defaults"],
    ["funds"],
    ["pools"],
    ["defaults", "kind_weights"],
    ["defaults", "share_caps"],
    ["defaults", "score_terms"],
    ["defaults", "severity"],
    ["defaults", "readiness"],
    ["defaults", "size"],
    ["defaults", "retire_k"],
    ["defaults", "teleport_k"],
    ["funds", "default"],
    ["pools", "pool-a", "ceiling_five_hour"],
    ["pools", "pool-a", "config_dir"],
  ])("names %s when it is missing", (...path) => {
    const result = parseCharterPolicy(withoutKey(path));

    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: "missing", path: path.join(".") }],
    });
  });

  it("refuses a hard stop outside the known classes", () => {
    const result = parseCharterPolicy({ ...charter, hard_stops: [...charter.hard_stops, "reboot-host"] });

    expect(result).toMatchObject({ ok: false, errors: [{ code: "invalid", path: "hard_stops.12" }] });
  });

  it("refuses a wrong type", () => {
    const pools = { ...charter.pools, "pool-a": { ...charter.pools["pool-a"], ceiling_five_hour: "100" } };

    const result = parseCharterPolicy({ ...charter, pools });

    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: "invalid", path: "pools.pool-a.ceiling_five_hour" }],
    });
  });

  it("refuses an unknown schema version", () => {
    const result = parseCharterPolicy({ ...charter, schema: "autonomy-charter/v2" });

    expect(result).toMatchObject({ ok: false, errors: [{ path: "schema" }] });
  });

  it("refuses a value that is not an object", () => {
    expect(parseCharterPolicy("schema: autonomy-charter/v1")).toMatchObject({ ok: false });
  });

  it.each([
    ["with", { sonnet_band_points: 10, reserve_seven_day: 14 }],
    ["without", {}],
  ])("parses a pool %s the optional band and reserve keys", (_label, optional) => {
    const pool = { config_dir: "/home/user/cfg/pool-e", human_uses: false, ceiling_five_hour: 90, per_day_points: 20 };

    const result = parseCharterPolicy({ ...charter, pools: { "pool-e": { ...pool, ...optional } } });

    expect(result.ok).toBe(true);
  });

  it("keeps an unknown top-level key", () => {
    const parsed = charterPolicySchema.parse({ ...charter, new_key: "kept" });

    expect(parsed.new_key).toBe("kept");
  });
});
