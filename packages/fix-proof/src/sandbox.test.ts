import { describe, expect, it } from "vitest";
import { sandboxCommand } from "./sandbox.js";

const ENV = { PATH: "/usr/bin:/bin", HOME: "/tmp/tree", CI: "1" };

describe("sandboxCommand", () => {
  it("sandbox command runs the script in a new PID namespace as the given user with no new privileges", () => {
    const command = sandboxCommand("fix-proof-sandbox", 90_500, ENV, "pnpm exec vitest run", ["--reporter=json", "a.test.ts"]);

    expect(command).toEqual({
      file: "sudo",
      args: [
        "-n", "--", "timeout", "-k", "5", "91",
        "unshare", "--pid", "--fork", "--kill-child", "--mount-proc", "--",
        "setpriv", "--reuid", "fix-proof-sandbox", "--regid", "fix-proof-sandbox", "--init-groups", "--no-new-privs", "--bounding-set=-all", "--",
        "env", "-i", "PATH=/usr/bin:/bin", "HOME=/tmp/tree", "CI=1",
        "sh", "-c", 'pnpm exec vitest run "$@"', "sh", "--reporter=json", "a.test.ts",
      ],
    });
  });

  it("a spent budget still gives timeout a positive duration", () => {
    const command = sandboxCommand("u", -20, ENV, "true", []);

    expect(command.args.slice(2, 6)).toEqual(["timeout", "-k", "5", "1"]);
  });

  it.each(["root; rm", "-u", "", "a".repeat(33), "Root", "1abc"])("a user name outside the pattern is refused: %j", (user) => {
    expect(() => sandboxCommand(user, 1000, ENV, "true", [])).toThrow(/sandbox user must match/);
  });
});
