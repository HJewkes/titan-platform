import { describe, expect, it } from "vitest";
import { fenceForeignServe, isFactoryServeArgv, type Listener, type PortOwnerPorts, type ProcessInfo } from "./port-owner.js";

const PORT = 7410;
const SERVICE = { name: "titan-factory.service", pid: 100 };
const FOREIGN = 4242;
const SERVE_ARGV = ["/usr/bin/node", "/home/me/titan-platform/products/factory/dist/bin.js", "serve", "--port", "7410"];

interface TableInit {
  listeners?: Listener[] | undefined;
  info?: ProcessInfo;
  /** ms after SIGTERM the process exits; absent means it ignores SIGTERM. */
  exitsAfterTermMs?: number;
  /** The process ignores SIGKILL too. */
  unkillable?: boolean;
  /** processInfo reads after which the pid names another process. */
  reusedAfterReads?: number;
}

/** A process table and clock with one listener; signals only change what the fake reports. */
function fakeTable(init: TableInit) {
  const signals: string[] = [];
  const lines: string[] = [];
  let clock = 0;
  let termAt: number | undefined;
  let killed = false;
  let reads = 0;
  const exited = (): boolean =>
    (termAt !== undefined && init.exitsAfterTermMs !== undefined && clock >= termAt + init.exitsAfterTermMs) || (killed && !init.unkillable);
  const ports: PortOwnerPorts = {
    listeners: async () => ("listeners" in init ? init.listeners : [{ pid: FOREIGN }]),
    processInfo: async () => {
      reads++;
      if (exited()) return undefined;
      const info = init.info ?? { argv: SERVE_ARGV, cgroupUnit: "session-3.scope", startedAt: "8800" };
      return init.reusedAfterReads !== undefined && reads > init.reusedAfterReads ? { argv: ["/bin/sh"], startedAt: "9900" } : info;
    },
    signal: (pid, signal) => {
      signals.push(`${signal} ${pid}`);
      if (signal === "SIGTERM") termAt = clock;
      else killed = true;
    },
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    log: (line) => lines.push(line),
  };
  return { ports, signals, lines, clock: () => clock };
}

describe("fenceForeignServe", () => {
  it("SIGTERMs a titan-factory serve outside the unit and logs when it exits", async () => {
    const table = fakeTable({ exitsAfterTermMs: 2_000 });

    const result = await fenceForeignServe(table.ports, PORT, SERVICE);

    expect(result).toEqual({ ok: true });
    expect(table.signals).toEqual([`SIGTERM ${FOREIGN}`]);
    expect(table.lines).toEqual([`fenced pid ${FOREIGN} (titan-factory serve outside titan-factory.service, held :7410): SIGTERM, exited after 2 s\n`]);
  });

  it("SIGKILLs a foreign serve that ignores SIGTERM, 15 s after the SIGTERM", async () => {
    const table = fakeTable({});

    const result = await fenceForeignServe(table.ports, PORT, SERVICE);

    expect(result).toEqual({ ok: true });
    expect(table.signals).toEqual([`SIGTERM ${FOREIGN}`, `SIGKILL ${FOREIGN}`]);
    expect(table.lines.join("")).toContain(`fenced pid ${FOREIGN} (titan-factory serve outside titan-factory.service, held :7410): SIGKILL after 15 s`);
    expect(table.clock()).toBeGreaterThanOrEqual(15_000);
  });

  it("refuses a holder that is not titan-factory serve, naming its pid and argv, and signals nothing", async () => {
    const table = fakeTable({ info: { argv: ["python3", "-m", "http.server", "7410"], startedAt: "8800" } });

    const result = await fenceForeignServe(table.ports, PORT, SERVICE);

    expect(result).toEqual({ ok: false, why: `port 7410 is held by pid ${FOREIGN} (python3 -m), which is not titan-factory serve; nothing was signalled` });
    expect(table.signals).toEqual([]);
  });

  it("refuses a listener whose pid this user cannot see, and signals nothing", async () => {
    const table = fakeTable({ listeners: [{}] });

    const result = await fenceForeignServe(table.ports, PORT, SERVICE);

    expect(result).toMatchObject({ ok: false, why: expect.stringContaining("cannot see") });
    expect(table.signals).toEqual([]);
  });

  it("leaves a serve in the unit's own cgroup to systemd", async () => {
    const table = fakeTable({ info: { argv: SERVE_ARGV, cgroupUnit: "titan-factory.service", startedAt: "8800" } });

    expect(await fenceForeignServe(table.ports, PORT, { name: "titan-factory.service" })).toEqual({ ok: true });
    expect(table.signals).toEqual([]);
  });

  it("leaves the launchd job's own pid to launchd", async () => {
    const table = fakeTable({ listeners: [{ pid: 100 }], info: { argv: SERVE_ARGV, startedAt: "8800" } });

    expect(await fenceForeignServe(table.ports, PORT, { name: "com.titan.factory", pid: 100 })).toEqual({ ok: true });
    expect(table.signals).toEqual([]);
  });

  it("re-reads the start time before SIGKILL and sends none when the pid now names another process", async () => {
    const identityReadPlusTermPolls = 1 + 15_000 / 250;
    const table = fakeTable({ reusedAfterReads: identityReadPlusTermPolls });

    const result = await fenceForeignServe(table.ports, PORT, SERVICE);

    expect(result).toEqual({ ok: true });
    expect(table.signals).toEqual([`SIGTERM ${FOREIGN}`]);
    expect(table.lines.join("")).toContain("no SIGKILL was sent");
  });

  it("refuses a serve whose start time is unreadable, since pid reuse cannot be ruled out", async () => {
    const table = fakeTable({ info: { argv: SERVE_ARGV } });

    expect(await fenceForeignServe(table.ports, PORT, SERVICE)).toMatchObject({ ok: false });
    expect(table.signals).toEqual([]);
  });

  it("fails, naming the pid, when a serve survives SIGKILL", async () => {
    const table = fakeTable({ unkillable: true });

    const result = await fenceForeignServe(table.ports, PORT, SERVICE);

    expect(result).toEqual({ ok: false, why: `pid ${FOREIGN} (titan-factory serve) still runs 20 s after SIGTERM, SIGKILL included` });
  });

  it("does nothing when no process listens on the port", async () => {
    const table = fakeTable({ listeners: [] });

    expect(await fenceForeignServe(table.ports, PORT, SERVICE)).toEqual({ ok: true });
    expect(table.signals).toEqual([]);
    expect(table.lines).toEqual([]);
  });

  it("proceeds without signalling, and says so, when the listeners cannot be read", async () => {
    const table = fakeTable({ listeners: undefined });

    expect(await fenceForeignServe(table.ports, PORT, SERVICE)).toEqual({ ok: true });
    expect(table.lines).toEqual(["could not read the listeners on :7410; no foreign serve was fenced\n"]);
  });
});

describe("isFactoryServeArgv", () => {
  it("accepts the deploy checkout's bin, an npm install's bin, and node flags before the script", () => {
    expect(isFactoryServeArgv(SERVE_ARGV)).toBe(true);
    expect(isFactoryServeArgv(["node", "/usr/lib/node_modules/@titan-design/factory/dist/bin.js", "serve"])).toBe(true);
    expect(isFactoryServeArgv(["node", "--enable-source-maps", "/x/products/factory/dist/bin.js", "serve"])).toBe(true);
  });

  it("rejects another factory verb, another script, and a serve with no factory bin", () => {
    expect(isFactoryServeArgv(["node", "/x/products/factory/dist/bin.js", "service", "restart"])).toBe(false);
    expect(isFactoryServeArgv(["node", "/x/products/relay/dist/bin.js", "serve"])).toBe(false);
    expect(isFactoryServeArgv(["/x/products/factory/dist/bin.js", "serve"])).toBe(false);
    expect(isFactoryServeArgv(["MainThread"])).toBe(false);
  });
});
