import { describe, expect, it } from "vitest";
import { OPERATOR_HOLD_TTL_MS, operatorHoldReader } from "./operator-hold.js";

const FILE_HOLD = { kind: "file", by: "tp-operator", since: "2026-10-11T21:00:00.000Z", reason: "reboot window" };

function status(fields: { holds?: unknown[]; errors?: string[]; stop?: string | null } = {}): string {
  const { holds = [], errors = [], stop = null } = fields;
  return JSON.stringify({ at: "2026-10-11T21:14:00.000Z", stopped: holds.length > 0 || errors.length > 0 || stop !== null, holds, ownerStops: [], machine: { load5: 1, stop }, errors });
}

function readerOver(answers: Array<string | Error>) {
  let clock = 0;
  const calls: string[][] = [];
  const logs: string[] = [];
  const exec = async (bin: string, args: readonly string[]) => {
    calls.push([bin, ...args]);
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    if (answer instanceof Error) throw answer;
    return answer ?? "";
  };
  const read = operatorHoldReader("/bin/agent-chat", { exec, now: () => clock, log: (line) => logs.push(line) });
  return { read, calls, logs, advance: (ms: number) => (clock += ms) };
}

describe("operatorHoldReader", async () => {
  it("answers held with who holds and why when the status lists a hold", async () => {
    const { read, calls } = readerOver([status({ holds: [FILE_HOLD] })]);

    const answer = await read();

    expect(answer).toEqual({ state: "held", reason: "operator HOLD by tp-operator since 2026-10-11T21:00:00.000Z: reboot window" });
    expect(calls).toEqual([["/bin/agent-chat", "machine", "status", "--json"]]);
  });

  it("answers clear when no hold stands, whatever the machine stop says", async () => {
    const { read } = readerOver([status({ stop: "load5 30 (limit 12)" })]);

    expect(await read()).toEqual({ state: "clear" });
  });

  it("answers unreadable, naming the source, when agent-chat could not read one", async () => {
    const { read } = readerOver([status({ errors: ["events.db"] })]);

    expect(await read()).toEqual({ state: "unreadable", reason: "agent-chat could not read events.db" });
  });

  it("answers unreadable when the exec fails, as an agent-chat without the verb or a timeout does", async () => {
    const { read } = readerOver([new Error("Command failed: agent-chat machine status --json\nerror: unknown command 'machine'")]);

    expect(await read()).toEqual({ state: "unreadable", reason: "agent-chat machine status failed: Command failed: agent-chat machine status --json" });
  });

  it("answers unreadable when the status is not the expected document", async () => {
    const { read } = readerOver(['{"stopped":true}']);

    expect((await read()).state).toBe("unreadable");
  });

  it("runs the exec once for two reads inside the TTL and again after it", async () => {
    const { read, calls, advance } = readerOver([status({ holds: [FILE_HOLD] }), status()]);

    await read();
    advance(OPERATOR_HOLD_TTL_MS - 1);
    const cached = await read();
    advance(1);
    const fresh = await read();

    expect(cached.state).toBe("held");
    expect(fresh).toEqual({ state: "clear" });
    expect(calls).toHaveLength(2);
  });

  it("logs an unreadable streak once and again after a readable answer ends it", async () => {
    const { read, logs, advance } = readerOver([new Error("timeout"), new Error("timeout"), status(), new Error("timeout")]);

    for (let i = 0; i < 4; i += 1) {
      await read();
      advance(OPERATOR_HOLD_TTL_MS);
    }

    expect(logs).toEqual(["shepherd: operator_hold unreadable: agent-chat machine status failed: timeout", "shepherd: operator_hold unreadable: agent-chat machine status failed: timeout"]);
  });

  it("shares one exec between two reads inside the TTL while the first is still running", async () => {
    let finish: (json: string) => void = () => undefined;
    let execs = 0;
    const exec = () => {
      execs += 1;
      return new Promise<string>((resolve) => (finish = resolve));
    };
    const read = operatorHoldReader("/bin/agent-chat", { exec, now: () => 0 });

    const first = read();
    const second = read();
    finish(status({ holds: [FILE_HOLD] }));

    expect((await second).state).toBe("held");
    expect(await first).toEqual(await second);
    expect(execs).toBe(1);
  });
});
