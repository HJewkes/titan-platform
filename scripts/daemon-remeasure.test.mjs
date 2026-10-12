import { describe, expect, it } from "vitest";
import {
  BROKER_UNIT,
  buildRows,
  collectSamples,
  foldUnit,
  formatSample,
  parseBpftrace,
  parseFsUsage,
  parseLaunchctl,
  parseSamples,
  renderTable,
} from "./daemon-remeasure.mjs";

const APP = "/cg/app.slice";
const USER_CG = "unified:/user.slice/user-1000.slice/user@1000.service";

function tsv(rows) {
  return rows.map((r) => r.join("\t")).join("\n");
}

function fakeIo(files, { units = [], show = "", brokerPid = null } = {}) {
  return {
    appSlice: APP,
    read: (file) => files[file] ?? null,
    listUnits: () => units,
    show: () => show,
    brokerPid: () => brokerPid,
  };
}

function rowFor(rows, daemon) {
  return rows.find((r) => r.daemon === daemon);
}

describe("daemon-remeasure report fold", () => {
  it("a unit that restarted mid-window sums both invocations' CPU and never goes negative", () => {
    const samples = parseSamples(
      tsv([
        ["2026-10-12T08:00:00Z", "titan-factory.service", "A", "1000000", "", "", "1000", "0"],
        ["2026-10-12T08:05:00Z", "titan-factory.service", "A", "4000000", "", "", "1000", "0"],
        ["2026-10-12T08:10:00Z", "titan-factory.service", "B", "500000", "", "", "1000", "0"],
        ["2026-10-12T08:15:00Z", "titan-factory.service", "B", "1500000", "", "", "1000", "0"],
      ]),
    );

    const fold = foldUnit(samples);
    const [row] = buildRows({ samples });

    expect(fold.cpuUsec).toBe(3_000_000 + 500_000 + 1_000_000);
    expect(fold.restarts).toBe(1);
    expect(row.cpuPct).toBeCloseTo((100 * 4.5) / (15 * 60));
  });

  it("a missing unit yields an empty row and the report shows it as not running", () => {
    const files = {
      [`${APP}/active-work.service/cpu.stat`]: "usage_usec 10\n",
    };
    const io = fakeIo(files, {
      units: ["active-work.service"],
      show: "Id=active-work.service\nInvocationID=X\n",
    });

    const rows = collectSamples(io, {
      now: Date.parse("2026-10-12T08:00:00Z"),
      expected: ["gone.service"],
    });
    const line = formatSample(rows.find((r) => r.unit === "gone.service"));
    const table = renderTable(buildRows({ samples: parseSamples(rows.map(formatSample).join("\n")) }));

    expect(line).toBe("2026-10-12T08:00:00.000Z\tgone.service\t\t\t\t\t\t");
    expect(table).toMatch(/\| basement \| gone\.service \| not running \|/);
  });

  it("forks per minute divides the 600 s capture by 10 and maps cgroup paths to unit names", () => {
    const capture = [
      `cgroup 4242 ${USER_CG}/app.slice/active-work.service`,
      "@forks[4242]: 120",
      `@fsops[4242, tracepoint:syscalls:sys_enter_openat]: 300`,
      `@fsops[4242, kprobe:vfs_read]: 200`,
      `@forks[${USER_CG}/app.slice/titan-factory.service]: 380`,
    ].join("\n");
    const samples = parseSamples(
      tsv([
        ["2026-10-12T08:00:00Z", "active-work.service", "A", "0", "", "", "", "0"],
        ["2026-10-12T08:05:00Z", "titan-factory.service", "F", "0", "", "", "", "0"],
      ]),
    );

    const rows = buildRows({ samples, bpftrace: parseBpftrace(capture) });

    expect(rowFor(rows, "active-work.service")).toMatchObject({
      forksPerMin: 12,
      fsPerMin: 50,
    });
    expect(rowFor(rows, "titan-factory.service").forksPerMin).toBe(38);
  });

  it("a oneshot user service seen only in the capture still gets a row", () => {
    const capture = [`cgroup 9 ${USER_CG}/app.slice/agent-chat-burndown.service`, "@forks[9]: 30"].join("\n");

    const rows = buildRows({ samples: [], bpftrace: parseBpftrace(capture) });

    expect(rowFor(rows, "agent-chat-burndown.service")).toMatchObject({
      running: null,
      forksPerMin: 3,
    });
    expect(renderTable(rows)).toMatch(/agent-chat-burndown\.service \| not sampled \|/);
  });

  it("the broker is joined by pid, not cgroup", () => {
    const capture = [
      `cgroup 77 ${USER_CG}/session-11.scope`,
      "@forks[77]: 900",
      "@forks_pid[1759454, node]: 40",
      "@forks_pid[1759454, libuv-worker]: 10",
      "@forks_pid[555, tmux]: 800",
      "@fsops_pid[1759454, node]: 70",
    ].join("\n");
    const samples = parseSamples(tsv([["2026-10-12T08:00:00Z", BROKER_UNIT, "pid:1759454", "5", "", "", "2048", ""]]));

    const rows = buildRows({ samples, bpftrace: parseBpftrace(capture) });

    expect(rowFor(rows, BROKER_UNIT)).toMatchObject({
      forksPerMin: 5,
      fsPerMin: 7,
    });
    expect(rowFor(rows, "session-11.scope")).toBeUndefined();
  });

  it("the broker row reads cpu and rss from /proc by pid", () => {
    const files = {
      "/proc/31/stat": "31 (node cli) S 1 31 31 0 -1 4194560 1 0 0 0 250 50 0 0 20 0 11 0",
      "/proc/31/status": "Name:\tnode\nVmRSS:\t  4096 kB\nRssAnon:\t  1024 kB\n",
    };

    const [row] = collectSamples(fakeIo(files, { brokerPid: 31 }), { now: 0 });

    expect(row).toMatchObject({
      unit: BROKER_UNIT,
      invocation: "pid:31",
      cpu_usec: 3_000_000,
      vmrss_kb: "4096",
    });
    expect(row.anon_bytes).toBe(1024 * 1024);
  });
});

describe("daemon-remeasure Mac rows", () => {
  it("fs_usage lines aggregate per process name", () => {
    const capture = [
      "14:22:33.123456  open              F=5       (R___________)  /var/relay/state.json      0.000012   relay-daemon.1201",
      "14:22:33.223456  stat64                                      /var/relay                 0.000004   relay-daemon.1777",
      "14:22:34.000001  read              F=7    B=0x200                                           0.000020 W hermes gateway.88",
    ].join("\n");

    const byName = parseFsUsage(capture);

    expect(Object.fromEntries(byName)).toEqual({
      "relay-daemon": 2,
      "hermes gateway": 1,
    });
  });

  it("launchctl runs and forks are deltas between the two readings", () => {
    const reading = (runs, forks) =>
      [
        "gui/501/com.relay.daemon = {",
        `\truns = ${runs}`,
        `\tforks = ${forks}`,
        "\tendpoints = {",
        "\t\truns = 999",
        "\t}",
        "}",
      ].join("\n");

    const rows = buildRows({
      launchctlA: parseLaunchctl(reading(10, 100)),
      launchctlB: parseLaunchctl(reading(12, 160)),
      fsUsage: parseFsUsage("14:22:33.1  open  /x  0.000012   relay-daemon.1201"),
      macNames: new Map([["com.relay.daemon", "relay-daemon"]]),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        host: "mac",
        daemon: "com.relay.daemon",
        restarts: 2,
        forksPerMin: 6,
        fsPerMin: 1,
      }),
    ]);
  });
});
