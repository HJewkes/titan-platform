import { describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { hostDoctorReportSchema } from "./doctor.js";
import type { HostPorts } from "./ports.js";

function ports(missing: string[]): HostPorts {
  return {
    exec: async (command, args) => {
      if (missing.includes(command)) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
      if (args[0] === "--version") return { code: 0, stdout: "1.2.3\n", stderr: "" };
      if (command === "active-work") return { code: 0, stdout: JSON.stringify({ data: { checks: [] } }), stderr: "" };
      return { code: 0, stdout: "fine\n", stderr: "" };
    },
    readFile: async () => '{"version":"1.2.3"}',
    stat: async () => "dir",
    list: async () => ["default"],
    which: async () => null,
  };
}

async function doctor(args: string[], missing: string[] = []) {
  const out: string[] = [];
  const code = await runCli(["host", "doctor", ...args], {
    stdout: (t) => out.push(t),
    stderr: () => undefined,
    env: { TITAN_PROJECTS_ROOT: "/p" },
    home: "/h",
    platform: "linux",
    hostPorts: ports(missing),
  });
  return { code, stdout: out.join("") };
}

describe("titan host doctor", () => {
  it("prints a report matching the schema with ok agreeing with exit 0", async () => {
    const { code, stdout } = await doctor(["--json"]);

    const report = hostDoctorReportSchema.parse(JSON.parse(stdout));
    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.platform).toBe("linux");
    const groups = report.rows.map((row) => row.group);
    expect(groups.slice(0, 12)).toEqual([...Array(3).fill("product"), ...Array(9).fill("cli")]);
    expect(groups.length).toBeGreaterThan(12);
    expect(groups.slice(12).every((group) => group === "inventory")).toBe(true);
  });

  it("exits 1 with ok false when a CLI is missing", async () => {
    const { code, stdout } = await doctor(["--json"], ["gh"]);

    const report = hostDoctorReportSchema.parse(JSON.parse(stdout));
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.rows.find((row) => row.id === "cli:gh")?.status).toBe("missing");
  });

  it("prints one line per row in text mode", async () => {
    const { stdout } = await doctor([], ["gh"]);

    expect(stdout).toMatch(/^missing\s+cli:gh\s+gh is not on PATH$/m);
    expect(stdout).toContain("1 rows failing.");
  });
});
