import { describe, expect, it } from "vitest";
import {
  attributeChildCpu, buildReport, commandOf, fileDirOf, parseDfInodes, parseProcStat, parseVmHwm, renderMarkdown, renderTsv, tmpPrefixes, topCommands,
} from "./test-footprint-core.mjs";

const ROOT = "/repo";

function row(overrides = {}) {
  return {
    file: `${ROOT}/a.test.ts`, pid: 1, threadId: 1, pool: "thread", startMs: 0, endMs: 100, wallMs: 100, userMs: 0, sysMs: 0, childUserMs: 0, childSysMs: 0,
    processTotalMs: 0, spawns: 0, commands: {}, childWallMs: 0, peakFds: 10, startFds: 8, peakRssKb: 1024, memoryPeakKb: 2048, memoryStartKb: 1024,
    tmpDir: "f-a", left: { files: 0, dirs: 0 }, ...overrides,
  };
}

const byFile = (report) => Object.fromEntries(report.files.map((file) => [file.file, file]));

describe("/proc and df parsing", () => {
  it("reads the CPU fields of a stat line whose comm holds spaces and parens", () => {
    const line = "42 (Worker (a) b) R 1 1 1 0 -1 4194368 28 0 0 0 150 25 7 3 20 0 12 0 99 1 1\n";

    expect(parseProcStat(line)).toEqual({ userMs: 1500, sysMs: 250, childUserMs: 70, childSysMs: 30 });
  });

  it("reads VmHWM and says so when the line is absent", () => {
    expect(parseVmHwm("Name:\tnode\nVmHWM:\t  12345 kB\nVmRSS:\t 100 kB\n")).toBe(12345);
    expect(parseVmHwm("Name:\tnode\n")).toBeNull();
  });

  it("reads the data row of df -i", () => {
    const output = "Filesystem      Inodes  IUsed   IFree IUse% Mounted on\ntmpfs          1048576 363999 684577   35% /tmp\n";

    expect(parseDfInodes(output)).toEqual({ total: 1048576, used: 363999, free: 684577, usePercent: "35%" });
  });
});

describe("spawn names", () => {
  it("counts a program under its base name", () => {
    expect(commandOf("/usr/bin/git", ["git", "init"])).toBe("git");
  });

  it("names the program a shell was asked to run", () => {
    expect(commandOf("/bin/sh", ["/bin/sh", "-c", "git status --short"])).toBe("sh:git");
  });

  it("leaves a shell running a script file as the shell", () => {
    expect(commandOf("bash", ["bash", "hook.sh"])).toBe("bash");
  });

  it("lists a file's commands largest first, up to the limit", () => {
    expect(topCommands({ node: 1, git: 12, sh: 3, tar: 2 }, 2)).toBe("git 12, sh 3");
  });
});

describe("the per-file tmp dir of a path", () => {
  it("finds the f- dir anywhere above the path", () => {
    expect(fileDirOf("/base/vt-run-1/f-abc123/repo/.git/HEAD")).toBe("f-abc123");
  });

  it("gives null for a path in the run root", () => {
    expect(fileDirOf("/base/vt-run-1/stray.txt")).toBeNull();
  });
});

describe("child CPU attribution", () => {
  it("takes a fork file's children from its own delta", () => {
    const [fork] = attributeChildCpu([row({ pool: "fork", childUserMs: 300, childSysMs: 50 })], null);

    expect(fork).toMatchObject({ childMs: 350, childEstimated: false });
  });

  it("splits thread children by child wall time after taking out each fork's whole lifetime", () => {
    const rows = [
      row({ pool: "fork", pid: 2, processTotalMs: 1000 }),
      row({ pool: "fork", pid: 2, processTotalMs: 2500 }),
      row({ pool: "thread", file: "one", childWallMs: 300 }),
      row({ pool: "thread", file: "two", childWallMs: 100 }),
    ];

    const [, , one, two] = attributeChildCpu(rows, { main: { childMs: 4500 } });

    expect(one).toMatchObject({ childMs: 1500, childEstimated: true });
    expect(two.childMs).toBe(500);
  });

  it("attributes nothing to threads when the forks account for all of it", () => {
    const [thread] = attributeChildCpu([row({ childWallMs: 10 }), row({ pool: "fork", processTotalMs: 900 })], { main: { childMs: 500 } });

    expect(thread.childMs).toBe(0);
  });
});

describe("the joined report", () => {
  it("adds self and child CPU and takes the project from the timing record", () => {
    const rows = [row({ pool: "fork", userMs: 100, sysMs: 20, childUserMs: 5, childSysMs: 5 })];
    const timing = { files: [{ file: "a.test.ts", project: "repo", state: "passed", totalMs: 1500 }] };

    const { files } = buildReport({ rows, timing, root: ROOT });

    expect(files[0]).toMatchObject({ file: "a.test.ts", project: "repo", state: "passed", workerSeconds: 1.5, cpuMs: 130 });
  });

  it("reports a timed file that produced no row", () => {
    const report = buildReport({ rows: [], timing: { files: [{ file: "broken.test.ts", totalMs: 1 }] }, root: ROOT });

    expect(report.unmeasured).toEqual(["broken.test.ts"]);
  });

  it("takes created paths from the watcher and left paths from the file's own count", () => {
    const rows = [row({ left: { files: 2, dirs: 1 } })];

    const [file] = buildReport({ rows, watch: { byDir: { "f-a": { files: 40, dirs: 2 } }, tmp: [] }, root: ROOT }).files;

    expect(file).toMatchObject({ created: 42, left: 3, leftTotal: 3 });
  });

  it("never reports fewer created than left when the watcher lost events", () => {
    const [file] = buildReport({ rows: [row({ left: { files: 5, dirs: 0 } })], watch: { byDir: {}, tmp: [] }, root: ROOT }).files;

    expect(file.created).toBe(5);
  });

  it("splits a /tmp entry evenly over the files running when it appeared", () => {
    const rows = [row({ file: `${ROOT}/one`, startMs: 0, endMs: 100 }), row({ file: `${ROOT}/two`, startMs: 50, endMs: 150 }), row({ file: `${ROOT}/late`, startMs: 200, endMs: 300 })];
    const run = { tmpLeft: [{ name: "leak-abcdef", atMs: 60, files: 2, dirs: 0 }] };

    const files = byFile(buildReport({ rows, run, root: ROOT }));

    expect(files.one.tmpLeftShare).toBe(1.5);
    expect(files.two.leftTotal).toBe(1.5);
    expect(files.late.leftTotal).toBe(0);
  });

  it("counts a /tmp entry that appeared between files as unmatched", () => {
    const report = buildReport({ rows: [row()], run: { tmpLeft: [{ name: "x", atMs: 500, files: 0, dirs: 0 }] }, root: ROOT });

    expect(report.totals.tmpLeftUnmatched).toBe(1);
    expect(report.totals.tmpLeft).toBe(1);
  });

  it("totals CPU, the top-20 share and what ran outside any file", () => {
    const rows = Array.from({ length: 21 }, (_, index) => row({ file: `${ROOT}/${index}`, pool: "fork", pid: index, userMs: index === 20 ? 790 : 10 }));

    const { totals } = buildReport({ rows, run: { wholeRunMs: 1500 }, root: ROOT });

    expect(totals).toMatchObject({ files: 21, attributedMs: 990, unattributedMs: 510, topCpuMs: 980 });
    expect(totals.topCpuShare).toBeCloseTo(980 / 990);
  });
});

describe("rendering", () => {
  const rows = [
    row({ file: `${ROOT}/small`, userMs: 100, spawns: 1, commands: { git: 1 }, tmpDir: "f-s" }),
    row({ file: `${ROOT}/big`, userMs: 9000, spawns: 500, commands: { git: 490, node: 10 }, tmpDir: "f-b", left: { files: 30, dirs: 4 } }),
  ];
  const report = buildReport({ rows, watch: { byDir: { "f-b": { files: 900, dirs: 10 } }, tmp: [] }, root: ROOT });

  it("ranks the heaviest file first in each table and marks an estimated CPU figure", () => {
    const markdown = renderMarkdown(report);

    expect(markdown).toContain("| 1 | big | 9.0~ | 9.0 | 0.0 | 500 | thread |");
    expect(markdown).toContain("| 1 | big | 500 | 0.0 | git 490, node 10 |");
    expect(markdown).toContain("| 1 | big | 910 | 34 | 0 |");
  });

  it("writes every file to the tsv, CPU first", () => {
    const lines = renderTsv(report).trim().split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[1].startsWith("big\t")).toBe(true);
    expect(lines[2].startsWith("small\t")).toBe(true);
  });

  it("groups left /tmp entries whatever their random suffix", () => {
    const entries = [{ name: "fix-proof-a1B2c3", files: 3, dirs: 1 }, { name: "fix-proof-z9Y8x7", files: 0, dirs: 0 }, { name: "other.sock", files: 0, dirs: 0 }];

    expect(tmpPrefixes(entries)[0]).toEqual({ prefix: "fix-proof", entries: 2, paths: 6 });
  });
});
