import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../../cli.js";
import type { HostPorts } from "../ports.js";

const planSchema = z.object({ platform: z.string(), services: z.array(z.object({ id: z.string(), source: z.string() })) });

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function ports(): HostPorts {
  return {
    exec: async () => {
      throw new Error("services must run nothing");
    },
    readFile: async () => "",
    stat: async () => null,
    list: async () => [],
    which: async () => null,
  };
}

async function services(args: string[], platform: NodeJS.Platform = "linux") {
  const home = mkdtempSync(join(tmpdir(), "titan-services-"));
  homes.push(home);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["host", "services", ...args], {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: {},
    home,
    platform,
    titanBin: "/opt/titan/products/titan/dist/bin.js",
    hostPorts: ports(),
  });
  return { code, home, stdout: out.join(""), stderr: err.join("") };
}

describe("titan host services install", () => {
  it("prints both backup units under the user unit dir and the systemctl commands on a dry run", async () => {
    const { code, home, stdout } = await services(["install", "--dry-run"]);

    const unitDir = join(home, ".config", "systemd", "user");
    expect(code).toBe(0);
    expect(stdout).toContain(`dry run: would write ${unitDir}/titan-host-backup.service:\n[Unit]`);
    expect(stdout).toContain(`dry run: would write ${unitDir}/titan-host-backup.timer:\n[Unit]`);
    expect(stdout).toContain("OnCalendar=*-*-* 02:30:00");
    expect(stdout).toContain("  systemctl --user daemon-reload\n  systemctl --user enable --now titan-host-backup.timer\n");
    expect(stdout).toContain("memory-sampler: deferred TP-792");
    expect(readdirSync(home)).toEqual([]);
  });

  it("renders no unit on darwin", async () => {
    const { code, stdout } = await services(["install", "--dry-run"], "darwin");

    expect(code).toBe(0);
    expect(stdout).not.toContain("would write");
    expect(stdout).toContain("backup: deferred TP-1558");
  });

  it("refuses with exit 2 and writes nothing without --dry-run", async () => {
    const { code, home, stdout, stderr } = await services(["install"]);

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/only supports --dry-run/);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("titan host services list", () => {
  it("prints the plan as one JSON object", async () => {
    const { code, stdout } = await services(["list", "--json"]);

    const plan = planSchema.parse(JSON.parse(stdout));
    expect(code).toBe(0);
    expect(plan.platform).toBe("linux");
    expect(plan.services.map((row) => [row.id, row.source])).toEqual([
      ["backup", "render"],
      ["health-sampler", "delegate"],
      ["usage-refresh", "delegate"],
      ["memory-sampler", "deferred"],
    ]);
  });

  it("prints one line per job in text mode", async () => {
    const { stdout } = await services(["list"], "darwin");

    expect(stdout.trim().split("\n")).toHaveLength(4);
    expect(stdout).toMatch(/^usage-refresh\s+chezmoi\s+/m);
  });
});
