// Parsing and aggregation for the per-file resource footprint (TP-4571). Everything here is pure, so the worker setup,
// the tmp watcher and the CLI stay thin and the attribution rules can be tested on synthetic records.
import { basename, relative } from "node:path";

export const FOOTPRINT_DIR_VAR = "TITAN_TEST_FOOTPRINT_DIR";
const TICK_MS = 10;
const TOP = 20;
const SHELLS = new Set(["sh", "bash", "dash", "zsh"]);

/** /proc/<pid>/stat CPU fields in ms. comm may hold spaces and parens, so the fields are counted from its last ")". */
export function parseProcStat(text) {
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
  const ms = (index) => Number(fields[index]) * TICK_MS;
  return { userMs: ms(11), sysMs: ms(12), childUserMs: ms(13), childSysMs: ms(14) };
}

/** Peak RSS in kB from /proc/<pid>/status, or null when the line is absent. */
export function parseVmHwm(text) {
  const match = text.match(/^VmHWM:\s+(\d+) kB$/m);
  return match ? Number(match[1]) : null;
}

/** Inode totals from `df -i <path>` output: the data row is the last line. */
export function parseDfInodes(text) {
  const [, total, used, free, usePercent] = text.trim().split("\n").at(-1).split(/\s+/);
  return { total: Number(total), used: Number(used), free: Number(free), usePercent };
}

/** The name a spawn is counted under: the program, or `sh:<program>` for a shell running one command line. */
export function commandOf(file, args = []) {
  const name = basename(file);
  if (!SHELLS.has(name) || args[1] !== "-c") return name;
  const first = String(args[2] ?? "").trim().split(/\s+/)[0] ?? "";
  return `${name}:${basename(first)}`;
}

/** The per-file tmp dir a watched path sits under, or null for a path in the run root. */
export function fileDirOf(path) {
  return path.match(/(?:^|\/)(f-[^/]+)/)?.[1] ?? null;
}

const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);

// A fork runs one file at a time, so its cutime delta is that file's. Thread files share vitest's process, whose cutime
// also takes each fork's lifetime when it is reaped: take the forks out, and split what remains by child wall time.
function threadChildPoolMs(rows, run) {
  const forkLifetimes = new Map();
  for (const row of rows) {
    if (row.pool === "fork") forkLifetimes.set(row.pid, Math.max(forkLifetimes.get(row.pid) ?? 0, row.processTotalMs));
  }
  return Math.max(0, (run?.main?.childMs ?? 0) - sum([...forkLifetimes.values()], (ms) => ms));
}

export function attributeChildCpu(rows, run) {
  const threads = rows.filter((row) => row.pool === "thread");
  const pool = threadChildPoolMs(rows, run);
  const wall = sum(threads, (row) => row.childWallMs);
  return rows.map((row) => {
    if (row.pool === "fork") return { ...row, childMs: row.childUserMs + row.childSysMs, childEstimated: false };
    return { ...row, childMs: wall > 0 ? (pool * row.childWallMs) / wall : 0, childEstimated: true };
  });
}

// /tmp is flat and shared, so an entry has no owning file: it splits evenly over the files running when it appeared.
function tmpShares(rows, entries) {
  const shares = new Map();
  let unmatched = 0;
  for (const entry of entries) {
    const running = rows.filter((row) => row.startMs <= entry.atMs && entry.atMs <= row.endMs);
    if (running.length === 0) unmatched += entry.weight;
    for (const row of running) shares.set(row, (shares.get(row) ?? 0) + entry.weight / running.length);
  }
  return { shares, unmatched };
}

function joinRow(row, { watch, timingByFile, root, created, left }) {
  const file = relative(root, row.file);
  const seen = watch?.byDir?.[row.tmpDir] ?? { files: 0, dirs: 0 };
  const timing = timingByFile.get(file);
  const leftInTmpdir = row.left.files + row.left.dirs;
  return {
    ...row,
    file,
    project: timing?.project ?? null,
    state: timing?.state ?? null,
    workerSeconds: timing ? timing.totalMs / 1000 : null,
    cpuMs: row.userMs + row.sysMs + row.childMs,
    // The watcher can lose a burst past the inotify queue; what a file left existed, so it counts as created.
    created: Math.max(seen.files + seen.dirs, leftInTmpdir),
    tmpCreatedShare: created.get(row) ?? 0,
    left: leftInTmpdir,
    tmpLeftShare: left.get(row) ?? 0,
    leftTotal: leftInTmpdir + (left.get(row) ?? 0),
  };
}

const topBy = (rows, key, count) => [...rows].sort((a, b) => b[key] - a[key]).slice(0, count);

function summarize(files, run, watch, tmpLeft) {
  const selfMs = sum(files, (row) => row.userMs + row.sysMs);
  const childMs = sum(files, (row) => row.childMs);
  const attributedMs = selfMs + childMs;
  const topCpuMs = sum(topBy(files, "cpuMs", TOP), (row) => row.cpuMs);
  const wholeRunMs = run?.wholeRunMs ?? null;
  return {
    files: files.length,
    selfMs,
    childMs,
    attributedMs,
    wholeRunMs,
    unattributedMs: wholeRunMs === null ? null : Math.max(0, wholeRunMs - attributedMs),
    topCpuMs,
    topCpuShare: attributedMs > 0 ? topCpuMs / attributedMs : 0,
    spawns: sum(files, (row) => row.spawns),
    created: sum(files, (row) => row.created),
    left: sum(files, (row) => row.left),
    tmpCreated: watch?.tmp?.length ?? 0,
    tmpLeft: sum(tmpLeft, (entry) => entry.weight),
  };
}

/** Joins worker rows, the watcher tally, the timing record and the run header into one row per file plus totals. */
export function buildReport({ rows, watch = null, timing = null, run = null, root }) {
  const withChildren = attributeChildCpu(rows, run);
  const tmpLeft = (run?.tmpLeft ?? []).map((entry) => ({ ...entry, weight: entry.files + entry.dirs + 1 }));
  const created = tmpShares(withChildren, (watch?.tmp ?? []).map((entry) => ({ ...entry, weight: 1 })));
  const left = tmpShares(withChildren, tmpLeft);
  const timingByFile = new Map((timing?.files ?? []).map((row) => [row.file, row]));
  const context = { watch, timingByFile, root, created: created.shares, left: left.shares };
  const files = withChildren.map((row) => joinRow(row, context));
  const measured = new Set(files.map((row) => row.file));
  const unmeasured = [...timingByFile.keys()].filter((file) => !measured.has(file));
  return { files, totals: { ...summarize(files, run, watch, tmpLeft), tmpLeftUnmatched: left.unmatched }, unmeasured, run, watch };
}

/** Left /tmp entries grouped by name with the random suffix dropped, so a leaking helper reads as one line. */
export function tmpPrefixes(entries) {
  const groups = new Map();
  for (const { name, files, dirs } of entries) {
    const prefix = name.replace(/[-_.]?[A-Za-z0-9]{6,}$/, "") || "(no prefix)";
    const group = groups.get(prefix) ?? { prefix, entries: 0, paths: 0 };
    group.entries += 1;
    group.paths += files + dirs + 1;
    groups.set(prefix, group);
  }
  return [...groups.values()].sort((a, b) => b.paths - a.paths);
}

const seconds = (ms) => (ms / 1000).toFixed(1);
const percent = (share) => `${(share * 100).toFixed(1)}%`;
const megabytes = (kb) => (kb / 1024).toFixed(0);
const count = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const fixed = (value) => (Number.isInteger(value) ? value : Number(value.toFixed(1)));

/** The spawn counts of a file as `git 12, node 3`, largest first. */
export function topCommands(commands, limit = 3) {
  return Object.entries(commands).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, n]) => `${name} ${n}`).join(", ");
}

const cpuCell = (row) => `${seconds(row.cpuMs)}${row.childEstimated ? "~" : ""}`;
const RANKINGS = [
  ["CPU-s", "cpuMs", ["CPU s", "self s", "child s", "spawns", "pool"], (r) => [cpuCell(r), seconds(r.userMs + r.sysMs), seconds(r.childMs), r.spawns, r.pool]],
  ["processes spawned", "spawns", ["spawns", "child wall s", "commands"], (r) => [r.spawns, seconds(r.childWallMs), topCommands(r.commands)]],
  ["files and dirs left behind", "leftTotal", ["left", "in TMPDIR", "/tmp share"], (r) => [count(r.leftTotal), r.left, count(r.tmpLeftShare)]],
  ["files and dirs created", "created", ["created", "left", "/tmp share"], (r) => [r.created, r.left, count(r.tmpCreatedShare)]],
  ["peak open fds", "peakFds", ["peak fds", "fds at start", "pool"], (r) => [r.peakFds, r.startFds, r.pool]],
  ["peak memory", "memoryPeakKb", ["peak MB", "at start MB", "pool"], (r) => [megabytes(r.memoryPeakKb), megabytes(r.memoryStartKb), r.pool]],
];

function rankingTable(files, [label, key, headers, cells], limit) {
  const rows = topBy(files, key, limit).map((row, index) => `| ${index + 1} | ${row.file} | ${cells(row).join(" | ")} |`);
  return [`## Top ${limit} by ${label}`, "", `| # | file | ${headers.join(" | ")} |`, `|---|---|${headers.map(() => "---").join("|")}|`, ...rows, ""];
}

function totalsLines({ totals: t, unmeasured }) {
  const whole = t.wholeRunMs === null ? "not recorded" : `${seconds(t.wholeRunMs)} s (${seconds(t.unattributedMs)} s outside any file)`;
  return [
    "## Totals",
    "",
    `- Files measured: ${t.files}; in the timing record with no footprint row: ${unmeasured.length}`,
    `- CPU attributed: ${seconds(t.attributedMs)} s (self ${seconds(t.selfMs)}, children ${seconds(t.childMs)}); whole run ${whole}`,
    `- Top ${TOP} files by CPU: ${seconds(t.topCpuMs)} s, ${percent(t.topCpuShare)} of attributed CPU`,
    `- Direct child processes: ${t.spawns}`,
    `- Under TMPDIR: ${t.created} paths created, ${t.left} left when their file ended`,
    `- In /tmp, top level: ${t.tmpCreated} entries created, ${count(t.tmpLeft)} paths left after the run (${count(t.tmpLeftUnmatched)} with no file running)`,
    "",
  ];
}

function tmpPrefixLines(run, limit) {
  const groups = tmpPrefixes(run?.tmpLeft ?? []).slice(0, limit).map((group) => `| ${group.prefix} | ${group.entries} | ${group.paths} |`);
  return ["## /tmp entries left after the run, by name", "", "| prefix | entries | paths |", "|---|---|---|", ...groups, ""];
}

export function renderMarkdown(report, limit = TOP) {
  return [...totalsLines(report), ...RANKINGS.flatMap((ranking) => rankingTable(report.files, ranking, limit)), ...tmpPrefixLines(report.run, limit)].join("\n");
}

const TSV_COLUMNS = ["file", "project", "pool", "state", "workerSeconds", "cpuMs", "userMs", "sysMs", "childMs", "childEstimated", "spawns", "childWallMs", "created", "left", "tmpCreatedShare", "tmpLeftShare", "peakFds", "memoryPeakKb"];

/** Every file, CPU first, one row each, for joins with the timing corpus. */
export function renderTsv(report) {
  const rows = topBy(report.files, "cpuMs", report.files.length).map((row) => TSV_COLUMNS.map((column) => (typeof row[column] === "number" ? fixed(row[column]) : (row[column] ?? ""))).join("\t"));
  return `${[TSV_COLUMNS.join("\t"), ...rows].join("\n")}\n`;
}
