// TP-814 daemon re-measure. `sample` appends one cost row per systemd user unit in app.slice and one for the
// agent-chat broker; `report` folds 24 h of those rows, a scripts/daemon-remeasure.bt capture and the Mac's
// fs_usage and launchctl readings into one markdown table, so the next audit is one command.
// Memory comes from memory.stat anon and VmRSS, never memory.current, which counts page cache.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COLUMNS = ["ts", "unit", "invocation", "cpu_usec", "anon_bytes", "peak_bytes", "vmrss_kb", "nrestarts"];
export const BROKER_UNIT = "agent-chat-broker";
// The broker runs inside a login session scope rather than a unit, so it is found by command line and keyed by pid.
const BROKER_PATTERN = "node [^ ]*agent-chat/dist/cli.js broker$";
// USER_HZ, the unit of /proc/<pid>/stat utime and stime, is 100 on every Linux ABI.
const USER_HZ = 100;
const NUMERIC = ["cpu_usec", "anon_bytes", "peak_bytes", "vmrss_kb", "nrestarts"];

export function formatSample(row) {
  return COLUMNS.map((c) => row[c] ?? "").join("\t");
}

export function parseSample(line) {
  const cells = line.split("\t");
  const row = Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i] ?? ""]));
  for (const c of NUMERIC) row[c] = row[c] === "" ? null : Number(row[c]);
  return { ...row, ts: Date.parse(row.ts), invocation: row.invocation || null };
}

export function parseSamples(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("ts\t"))
    .map(parseSample);
}

/** `systemctl show` prints one key=value block per unit, separated by a blank line. */
export function parseSystemctlShow(text) {
  const byUnit = new Map();
  for (const block of text.split(/\n\s*\n/)) {
    const props = Object.fromEntries(
      block
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    if (props.Id) byUnit.set(props.Id, props);
  }
  return byUnit;
}

function keyed(text) {
  if (text === null) return {};
  return Object.fromEntries(text.split("\n").map((l) => l.trim().split(/[\s:]+/)));
}

function rssKb(status) {
  const kb = keyed(status).VmRSS;
  return kb === undefined ? "" : kb;
}

function unitRow(ts, unit, shown, io) {
  const dir = path.join(io.appSlice, unit);
  const cpu = keyed(io.read(path.join(dir, "cpu.stat"))).usage_usec;
  if (cpu === undefined) return { ts, unit };
  const props = shown.get(unit) ?? {};
  const pid = Number(props.MainPID ?? 0);
  return {
    ts,
    unit,
    invocation: props.InvocationID ?? "",
    cpu_usec: cpu,
    anon_bytes: keyed(io.read(path.join(dir, "memory.stat"))).anon ?? "",
    peak_bytes: (io.read(path.join(dir, "memory.peak")) ?? "").trim(),
    vmrss_kb: pid > 0 ? rssKb(io.read(`/proc/${pid}/status`)) : "",
    nrestarts: props.NRestarts ?? "",
  };
}

function brokerRow(ts, pid, io) {
  const stat = pid ? io.read(`/proc/${pid}/stat`) : null;
  if (stat === null) return { ts, unit: BROKER_UNIT };
  // Fields after the command's closing paren start at field 3, so utime (14) and stime (15) sit at 11 and 12.
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const status = keyed(io.read(`/proc/${pid}/status`));
  return {
    ts,
    unit: BROKER_UNIT,
    invocation: `pid:${pid}`,
    cpu_usec: ((Number(rest[11]) + Number(rest[12])) * 1e6) / USER_HZ,
    anon_bytes: status.RssAnon === undefined ? "" : Number(status.RssAnon) * 1024,
    vmrss_kb: status.VmRSS ?? "",
  };
}

/** One row per unit (every running app.slice service plus any `expected` one) and one for the broker. */
export function collectSamples(io, { now, expected = [] }) {
  const ts = new Date(now).toISOString();
  const units = [...new Set([...io.listUnits(), ...expected])].sort();
  const shown = parseSystemctlShow(units.length ? io.show(units) : "");
  return [...units.map((u) => unitRow(ts, u, shown, io)), brokerRow(ts, io.brokerPid(), io)];
}

/**
 * CPU sums deltas within each InvocationID; a later invocation's first reading counts whole, because systemd gives
 * a restarted unit a fresh cgroup whose counter starts at zero. The window's first reading is only a baseline.
 */
export function foldUnit(rows) {
  const data = [...rows].sort((a, b) => a.ts - b.ts).filter((r) => r.cpu_usec !== null);
  let cpuUsec = 0;
  let restarts = 0;
  data.forEach((row, i) => {
    const prev = data[i - 1];
    if (prev && prev.invocation === row.invocation) cpuUsec += Math.max(0, row.cpu_usec - prev.cpu_usec);
    else if (prev) [cpuUsec, restarts] = [cpuUsec + row.cpu_usec, restarts + 1];
  });
  // Two restarts between samples show as one InvocationID change; NRestarts still counts automatic ones.
  const nrestarts = data.map((r) => r.nrestarts).filter((n) => n !== null);
  const counted = nrestarts.length ? Math.max(0, nrestarts.at(-1) - nrestarts[0]) : 0;
  const rss = data.map((r) => r.vmrss_kb).filter((n) => n !== null);
  const anon = data.map((r) => r.anon_bytes).filter((n) => n !== null);
  return {
    running: data.length > 0,
    cpuUsec,
    restarts: Math.max(restarts, counted),
    rssMeanKb: rss.length ? rss.reduce((a, b) => a + b, 0) / rss.length : null,
    rssMaxKb: rss.length ? Math.max(...rss) : null,
    anonMaxBytes: anon.length ? Math.max(...anon) : null,
    pids: new Set(data.map((r) => r.invocation?.match(/^pid:(\d+)$/)?.[1]).filter(Boolean)),
  };
}

/** A cgroup path, with or without bpftrace's `unified:` hierarchy prefix, names its unit in the last segment. */
export function cgroupUnit(cgroupPath) {
  return cgroupPath.replace(/^\w+:/, "").split("/").at(-1);
}

function addTo(map, key, n) {
  map.set(key, (map.get(key) ?? 0) + n);
}

/** `cgroup <id> <path>` lines name each cgroup id the capture's maps key on. */
function cgroupPaths(lines) {
  return new Map(
    lines
      .map((l) => l.match(/^cgroup (\d+) (.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
}

/** Folds bpftrace's end-of-run map dump; fs ops are summed across probes per unit. */
export function parseBpftrace(text) {
  const lines = text.split("\n");
  const paths = cgroupPaths(lines);
  const out = {
    forks: new Map(),
    fsops: new Map(),
    forksPid: new Map(),
    fsopsPid: new Map(),
    userUnits: new Set(),
  };
  for (const line of lines) {
    const m = line.match(/^@(forks|fsops|forks_pid|fsops_pid)\[(.*)\]: (\d+)$/);
    if (!m) continue;
    const head = m[2].split(", ")[0];
    const count = Number(m[3]);
    if (m[1].endsWith("_pid")) addTo(m[1] === "forks_pid" ? out.forksPid : out.fsopsPid, Number(head), count);
    else {
      const cgroupPath = paths.get(head) ?? head;
      addTo(out[m[1]], cgroupUnit(cgroupPath), count);
      if (cgroupPath.includes("/user@") && cgroupPath.endsWith(".service")) out.userUnits.add(cgroupUnit(cgroupPath));
    }
  }
  return out;
}

/**
 * `fs_usage -w` ends each line with the elapsed seconds (six decimals, ` W` if it waited) and then
 * `<process name>.<thread id>`; a process name may hold spaces.
 */
export function parseFsUsage(text) {
  const byName = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/\s\d+\.\d{6}(?: W)?\s+(\S.*?)\.\d+\s*$/);
    if (m) addTo(byName, m[1].trim(), 1);
  }
  return byName;
}

/** Reads `runs` and `forks` from each top-level `gui/501/<label> = {` block of `launchctl print`. */
export function parseLaunchctl(text) {
  const byLabel = new Map();
  let label = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^(\S+) = \{$/);
    if (head) label = head[1].split("/").at(-1);
    const field = line.match(/^\t(runs|forks) = (\d+)$/);
    if (label && field)
      byLabel.set(label, {
        ...byLabel.get(label),
        [field[1]]: Number(field[2]),
      });
  }
  return byLabel;
}

function sumPids(byPid, pids) {
  return [...pids].reduce((n, pid) => n + (byPid.get(Number(pid)) ?? 0), 0);
}

function basementRow(unit, rows, trace, ctx) {
  const fold = foldUnit(rows);
  const isBroker = unit === BROKER_UNIT;
  const forks = isBroker ? sumPids(trace.forksPid, fold.pids) : trace.forks.get(unit) ?? 0;
  const fsops = isBroker ? sumPids(trace.fsopsPid, fold.pids) : trace.fsops.get(unit) ?? 0;
  return {
    host: "basement",
    daemon: unit,
    running: rows.length === 0 ? null : fold.running,
    cpuPct: ctx.windowUsec > 0 ? (100 * fold.cpuUsec) / ctx.windowUsec : null,
    rssMeanMb: fold.rssMeanKb === null ? null : fold.rssMeanKb / 1024,
    rssMaxMb: fold.rssMaxKb === null ? null : fold.rssMaxKb / 1024,
    anonMaxMb: fold.anonMaxBytes === null ? null : fold.anonMaxBytes / 2 ** 20,
    forksPerMin: ctx.traced ? forks / ctx.captureMinutes : null,
    fsPerMin: ctx.traced ? fsops / ctx.captureMinutes : null,
    errorsPerDay: errorsPerDay(ctx, unit),
    restarts: fold.running ? fold.restarts : null,
  };
}

function errorsPerDay(ctx, name) {
  const count = ctx.errors.get(name);
  return count === undefined ? null : (count * 86_400_000) / ctx.windowMs;
}

function macRow(label, ctx) {
  const a = ctx.launchA.get(label);
  const b = ctx.launchB.get(label);
  const proc = ctx.macNames.get(label) ?? label;
  return {
    host: "mac",
    daemon: label,
    forksPerMin: a && b && a.forks !== undefined ? (b.forks - a.forks) / ctx.launchctlMinutes : null,
    fsPerMin: ctx.fsUsage.has(proc) ? ctx.fsUsage.get(proc) / ctx.fsUsageMinutes : null,
    errorsPerDay: errorsPerDay(ctx, label),
    restarts: a && b && a.runs !== undefined ? b.runs - a.runs : null,
  };
}

function windowOf(samples) {
  const times = samples.map((r) => r.ts);
  return times.length ? Math.max(...times) - Math.min(...times) : 0;
}

function reportContext(input, samples) {
  const windowMs = windowOf(samples);
  return {
    windowMs: windowMs || 86_400_000,
    windowUsec: windowMs * 1000,
    traced: input.bpftrace !== undefined,
    errors: input.errors ?? new Map(),
    launchA: input.launchctlA ?? new Map(),
    launchB: input.launchctlB ?? new Map(),
    fsUsage: input.fsUsage ?? new Map(),
    macNames: input.macNames ?? new Map(),
    launchctlMinutes: input.launchctlMinutes ?? 10,
    fsUsageMinutes: input.fsUsageMinutes ?? 1,
    // scripts/daemon-remeasure.bt exits after 600 s.
    captureMinutes: input.captureMinutes ?? 10,
  };
}

/** Inputs are parsed already; `errors` maps unit or label to its count over the sample window. */
export function buildRows(input) {
  const samples = input.samples ?? [];
  const trace = input.bpftrace ?? parseBpftrace("");
  const ctx = reportContext(input, samples);
  const units = [...new Set([...samples.map((r) => r.unit), ...trace.userUnits])].sort();
  const macLabels = [...new Set([...ctx.launchA.keys(), ...ctx.macNames.keys()])].sort();
  return [
    ...units.map((u) => basementRow(u, samples.filter((r) => r.unit === u), trace, ctx)),
    ...macLabels.map((label) => macRow(label, ctx)),
  ];
}

function cell(value, digits = 1) {
  return value === null || value === undefined ? "-" : value.toFixed(digits);
}

function cpuCell(row) {
  if (row.running === false) return "not running";
  if (row.running === null) return "not sampled";
  return cell(row.cpuPct, 2);
}

export function renderTable(rows) {
  const lines = [
    "| Host | Daemon | CPU % of a core | RSS MB mean / max | anon MB max | forks/min | fs ops/min | errors/day | restarts |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const rss = r.rssMeanMb === undefined ? "-" : `${cell(r.rssMeanMb, 0)} / ${cell(r.rssMaxMb, 0)}`;
    const cpu = r.host === "mac" ? "-" : cpuCell(r);
    const restarts = r.restarts === null || r.restarts === undefined ? "-" : String(r.restarts);
    lines.push(
      `| ${r.host} | ${r.daemon} | ${cpu} | ${rss} | ${cell(r.anonMaxMb, 0)} | ${cell(r.forksPerMin)} | ` +
        `${cell(r.fsPerMin)} | ${cell(r.errorsPerDay)} | ${restarts} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** `unit<TAB>count` lines. */
export function parseErrors(text) {
  return new Map(
    text
      .split("\n")
      .filter((l) => l.includes("\t"))
      .map((l) => [l.split("\t")[0], Number(l.split("\t")[1])]),
  );
}

function readOrNull(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function brokerPid() {
  try {
    return Number(execFileSync("pgrep", ["-f", BROKER_PATTERN], { encoding: "utf8" }).split("\n")[0]) || null;
  } catch {
    return null;
  }
}

function liveIo() {
  const appSlice = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice`;
  const props = "Id,InvocationID,MainPID,NRestarts";
  return {
    appSlice,
    read: readOrNull,
    listUnits: () => readdirSync(appSlice).filter((name) => name.endsWith(".service")),
    show: (units) => execFileSync("systemctl", ["--user", "show", "-p", props, ...units], { encoding: "utf8" }),
    brokerPid,
  };
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function readFlag(argv, name, parse) {
  const file = flag(argv, name);
  return file === undefined ? undefined : parse(readFileSync(file, "utf8"));
}

function runSample(argv) {
  const out = flag(argv, "--out");
  if (!out) return usage();
  const expected = (flag(argv, "--units") ?? "").split(",").filter(Boolean);
  const rows = collectSamples(liveIo(), { now: Date.now(), expected });
  appendFileSync(out, rows.map((r) => `${formatSample(r)}\n`).join(""));
  return 0;
}

function runReport(argv) {
  const macNames = (flag(argv, "--mac-names") ?? "").split(",").filter(Boolean);
  const rows = buildRows({
    samples: readFlag(argv, "--samples", parseSamples),
    bpftrace: readFlag(argv, "--bpftrace", parseBpftrace),
    fsUsage: readFlag(argv, "--fs-usage", parseFsUsage),
    launchctlA: readFlag(argv, "--launchctl-a", parseLaunchctl),
    launchctlB: readFlag(argv, "--launchctl-b", parseLaunchctl),
    errors: readFlag(argv, "--errors", parseErrors),
    macNames: new Map(macNames.map((pair) => pair.split("="))),
    captureMinutes: optionalNumber(flag(argv, "--capture-minutes")),
  });
  process.stdout.write(renderTable(rows));
  return 0;
}

function optionalNumber(value) {
  return value === undefined ? undefined : Number(value);
}

function usage() {
  console.error(
    "usage: daemon-remeasure.mjs sample --out <tsv> [--units a.service,b.service]\n" +
      "       daemon-remeasure.mjs report [--samples <tsv>] [--bpftrace <txt>] [--fs-usage <txt>]\n" +
      "         [--launchctl-a <txt> --launchctl-b <txt>] [--mac-names label=proc,...] [--errors <tsv>]\n" +
      "         [--capture-minutes <n, default 10>]",
  );
  return 2;
}

/** Returns the exit code. */
export function runCli(argv) {
  if (argv[0] === "sample") return runSample(argv);
  if (argv[0] === "report") return runReport(argv);
  return usage();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
