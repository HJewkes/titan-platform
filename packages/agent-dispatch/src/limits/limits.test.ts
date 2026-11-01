import { describe, expect, it } from "vitest";
import {
  LIMIT_DEFAULTS,
  LimitsConfigError,
  checkLimits,
  limitsSchema,
  parseLimits,
  resolveCapacity,
  resolveLimits,
  resolveShepherd,
  type ResolveInput,
  type ResolvedLimits,
} from "./index.js";
import today from "./fixtures/limits-today.json" with { type: "json" };

const BEFORE_EXPIRY = new Date("2026-10-09T12:00:00Z");
const BETWEEN_EXPIRIES = new Date("2026-10-10T20:00:00Z");
const AFTER_EXPIRY = new Date("2026-10-11T06:00:00Z");

function open(raw: unknown, input: ResolveInput): ResolvedLimits {
  const result = resolveLimits(parseLimits(raw), input);
  if (!result.open) throw new Error(`expected ${input.pool} open: ${result.reason}`);
  return result.limits;
}

function headline(limits: ResolvedLimits) {
  return [
    limits.ceiling_five_hour,
    limits.reserve_seven_day,
    limits.per_day_points,
    limits.sonnet_band_points,
  ];
}

function minimal(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    pools: { p: { config_dir: "/x", ceiling_five_hour: 90, reserve_seven_day: 10 } },
    ...extra,
  };
}

describe("the limits schema", () => {
  it("accepts today's charter pools as a limits block", () => {
    expect(limitsSchema.safeParse(today).success).toBe(true);
  });

  it("refuses a ceiling written as a string", () => {
    const bad = minimal({
      pools: { p: { config_dir: "/x", ceiling_five_hour: "95", reserve_seven_day: 0 } },
    });
    expect(limitsSchema.safeParse(bad).success).toBe(false);
  });

  it("refuses a block with an unknown version with a named error", () => {
    expect(() => parseLimits({ ...minimal(), version: 2 })).toThrow(LimitsConfigError);
  });

  it("refuses a block that is not an object with a named error", () => {
    expect(() => parseLimits("ceiling 95")).toThrow(LimitsConfigError);
  });
});

describe("today's values", () => {
  it("resolve to the numbers the charter yields while the reserve-0 grant runs", () => {
    const at = (pool: string) => headline(open(today, { pool, now: BEFORE_EXPIRY }));

    expect(at("owner")).toEqual([100, 0, 30, 0]);
    expect(at("agents")).toEqual([95, 0, 30, 0]);
    expect(at("spare")).toEqual([100, 0, 45, 0]);
    expect(at("server")).toEqual([95, 14, 45, 0]);
  });

  it("carry the named margins and the owner-present guard from defaults", () => {
    const agents = open(today, { pool: "agents", now: BEFORE_EXPIRY });

    expect(agents.dispatch_seven_day_points).toBe(2);
    expect(agents.dispatch_five_hour_points).toBe(10);
    expect(agents.pick_margin_five_hour).toBe(0);
    expect(agents.present_ceiling_five_hour).toBe(70);
    expect(agents.present_within_minutes).toBe(15);
    expect(agents.config_dir).toBe("/srv/claude/profiles/agents");
  });

  it("route the reviewer profile's band fallback through data", () => {
    const reviewer = open(today, { pool: "agents", profile: "bd-reviewer", now: BEFORE_EXPIRY });
    expect(reviewer.band_fallback).toBe("reviewer");
  });

  it("fund the default initiative from every pool", () => {
    expect(parseLimits(today).limits.funds.default).toEqual(["owner", "agents", "spare", "server"]);
  });
});

describe("overrides with an until", () => {
  it("apply while active and report which decision applied", () => {
    const agents = open(today, { pool: "agents", now: BEFORE_EXPIRY });

    expect(agents.reserve_seven_day).toBe(0);
    expect(agents.sources.reserve_seven_day).toBe("override");
    expect(agents.applied).toEqual(["override:reserve-0-grant"]);
  });

  it("drop out at until, so the standing reserve returns with no edit", () => {
    const owner = open(today, { pool: "owner", now: BETWEEN_EXPIRIES });
    const agents = open(today, { pool: "agents", now: BETWEEN_EXPIRIES });

    expect(headline(owner)).toEqual([100, 14, 30, 10]);
    expect(agents.reserve_seven_day).toBe(0);
  });

  it("leave a standing band of 0 in place after the grant expires", () => {
    const agents = open(today, { pool: "agents", now: AFTER_EXPIRY });
    const server = open(today, { pool: "server", now: AFTER_EXPIRY });

    expect(headline(agents)).toEqual([95, 14, 30, 0]);
    expect(agents.sources.sonnet_band_points).toBe("pool");
    expect(server.sonnet_band_points).toBe(0);
  });

  it("are reported by checkLimits once expired", () => {
    const findings = checkLimits(parseLimits(today), { now: BETWEEN_EXPIRIES });
    const expired = findings.filter((f) => f.kind === "expired_override");

    expect(expired).toHaveLength(1);
    expect(expired[0]?.message).toContain("reserve-0-grant");
  });

  it("can lift a cap with null and the later entry wins", () => {
    const raw = minimal({
      pools: { p: { config_dir: "/x", ceiling_five_hour: 90, reserve_seven_day: 10, per_day_points: 30 } },
      overrides: [
        { per_day_points: 5, until: "2027-01-01T00:00:00Z", decision: "a" },
        { pools: ["p"], per_day_points: null, until: "2027-01-01T00:00:00Z", decision: "b" },
      ],
    });
    expect(open(raw, { pool: "p", now: BEFORE_EXPIRY }).per_day_points).toBeNull();
  });
});

describe("precedence", () => {
  const layered = {
    version: 1,
    defaults: { sonnet_band_points: 4, dispatch_five_hour_points: 7, pick_margin_five_hour: 3 },
    pools: {
      p: { config_dir: "/x", ceiling_five_hour: 90, reserve_seven_day: 10, sonnet_band_points: 5, per_day_points: 40 },
    },
    profiles: {
      impl: { reserve_seven_day: 11, sonnet_band_points: 6, pools: { p: { ceiling_five_hour: 80, sonnet_band_points: 7 } } },
    },
    overrides: [
      { profiles: ["impl"], per_day_points: 12, until: "2027-01-01T00:00:00Z", decision: "o" },
    ],
  };

  it("resolves each field from the most specific layer that sets it", () => {
    const limits = open(layered, { pool: "p", profile: "impl", now: BEFORE_EXPIRY });

    expect(limits.sources).toMatchObject({
      dispatch_seven_day_points: "code",
      dispatch_five_hour_points: "defaults",
      pick_margin_five_hour: "defaults",
      reserve_seven_day: "profile",
      ceiling_five_hour: "profile_pool",
      sonnet_band_points: "profile_pool",
      per_day_points: "override",
    });
    expect(limits.dispatch_seven_day_points).toBe(LIMIT_DEFAULTS.dispatch_seven_day_points);
    expect([limits.ceiling_five_hour, limits.reserve_seven_day, limits.sonnet_band_points]).toEqual([80, 11, 7]);
    expect(limits.per_day_points).toBe(12);
  });

  it("applies no profile layer or profile-scoped override to a spawn of another profile", () => {
    const limits = open(layered, { pool: "p", profile: "other", now: BEFORE_EXPIRY });
    expect(headline(limits)).toEqual([90, 10, 40, 5]);
  });
});

describe("clamps", () => {
  it("hold the ceiling at 100, the reserve within 0-100 and margins at 0 or more", () => {
    const raw = minimal({
      defaults: { pick_margin_five_hour: -5 },
      pools: { p: { config_dir: "/x", ceiling_five_hour: 120, reserve_seven_day: -3, sonnet_band_points: -1 } },
    });
    const limits = open(raw, { pool: "p", now: BEFORE_EXPIRY });

    expect([limits.ceiling_five_hour, limits.reserve_seven_day]).toEqual([100, 0]);
    expect([limits.sonnet_band_points, limits.pick_margin_five_hour]).toEqual([0, 0]);
    expect(checkLimits(parseLimits(raw), { now: BEFORE_EXPIRY }).filter((f) => f.kind === "clamped")).toHaveLength(4);
  });
});

describe("failing closed per scope", () => {
  it("closes a pool with no config_dir and leaves the others open", () => {
    const raw = { ...today, pools: { ...today.pools, owner: { ceiling_five_hour: 100, reserve_seven_day: 14 } } };
    const parsed = parseLimits(raw);

    expect(resolveLimits(parsed, { pool: "owner", now: BEFORE_EXPIRY })).toMatchObject({ open: false });
    expect(resolveLimits(parsed, { pool: "agents", now: BEFORE_EXPIRY }).open).toBe(true);
    expect(checkLimits(parsed, { now: BEFORE_EXPIRY }).map((f) => f.kind)).toContain("invalid_pool");
  });

  it("closes a pool the block does not name", () => {
    expect(resolveLimits(parseLimits(today), { pool: "nope", now: BEFORE_EXPIRY })).toMatchObject({ open: false });
  });

  it("closes spawns of a malformed profile and only those", () => {
    const parsed = parseLimits(minimal({ profiles: { bad: { ceiling_five_hour: "high" } } }));

    expect(resolveLimits(parsed, { pool: "p", profile: "bad", now: BEFORE_EXPIRY }).open).toBe(false);
    expect(resolveLimits(parsed, { pool: "p", profile: "good", now: BEFORE_EXPIRY }).open).toBe(true);
  });

  it("ignores a malformed override and keeps the standing value", () => {
    const raw = minimal({ overrides: [{ reserve_seven_day: 0, until: "Saturday", decision: "x" }] });

    expect(open(raw, { pool: "p", now: BEFORE_EXPIRY }).reserve_seven_day).toBe(10);
    expect(checkLimits(parseLimits(raw), { now: BEFORE_EXPIRY }).map((f) => f.kind)).toContain("ignored_override");
  });
});

describe("seat caps", () => {
  it("tighten the pool's per-day cap and add a per-run cap", () => {
    const limits = open(today, { pool: "agents", seat: "coord-a", now: BEFORE_EXPIRY });

    expect([limits.per_day_points, limits.per_run_points]).toEqual([20, 8]);
    expect(limits.sources.per_day_points).toBe("seat");
  });

  it("never loosen the pool's per-day cap", () => {
    const raw = { ...today, seats: { "coord-a": { per_day_points: 90 } } };
    expect(open(raw, { pool: "agents", seat: "coord-a", now: BEFORE_EXPIRY }).per_day_points).toBe(30);
  });
});

describe("checkLimits", () => {
  it("reports funds and overrides that name a pool the block lacks", () => {
    const raw = { ...today, funds: { default: ["owner", "ghost"] } };
    const unknown = checkLimits(parseLimits(raw), { now: BEFORE_EXPIRY }).filter((f) => f.kind === "unknown_pool");
    expect(unknown.map((f) => f.message).join()).toContain("ghost");
  });

  it("warns on a config_dir that no discovered profile has", () => {
    const findings = checkLimits(parseLimits(today), {
      now: BEFORE_EXPIRY,
      knownConfigDirs: ["/srv/claude/owner", "/srv/claude/profiles/agents"],
    });
    expect(findings.filter((f) => f.kind === "unknown_config_dir")).toHaveLength(2);
  });

  it("reports a band fallback to a profile not in the known list", () => {
    const findings = checkLimits(parseLimits(today), { now: BEFORE_EXPIRY, knownProfiles: ["bd-reviewer"] });
    expect(findings.map((f) => f.kind)).toContain("unknown_profile");
  });

  it("reports one deprecated_key per per_day_points and per_run_points in the old fixture, and still resolves them", () => {
    const parsed = parseLimits(today);
    const messages = checkLimits(parsed, { now: BEFORE_EXPIRY })
      .filter((f) => f.kind === "deprecated_key")
      .map((f) => f.message);

    expect(messages).toHaveLength(6);
    for (const path of ["pools.owner.per_day_points", "pools.agents.per_day_points", "pools.spare.per_day_points", "pools.server.per_day_points", "seats.coord-a.per_run_points", "seats.coord-a.per_day_points"]) {
      expect(messages.some((m) => m.startsWith(`${path} `))).toBe(true);
    }
    expect(open(today, { pool: "owner", now: BEFORE_EXPIRY }).per_day_points).toBe(30);
  });

  it("reports deprecated keys on defaults, profiles, profile pools, seats and a null override", () => {
    const raw = minimal({
      defaults: { per_day_points: 5 },
      profiles: { p: { per_day_points: 6, pools: { main: { per_day_points: 7 } } } },
      seats: { s: { per_run_points: 8 } },
      overrides: [{ per_day_points: null, until: "2026-10-10T18:00:00Z", decision: "lift" }],
    });
    const paths = checkLimits(parseLimits(raw), { now: BEFORE_EXPIRY })
      .filter((f) => f.kind === "deprecated_key")
      .map((f) => f.message.split(" ")[0] === "override" ? `override ${f.message.split(" ")[1]}` : f.message.split(" ")[0]);

    expect(paths).toEqual(
      expect.arrayContaining([
        "defaults.per_day_points",
        "profiles.p.per_day_points",
        "profiles.p.pools.main.per_day_points",
        "seats.s.per_run_points",
        "override lift.per_day_points",
      ]),
    );
    expect(paths).toHaveLength(5);
  });

  it("reports no deprecated key on a block without per_* fields", () => {
    const findings = checkLimits(parseLimits(minimal()), { now: BEFORE_EXPIRY });
    expect(findings.filter((f) => f.kind === "deprecated_key")).toEqual([]);
  });
});

describe("capacity, shepherd and seat slot keys", () => {
  const slotted = (extra: Record<string, unknown> = {}) =>
    minimal({
      capacity: { max_agents: 30, reserve_slots: 2 },
      shepherd: { spawn_gate: { load5: 16, build_load5: 12 }, review: { max_concurrent: 5 } },
      seats: { "coord-a": { hand_reserve: 2, brief_gate: "shadow" } },
      ...extra,
    });

  it("parse as part of a version 1 block", () => {
    expect(limitsSchema.safeParse(slotted()).success).toBe(true);
    expect(parseLimits(slotted()).limits.capacity?.max_agents).toBe(30);
  });

  it("resolve capacity and the seat's hand reserve with their source", () => {
    const capacity = resolveCapacity(parseLimits(slotted()), "coord-a");

    expect(capacity.max_agents).toEqual({ value: 30, source: "capacity" });
    expect(capacity.hand_reserve).toEqual({ value: 2, source: "seat" });
    expect(capacity.brief_gate).toEqual({ value: "shadow", source: "seat" });
    expect(capacity.max_worktrees_per_repo).toEqual({ value: null, source: "unset" });
  });

  it("leave every field unset when the block has no such sections", () => {
    const capacity = resolveCapacity(parseLimits(minimal()), "coord-a");
    const shepherd = resolveShepherd(parseLimits(minimal()));

    expect(Object.values(capacity).every((s) => s.source === "unset")).toBe(true);
    expect(shepherd.review.max_concurrent).toEqual({ value: null, source: "unset" });
  });

  it("resolve Shepherd's review cap and spawn gate", () => {
    const shepherd = resolveShepherd(parseLimits(slotted()));

    expect(shepherd.review.max_concurrent).toEqual({ value: 5, source: "shepherd" });
    expect(shepherd.spawn_gate.load5).toEqual({ value: 16, source: "shepherd" });
    expect(shepherd.spawn_gate.build_load5.value).toBe(12);
  });

  it("drop a malformed capacity section with a finding and keep every pool open", () => {
    const raw = { ...today, capacity: { max_agents: -1 } };
    const parsed = parseLimits(raw);

    expect(resolveCapacity(parsed).max_agents).toEqual({ value: null, source: "unset" });
    for (const pool of Object.keys(today.pools)) {
      expect(resolveLimits(parsed, { pool, now: BEFORE_EXPIRY }).open).toBe(true);
    }
    expect(checkLimits(parsed, { now: BEFORE_EXPIRY }).map((f) => f.kind)).toContain("ignored_section");
  });

  it("drop a malformed shepherd section without touching a valid capacity section", () => {
    const parsed = parseLimits(slotted({ shepherd: { review: { max_concurrent: "five" } } }));

    expect(parsed.ignoredSections.shepherd).toBeDefined();
    expect(resolveShepherd(parsed).review.max_concurrent.source).toBe("unset");
    expect(resolveCapacity(parsed).max_agents.value).toBe(30);
  });

  it("close a seat whose brief gate is not a known mode", () => {
    const parsed = parseLimits(slotted({ seats: { "coord-a": { brief_gate: "always" } } }));
    expect(resolveLimits(parsed, { pool: "p", seat: "coord-a", now: BEFORE_EXPIRY }).open).toBe(false);
  });
});
