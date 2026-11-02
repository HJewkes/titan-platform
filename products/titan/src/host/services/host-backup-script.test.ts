import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/host-backup.sh", import.meta.url));
const FIELD = "\u001f";

let root: string;
let home: string;
let bin: string;
let resticLog: string;

function stub(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function writeConfig(lines: string[]): void {
  mkdirSync(join(home, ".config", "titan"), { recursive: true });
  writeFileSync(join(home, ".config", "titan", "backup.env"), `${lines.join("\n")}\n`);
}

const baseConfig = (): string[] => [
  "RESTIC_REPOSITORY=/srv/backups/restic",
  'RESTIC_PASSWORD_FILE="$HOME/.config/restic/repo.pass"',
  'BACKUP_PATHS=("$HOME/projects" "$HOME/Application Support/state")',
  'BACKUP_EXCLUDES=(node_modules "*/dist")',
];

function runScript() {
  return spawnSync("bash", [SCRIPT], { env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
}

const resticCalls = (): string[][] =>
  existsSync(resticLog) ? readFileSync(resticLog, "utf8").trimEnd().split("\n").map((call) => call.split(FIELD)) : [];

const stampPath = () => join(home, ".local", "state", "restic", "last-success-testhost");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-backup-"));
  home = join(root, "home");
  bin = join(root, "bin");
  resticLog = join(root, "restic.log");
  mkdirSync(home);
  mkdirSync(bin);
  stub("hostname", "echo testhost.example.test");
  stub("mountpoint", "exit 1");
  stub(
    "restic",
    `printf '%s' "$RESTIC_REPOSITORY" >> "${resticLog}"
for arg in "$@"; do printf '${FIELD}%s' "$arg" >> "${resticLog}"; done
echo >> "${resticLog}"
[[ "$1" != backup || -z "\${FAIL_BACKUP:-}" ]]`,
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("host-backup.sh", () => {
  it("exits 75 without calling restic when the configured mount is missing", () => {
    writeConfig([...baseConfig(), "BACKUP_MOUNT=/srv/backups"]);

    const result = runScript();

    expect(result.status).toBe(75);
    expect(result.stderr).toContain("/srv/backups is not mounted");
    expect(resticCalls()).toEqual([]);
    expect(existsSync(stampPath())).toBe(false);
  });

  it("backs up every configured path, then prunes, then writes the success stamp", () => {
    writeConfig(baseConfig());

    const result = runScript();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(resticCalls()).toEqual([
      [
        "/srv/backups/restic",
        "backup",
        "--tag",
        "nightly",
        "--exclude",
        "node_modules",
        "--exclude",
        "*/dist",
        join(home, "projects"),
        join(home, "Application Support", "state"),
      ],
      [
        "/srv/backups/restic",
        "forget",
        "--host",
        "testhost.example.test",
        "--tag",
        "nightly",
        "--keep-daily",
        "7",
        "--keep-weekly",
        "4",
        "--keep-monthly",
        "6",
        "--prune",
      ],
    ]);
    expect(readFileSync(stampPath(), "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("leaves no stamp when the backup fails, so a failed night never reads as fresh", () => {
    writeConfig([...baseConfig(), "export FAIL_BACKUP=1"]);

    const result = runScript();

    expect(result.status).not.toBe(0);
    expect(resticCalls().map((call) => call[1])).toEqual(["backup"]);
    expect(existsSync(stampPath())).toBe(false);
  });

  it("refuses to run without a config file", () => {
    const result = runScript();

    expect(result.status).toBe(78);
    expect(resticCalls()).toEqual([]);
  });
});
