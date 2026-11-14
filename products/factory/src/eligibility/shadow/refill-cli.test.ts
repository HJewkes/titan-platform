import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../../cli.js";
import { enabledRules, fakeRpc, selectedBet, shadowHome, shadowTickCli, task } from "./tick.test-helpers.js";

const workspace = () => fakeRpc({ tasks: [task(1, { tags: ["lane-a", "brief:ready"] }), task(2), task(3, { tags: ["lane-a", "brief:ready", "parked"] })], bets: [selectedBet(1, 1, ["alpha/AL-1"])] });

function homeWithLane(lane: Record<string, unknown>): ReturnType<typeof shadowHome> {
  const home = shadowHome();
  writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home, { lanes: [lane] })));
  return home;
}

describe("shadow-tick ready-stock refill", () => {
  afterEach(() => void vi.useRealTimers());

  it("asks the operator once a day for a lane under its floor, counting only census-dispatchable tasks", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-18T12:00:00Z") });
    const home = homeWithLane({ initiative: "alpha", tag: "lane-a", floor: 3 });
    const send = vi.fn(async (_to: string, _text: string) => undefined);

    const first = await shadowTickCli(home, workspace().fetch, {}, [], { refillSend: () => send });
    const second = await shadowTickCli(home, workspace().fetch, {}, [], { refillSend: () => send });

    expect(first.code).toBe(EXIT.OK);
    expect(first.stdout).toContain("ready-stock refill sent for alpha[lane-a] (1 dispatchable, floor 3) -> tp-operator");
    expect(second.stdout).toContain("ready-stock refill already-sent for alpha[lane-a]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("tp-operator");
  });

  it("sends nothing when the lane sets no floor", async () => {
    const home = homeWithLane({ initiative: "alpha", tag: "lane-a" });
    const send = vi.fn(async () => undefined);

    const { code, stdout } = await shadowTickCli(home, workspace().fetch, {}, [], { refillSend: () => send });

    expect(code).toBe(EXIT.OK);
    expect(stdout).not.toContain("ready-stock refill");
    expect(send).not.toHaveBeenCalled();
  });
});
