import type * as NodeOs from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const passwd = vi.hoisted(() => ({ userInfo: (): { homedir: string } => ({ homedir: "/srv/passwd-home" }) }));

vi.mock("node:os", async (importOriginal) => ({ ...(await importOriginal<typeof NodeOs>()), userInfo: () => passwd.userInfo() }));

/** The module evaluated afresh over the passwd entry this file fakes. */
async function productionPath(): Promise<string | undefined> {
  vi.resetModules();
  return (await import("./bot-token-path.js")).BOT_TOKEN_PATH;
}

afterEach(() => {
  vi.unstubAllEnvs();
  passwd.userInfo = () => ({ homedir: "/srv/passwd-home" });
});

describe("serve's bot token path in production (TP-3419)", () => {
  it("sits in the secrets dir under the passwd entry's home, whatever $HOME says", async () => {
    vi.stubEnv("HOME", "/srv/elsewhere");

    expect(await productionPath()).toBe("/srv/passwd-home/.config/titan-factory/secrets/github-bot.token");
  });

  it("is undefined for a uid with no passwd entry, so serve looks nowhere", async () => {
    passwd.userInfo = () => {
      throw new Error("no passwd entry");
    };

    expect(await productionPath()).toBeUndefined();
  });
});
