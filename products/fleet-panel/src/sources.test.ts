import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeAccountHome, writeAccountHome } from "./account-home.js";
import { FIXTURE_ACCOUNTS, NOW_MS, ROSTER_JSON } from "./fixture.js";
import { brokerAddress, nodeSources, type CliOptions, type CliRunner } from "./sources.js";

describe("nodeSources", () => {
  it("forbids agent-chat from starting a broker on every CLI read, keeping the rest of the env", async () => {
    const calls: { args: string[]; options: CliOptions }[] = [];
    const runner: CliRunner = async (_file, args, options) => {
      calls.push({ args, options });
      return { stdout: ROSTER_JSON };
    };
    const env = { AGENT_CHAT_HOME: "/srv/chat", AGENT_CHAT_NO_AUTOSTART: "0" };
    const sources = nodeSources(brokerAddress(env), env, runner);

    await sources.roster();
    await sources.accounts();

    expect(calls.map((call) => call.args)).toEqual([["agent", "ls", "--json"]]);
    for (const { options } of calls) expect(options.env).toMatchObject({ AGENT_CHAT_HOME: "/srv/chat", AGENT_CHAT_NO_AUTOSTART: "1" });
  });

  describe("accounts", () => {
    let home: string;
    beforeEach(() => {
      home = writeAccountHome();
    });
    afterEach(() => removeAccountHome(home));

    it("reads the accounts from the home's profiles without running the CLI", async () => {
      const runner: CliRunner = async () => {
        throw new Error("the CLI must not run");
      };
      const accountOptions = { home, now: NOW_MS, platform: "linux" as const, uid: process.getuid?.() ?? 0 };
      const sources = nodeSources(brokerAddress({}), {}, runner, accountOptions);

      const accounts = await sources.accounts();

      expect(accounts.map((row) => row.fiveHour?.usedPct ?? null).sort()).toEqual(FIXTURE_ACCOUNTS.map((row) => row.fiveHour?.usedPct ?? null).sort());
    });
  });
});
