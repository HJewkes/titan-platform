import { describe, expect, it } from "vitest";
import { checkCoordinatorConfig, coordinatorConfigSchema } from "./coordinator-config.js";

function exampleConfig() {
  return {
    $schema: "titan-coordinator/v1",
    owner: {
      seat: "operator",
      timezone: "UTC",
      day_starts_at: "07:00",
      digest_at: ["06:00", "12:00", "18:00"],
      channels: ["console"],
      decider: { enabled: false, question_age_minutes: 720 },
    },
    state_dir: null,
    service: { label_prefix: "dev.example." },
    task_sources: { tasks: { kind: "active-work" } },
    repos: {
      web: { path: "~/src/web", remote: "example/web", default: "main", public: false },
    } as Record<string, Record<string, unknown>>,
    seats: {
      operator: {
        prefix: "op",
        role: "communicator",
        attended: true,
        pool: "main",
        concurrency: { implementers: 0, reviewers: 0, planners: 1 },
        spend: {},
      },
      "web-coord": {
        prefix: "wc",
        pool: "main",
        dispatch: "tick",
        initiatives: { web: 1.0 },
        repos: ["web"],
        concurrency: { implementers: 2, reviewers: 2, planners: 1 },
        spend: { per_run_points: 10, per_day_points: 20 },
      },
    } as Record<string, Record<string, unknown>>,
    limits: {
      version: 1,
      pools: { main: { config_dir: "~/.claude", ceiling_five_hour: 90, reserve_seven_day: 20 } },
      funds: { default: ["main"] } as Record<string, string[]>,
    },
    policy: {
      hard_stops: ["force-push", "npm-publish", "deploy", "spend-money", "config-edit"] as string[],
      hard_stop_repos: { "config-edit": [] } as Record<string, string[]>,
      human_only_tag: "human-only",
      defaults: {},
    },
  };
}

function errorPaths(raw: unknown): string[] {
  const result = checkCoordinatorConfig(raw);
  return result.ok ? [] : result.errors.map((e) => e.path);
}

describe("coordinatorConfigSchema", () => {
  it("parses the example document", () => {
    expect(coordinatorConfigSchema.safeParse(exampleConfig()).success).toBe(true);
  });

  it("keeps an unknown top-level key on read", () => {
    const parsed = coordinatorConfigSchema.parse({ ...exampleConfig(), later: 1 });
    expect(parsed.later).toBe(1);
  });

  it("rejects an unknown schema version", () => {
    const config = { ...exampleConfig(), $schema: "titan-coordinator/v2" };
    expect(coordinatorConfigSchema.safeParse(config).success).toBe(false);
  });

  it("takes limits exactly as agent-dispatch defines them, so an unknown pool key fails", () => {
    const config = exampleConfig();
    Object.assign(config.limits.pools.main, { surprise: 1 });
    expect(coordinatorConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("checkCoordinatorConfig", () => {
  it("accepts the example document", () => {
    const result = checkCoordinatorConfig(exampleConfig());
    expect(result).toMatchObject({ ok: true });
  });

  it("names the key path of a seat pool missing from limits.pools", () => {
    const config = exampleConfig();
    config.seats["web-coord"]!.pool = "spare";
    expect(errorPaths(config)).toEqual(["seats.web-coord.pool"]);
  });

  it("names overflow_pool, pools[] and fund entries that are not limits pools", () => {
    const config = exampleConfig();
    Object.assign(config.seats["web-coord"]!, { overflow_pool: "spare", pools: ["main", "other"] });
    config.limits.funds.default = ["gone"];
    expect(errorPaths(config)).toEqual([
      "seats.web-coord.overflow_pool",
      "seats.web-coord.pools.1",
      "limits.funds.default.0",
    ]);
  });

  it("refuses two attended seats", () => {
    const config = exampleConfig();
    config.seats["web-coord"]!.attended = true;
    expect(errorPaths(config)).toEqual(["seats"]);
  });

  it("refuses an owner.seat that is not the attended seat", () => {
    const config = exampleConfig();
    config.owner.seat = "web-coord";
    expect(errorPaths(config)).toEqual(["owner.seat"]);
  });

  it("refuses a seat repo id missing from repos", () => {
    const config = exampleConfig();
    config.seats["web-coord"]!.repos = ["web", "api"];
    expect(errorPaths(config)).toEqual(["seats.web-coord.repos.1"]);
  });

  it("refuses a repo shared by seats it does not list in shared_with", () => {
    const config = exampleConfig();
    config.seats.operator!.repos = ["web"];
    expect(errorPaths(config)).toEqual(["seats.operator.repos.0", "seats.web-coord.repos.0"]);
  });

  it("accepts a repo shared by seats it lists in shared_with", () => {
    const config = exampleConfig();
    config.seats.operator!.repos = ["web"];
    config.repos.web!.shared_with = ["operator", "web-coord"];
    expect(errorPaths(config)).toEqual([]);
  });

  it("refuses two seats with the same prefix", () => {
    const config = exampleConfig();
    config.seats["web-coord"]!.prefix = "op";
    expect(errorPaths(config)).toEqual(["seats.web-coord.prefix"]);
  });

  it("refuses config_dir on a seat, since it lives only on the pool", () => {
    const config = exampleConfig();
    config.seats["web-coord"]!.config_dir = "~/.claude";
    expect(errorPaths(config)).toEqual(["seats.web-coord.config_dir"]);
  });

  it("refuses an unknown hard-stop class", () => {
    const config = exampleConfig();
    config.policy.hard_stops.push("launch-rockets");
    const result = checkCoordinatorConfig(config);
    expect(result).toMatchObject({ ok: false, errors: [{ code: "invalid", path: "policy.hard_stops.5" }] });
  });

  it("refuses a hard_stop_repos key that is not in hard_stops", () => {
    const config = exampleConfig();
    config.policy.hard_stop_repos = { "tag-move": [] };
    expect(errorPaths(config)).toEqual(["policy.hard_stop_repos.tag-move"]);
  });

  it("reports a missing section as missing, without throwing", () => {
    const config: Record<string, unknown> = exampleConfig();
    delete config.limits;
    const result = checkCoordinatorConfig(config);
    expect(result).toMatchObject({ ok: false, errors: [{ code: "missing", path: "limits" }] });
  });
});
