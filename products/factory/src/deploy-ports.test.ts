import { describe, expect, it } from "vitest";
import { deployPnpmEnv } from "./deploy-ports.js";

describe("deployPnpmEnv", () => {
  it("lets pnpm switch to the checkout's pinned version, even over an inherited opt-out", () => {
    const env = deployPnpmEnv({ PATH: "/bin", npm_config_manage_package_manager_versions: "false" });

    expect(env.npm_config_manage_package_manager_versions).toBe("true");
    expect(env.NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS).toBe("true");
  });

  it("purges a foreign modules layout without a prompt that would exit before installing", () => {
    const env = deployPnpmEnv({ PATH: "/bin" });

    expect(env.CI).toBe("true");
  });

  it("keeps the setup env's other pins and allowlist", () => {
    const env = deployPnpmEnv({ PATH: "/bin", SECRET_TOKEN: "x" });

    expect(env.npm_config_ignore_scripts).toBe("true");
    expect(env.PATH).toBe("/bin");
    expect(env.SECRET_TOKEN).toBeUndefined();
  });
});
