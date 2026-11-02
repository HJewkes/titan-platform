import { describe, expect, it } from "vitest";
import { ACCOUNTS_JSON, ROSTER_JSON } from "./fixture.js";
import { brokerAddress, nodeSources, type CliOptions, type CliRunner } from "./sources.js";

describe("nodeSources", () => {
  it("forbids agent-chat from starting a broker on every CLI read, keeping the rest of the env", async () => {
    const calls: { args: string[]; options: CliOptions }[] = [];
    const runner: CliRunner = async (_file, args, options) => {
      calls.push({ args, options });
      return { stdout: args.includes("ls") ? ROSTER_JSON : ACCOUNTS_JSON };
    };
    const env = { AGENT_CHAT_HOME: "/srv/chat", AGENT_CHAT_NO_AUTOSTART: "0" };
    const sources = nodeSources(brokerAddress(env), env, runner);

    await sources.roster();
    await sources.accounts();

    expect(calls.map((call) => call.args[1])).toEqual(["ls", "budget"]);
    for (const { options } of calls) expect(options.env).toMatchObject({ AGENT_CHAT_HOME: "/srv/chat", AGENT_CHAT_NO_AUTOSTART: "1" });
  });
});
