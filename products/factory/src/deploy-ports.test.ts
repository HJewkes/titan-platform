import { describe, expect, it } from "vitest";
import { deployPnpmEnv, runCommand } from "./deploy-ports.js";

const INSTALL = ["install", "--frozen-lockfile"];
const BUILD = ["--filter", "@titan-design/factory...", "build"];

describe("deployPnpmEnv", () => {
  it("lets pnpm switch to the checkout's pinned version, even over an inherited opt-out", () => {
    const env = deployPnpmEnv({ PATH: "/bin", npm_config_manage_package_manager_versions: "false" }, INSTALL);

    expect(env.npm_config_manage_package_manager_versions).toBe("true");
    expect(env.NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS).toBe("true");
  });

  it("purges a foreign modules layout without a prompt that would exit before installing", () => {
    const env = deployPnpmEnv({ PATH: "/bin" }, INSTALL);

    expect(env.CI).toBe("true");
  });

  it("keeps the setup env's other pins and allowlist for the install", () => {
    const env = deployPnpmEnv({ PATH: "/bin", SECRET_TOKEN: "x" }, INSTALL);

    expect(env.npm_config_ignore_scripts).toBe("true");
    expect(env.PATH).toBe("/bin");
    expect(env.SECRET_TOKEN).toBeUndefined();
  });

  it("lets the build run scripts, since pinned pnpm 9 leaves node_modules/.bin off PATH under ignore-scripts", () => {
    const env = deployPnpmEnv({ PATH: "/bin", SECRET_TOKEN: "x" }, BUILD);

    expect(env.npm_config_ignore_scripts).toBe("false");
    expect(env.NPM_CONFIG_IGNORE_SCRIPTS).toBe("false");
    expect(env.npm_config_manage_package_manager_versions).toBe("true");
    expect(env.SECRET_TOKEN).toBeUndefined();
  });
});

describe("runCommand", () => {
  const node = (script: string, timeout = 10_000) => runCommand(process.execPath, ["-e", script], process.cwd(), timeout, { PATH: process.env.PATH });

  it("keeps stdout and the exit code when a command fails with nothing on stderr", async () => {
    const result = await node("console.log('tsup: command not found'); process.exit(3)");

    expect(result).toEqual({ code: 3, stdout: "tsup: command not found\n", stderr: "" });
  });

  it("says a command was killed at its timeout", async () => {
    const result = await node("setTimeout(() => {}, 10_000)", 200);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("killed by SIGTERM after the 0.2 s timeout");
  });

  it("exits 127 for a missing binary", async () => {
    const result = await runCommand("no-such-binary-tp-1715", [], process.cwd(), 1_000, { PATH: "/nonexistent" });

    expect(result.code).toBe(127);
  });
});
