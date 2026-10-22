import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../config.js";
import { selfUpdateArgs, selfUpdateVerb } from "./cli.js";

const SHA = "b".repeat(40);

describe("the self-update verbs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads --apply with a full sha and --report as the bootstrap's hand-offs, and --smoke as an older updater's check", () => {
    expect(selfUpdateArgs(["self-update", "--apply", SHA])).toEqual({ kind: "apply", sha: SHA });
    expect(selfUpdateArgs(["self-update", "--report"])).toEqual({ kind: "report" });
    expect(selfUpdateArgs(["self-update", "--smoke", "/srv/console/releases/b", SHA])).toEqual({ kind: "smoke", release: "/srv/console/releases/b", sha: SHA });
  });

  it("runs the serving release's bootstrap for a bare self-update from an old timer unit, and passes its exit code through", async () => {
    vi.stubEnv("TITAN_CONSOLE_UPDATE_ROOT", "/srv/tester/console");
    const spawned: { script: string; env: NodeJS.ProcessEnv }[] = [];
    const spawn = (script: string, env: NodeJS.ProcessEnv): Promise<number> => {
      spawned.push({ script, env });
      return Promise.resolve(75);
    };
    const args = selfUpdateArgs(["self-update"]);
    if (args === null) throw new Error("a bare self-update must parse");

    const code = await selfUpdateVerb(() => resolveConfig({ TITAN_CONSOLE_STATE: "/srv/tester/state" }, "/srv/tester"), args, spawn);

    expect(code).toBe(75);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.script).toBe("/srv/tester/console/current/apps/console/deploy/titan-console-bootstrap.mts");
    expect(spawned[0]?.env).toMatchObject({ TITAN_CONSOLE_UPDATE_ROOT: "/srv/tester/console", TITAN_CONSOLE_STATE: "/srv/tester/state" });
  });

  it("leaves any other shape to the usage error, which an older updater's fallback relies on", () => {
    expect(selfUpdateArgs(["self-update", "--apply", "main"])).toBeNull();
    expect(selfUpdateArgs(["self-update", "--smoke", "/srv/console/releases/b"])).toBeNull();
    expect(selfUpdateArgs(["self-update", "--smok", "/srv/console/releases/b", "b"])).toBeNull();
    expect(selfUpdateArgs(["login-link"])).toBeNull();
  });
});
