import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";

const SERVICE = "titan-health-sample.service";
const TIMER = "titan-health-sample.timer";

// The stub only appends its argv; PATH holds nothing else, so no real systemctl can run.
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ -n "$SYSTEMCTL_FAIL" ]; then
  case "$*" in *"$SYSTEMCTL_FAIL"*) echo "stub refused $SYSTEMCTL_FAIL" >&2; exit 1 ;; esac
fi
`;

let dir: string;
let home: string;
let stubDir: string;
let log: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "titan-health-install-"));
  home = join(dir, "home");
  stubDir = join(dir, "stub");
  log = join(dir, "systemctl.log");
  await mkdir(home);
  await mkdir(stubDir);
  await writeFile(join(stubDir, "systemctl"), STUB);
  await chmod(join(stubDir, "systemctl"), 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function titan(args: string[], options: { platform?: NodeJS.Platform; fail?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { PATH: stubDir, SYSTEMCTL_LOG: log, ...(options.fail ? { SYSTEMCTL_FAIL: options.fail } : {}) };
  const code = await runCli(["health", ...args], {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env,
    home,
    platform: options.platform ?? "linux",
    titanBin: join(dir, "titan", "dist", "bin.js"),
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

const unitDir = () => join(home, ".config", "systemd", "user");
const unitText = (name: string) => readFile(join(unitDir(), name), "utf8");
const systemctlCalls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n") : []);

describe("titan health install", () => {
  it("writes both units, then reloads systemd before enabling the timer", async () => {
    const result = await titan(["install"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(await unitText(SERVICE)).toContain(`ExecStart=${process.execPath} ${join(dir, "titan", "dist", "bin.js")} health sample`);
    expect(await unitText(SERVICE)).toContain(`StandardError=append:${join(home, ".local", "state", "titan", "health-sample.err.log")}`);
    expect(await unitText(TIMER)).toContain("OnCalendar=*-*-* *:*:00");
    expect(await systemctlCalls()).toEqual(["--user daemon-reload", `--user enable --now ${TIMER}`]);
  });

  it("creates the stderr log's directory so systemd can open it", async () => {
    await titan(["install"]);

    expect(existsSync(join(home, ".local", "state", "titan"))).toBe(true);
  });

  it("leaves both unit files unchanged when run a second time", async () => {
    await titan(["install"]);
    const first = [await unitText(SERVICE), await unitText(TIMER)];

    const again = await titan(["install"]);

    expect(again.code).toBe(0);
    expect([await unitText(SERVICE), await unitText(TIMER)]).toEqual(first);
  });

  it("prints both units and the commands on --dry-run, and writes and runs nothing", async () => {
    const result = await titan(["install", "--dry-run"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Type=oneshot");
    expect(result.stdout).toContain("AccuracySec=1s");
    expect(result.stdout).toContain(`systemctl --user enable --now ${TIMER}`);
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(await systemctlCalls()).toEqual([]);
  });

  it("exits 1 with systemctl's reason when enabling the timer fails", async () => {
    const result = await titan(["install"], { fail: "enable" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stub refused enable");
  });

  it.each(["darwin", "win32"] as const)("exits 2 on %s and writes nothing", async (platform) => {
    const result = await titan(["install"], { platform });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`not supported on ${platform}; see TP-1556`);
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(existsSync(join(home, ".local"))).toBe(false);
    expect(await systemctlCalls()).toEqual([]);
  });
});

describe("titan health uninstall", () => {
  it("disables the timer, removes both units, then reloads systemd", async () => {
    await titan(["install"]);
    await rm(log);

    const result = await titan(["uninstall"]);

    expect(result.code).toBe(0);
    expect(existsSync(join(unitDir(), SERVICE))).toBe(false);
    expect(existsSync(join(unitDir(), TIMER))).toBe(false);
    expect(await systemctlCalls()).toEqual([`--user disable --now ${TIMER}`, "--user daemon-reload"]);
  });

  it("succeeds without calling systemctl when nothing is installed", async () => {
    const result = await titan(["uninstall"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("not installed");
    expect(await systemctlCalls()).toEqual([]);
  });

  it("keeps the units when disabling the timer fails", async () => {
    await titan(["install"]);

    const result = await titan(["uninstall"], { fail: "disable" });

    expect(result.code).toBe(1);
    expect(existsSync(join(unitDir(), TIMER))).toBe(true);
  });

  it("exits 2 on darwin and touches nothing", async () => {
    const result = await titan(["uninstall"], { platform: "darwin" });

    expect(result.code).toBe(2);
    expect(await systemctlCalls()).toEqual([]);
  });
});
