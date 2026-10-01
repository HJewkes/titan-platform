import { describe, expect, it } from "vitest";
import { parseLaunchArgs } from "./launch-args.js";
import { loginGap, tailKeeper } from "./launch-output.js";

describe("the stderr tail", () => {
  it("keeps only the last characters however much is appended", () => {
    const tail = tailKeeper(5);
    tail.append("abc");
    tail.append("defgh");

    expect(tail.text()).toBe("defgh");
  });
});

describe("the login diagnosis", () => {
  it("names the config dir the agent used when claude says it is not logged in", () => {
    expect(loginGap("Not logged in · Please run /login", "/cfg")).toContain("CLAUDE_CONFIG_DIR=/cfg");
    expect(loginGap("Please run /login", undefined)).toContain("CLAUDE_CONFIG_DIR unset");
  });

  it("says nothing for any other failure", () => {
    expect(loginGap("segfault", "/cfg")).toBeUndefined();
    expect(loginGap(undefined, "/cfg")).toBeUndefined();
  });
});

describe("the launcher's arguments", () => {
  it("takes one plan file, optionally after the launcher pid variable", () => {
    expect(parseLaunchArgs(["/p.json"])).toEqual({ planFile: "/p.json" });
    expect(parseLaunchArgs(["--launcher-pid-env", "HOST_PID", "/p.json"])).toEqual({
      planFile: "/p.json",
      launcherPidEnv: "HOST_PID",
    });
  });

  it("refuses a missing plan, an unknown flag, extra words and a bad variable name", () => {
    for (const argv of [[], ["--verbose", "/p.json"], ["/p.json", "x"], ["--launcher-pid-env", "A=B", "/p.json"]])
      expect(parseLaunchArgs(argv)).toHaveProperty("error");
  });
});
