import { describe, expect, it } from "vitest";
import { sandboxCommand, sandboxEnv } from "./sandbox.js";

const ENV = { PATH: "/usr/bin:/bin", HOME: "/tmp/tree", CI: "1" };

describe("sandboxCommand", () => {
  it("sandbox command runs the script in a new PID namespace as the given user with no new privileges", () => {
    const command = sandboxCommand("fix-proof-sandbox", 90_500, ENV, "pnpm exec vitest run", ["--reporter=json", "a.test.ts"], () => "4242");

    expect(command).toEqual({
      file: "sudo",
      args: [
        "-n", "--", "timeout", "-k", "5", "91",
        "unshare", "--pid", "--fork", "--kill-child", "--mount-proc", "--",
        "setpriv", "--reuid", "fix-proof-sandbox", "--regid", "4242", "--init-groups", "--no-new-privs", "--bounding-set=-all", "--",
        "env", "-i", "PATH=/usr/bin:/bin", "HOME=/tmp/tree", "CI=1",
        "sh", "-c", 'pnpm exec vitest run "$@"', "sh", "--reporter=json", "a.test.ts",
      ],
    });
  });

  it("a spent budget still gives timeout a positive duration", () => {
    const command = sandboxCommand("u", -20, ENV, "true", [], () => "1");

    expect(command.args.slice(2, 6)).toEqual(["timeout", "-k", "5", "1"]);
  });

  it("a user whose primary group is named differently gets the numeric gid as --regid", () => {
    const lookup = (user: string) => (user === "svc-runner" ? "4321" : null);

    const { args } = sandboxCommand("svc-runner", 1000, ENV, "true", [], lookup);

    expect(args.slice(args.indexOf("--reuid"), args.indexOf("--init-groups"))).toEqual(["--reuid", "svc-runner", "--regid", "4321"]);
  });

  it("a user whose gid cannot be resolved is refused, never run unsandboxed", () => {
    expect(() => sandboxCommand("svc-runner", 1000, ENV, "true", [], () => null)).toThrow(/no resolvable primary gid/);
  });

  it.each(["root; rm", "-u", "", "a".repeat(33), "Root", "1abc"])("a user name outside the pattern is refused: %j", (user) => {
    expect(() => sandboxCommand(user, 1000, ENV, "true", [], () => "1")).toThrow(/sandbox user must match/);
  });
});

describe("sandboxEnv", () => {
  it("points Playwright at the browser cache named in the parent env", () => {
    const env = sandboxEnv("/tmp/tree", { PATH: "/usr/bin", HOME: "/home/runner", PLAYWRIGHT_BROWSERS_PATH: "/opt/browsers" });

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/tmp/tree", CI: "1", PLAYWRIGHT_BROWSERS_PATH: "/opt/browsers" });
  });

  it("sets no browser path when the parent env names none", () => {
    const env = sandboxEnv("/tmp/tree", { HOME: "/home/runner" });

    expect(env).not.toHaveProperty("PLAYWRIGHT_BROWSERS_PATH");
    expect(env.HOME).toBe("/tmp/tree");
  });
});
