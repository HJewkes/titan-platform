import { describe, expect, it } from "vitest";
import { selfUpdateArgs } from "./cli.js";

const SHA = "b".repeat(40);

describe("the self-update verbs", () => {
  it("reads --apply with a full sha and --report as the bootstrap's hand-offs, and --smoke as an older updater's check", () => {
    expect(selfUpdateArgs(["self-update", "--apply", SHA])).toEqual({ kind: "apply", sha: SHA });
    expect(selfUpdateArgs(["self-update", "--report"])).toEqual({ kind: "report" });
    expect(selfUpdateArgs(["self-update", "--smoke", "/srv/console/releases/b", SHA])).toEqual({ kind: "smoke", release: "/srv/console/releases/b", sha: SHA });
  });

  it("answers a bare self-update from an old timer unit with a pointer to the bootstrap", () => {
    expect(selfUpdateArgs(["self-update"])).toEqual({ kind: "moved" });
  });

  it("leaves any other shape to the usage error, which an older updater's fallback relies on", () => {
    expect(selfUpdateArgs(["self-update", "--apply", "main"])).toBeNull();
    expect(selfUpdateArgs(["self-update", "--smoke", "/srv/console/releases/b"])).toBeNull();
    expect(selfUpdateArgs(["self-update", "--smok", "/srv/console/releases/b", "b"])).toBeNull();
    expect(selfUpdateArgs(["login-link"])).toBeNull();
  });
});
