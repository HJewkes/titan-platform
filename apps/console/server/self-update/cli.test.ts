import { describe, expect, it } from "vitest";
import { selfUpdateArgs } from "./cli.js";

describe("the self-update verbs", () => {
  it("reads a bare self-update as a pass and --smoke with a release and sha as the release's own check", () => {
    expect(selfUpdateArgs(["self-update"])).toEqual({ kind: "update" });
    expect(selfUpdateArgs(["self-update", "--smoke", "/srv/console/releases/b", "b".repeat(40)])).toEqual({ kind: "smoke", release: "/srv/console/releases/b", sha: "b".repeat(40) });
  });

  it("leaves any other shape to the usage error, which an older updater's fallback relies on", () => {
    expect(selfUpdateArgs(["self-update", "--smoke", "/srv/console/releases/b"])).toBeNull();
    expect(selfUpdateArgs(["self-update", "--smok", "/srv/console/releases/b", "b"])).toBeNull();
    expect(selfUpdateArgs(["login-link"])).toBeNull();
  });
});
