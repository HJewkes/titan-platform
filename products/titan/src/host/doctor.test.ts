import { describe, expect, it } from "vitest";
import { hostDoctor, type HostDoctorRow } from "./doctor.js";
import type { ExecResult, HostPorts } from "./ports.js";

const ROOT = "/srv/checkouts";

const healthyAw = JSON.stringify({ ok: true, data: { ok: true, checks: [{ name: "node", status: "ok", detail: "v24" }] } });

type Script = Record<string, ExecResult | "ENOENT">;

function healthyScript(): Script {
  return {
    "active-work doctor --json": { code: 0, stdout: healthyAw, stderr: "" },
    "agent-chat doctor": { code: 0, stdout: "ok    mirror\n\nNothing broken.\n", stderr: "" },
    "titan-factory service check --json": { code: 0, stdout: '{"ok":true}', stderr: "" },
    "active-work --version": { code: 0, stdout: "0.41.0\n", stderr: "" },
    "agent-chat --version": { code: 0, stdout: "0.1.0\n", stderr: "" },
    "titan-factory --version": { code: 1, stdout: "", stderr: "error: unknown option '--version'\n" },
    "claude --version": { code: 0, stdout: "2.1.296 (Claude Code)\n", stderr: "" },
    "chezmoi --version": { code: 0, stdout: "chezmoi version v2.73.0, commit abc\n", stderr: "" },
    "gh --version": { code: 0, stdout: "gh version 2.102.0 (2026-09-30)\n", stderr: "" },
    "git --version": { code: 0, stdout: "git version 2.53.0\n", stderr: "" },
    "node --version": { code: 0, stdout: "v24.21.0\n", stderr: "" },
    "pnpm --version": { code: 0, stdout: "9.15.0\n", stderr: "" },
  };
}

const files: Record<string, string> = {
  [`${ROOT}/active-work/package.json`]: '{"version":"0.41.0"}',
  [`${ROOT}/agent-chat/package.json`]: '{"version":"0.1.0"}',
  [`${ROOT}/titan-platform/products/factory/package.json`]: '{"version":"0.9.0"}',
  "/opt/factory/package.json": '{"version":"0.9.0"}',
};

function fakePorts(script: Script): HostPorts {
  return {
    exec: async (command, args) => {
      const entry = script[[command, ...args].join(" ")];
      if (entry === "ENOENT" || !entry) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
      return entry;
    },
    readFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    which: async (command) => (command === "titan-factory" ? "/opt/factory/dist/bin.js" : null),
  };
}

async function run(script: Script) {
  const report = await hostDoctor(fakePorts(script), { host: "h", platform: "linux", projectsRoot: ROOT });
  const row = (id: string): HostDoctorRow => {
    const found = report.rows.find((r) => r.id === id);
    if (!found) throw new Error(`no row ${id}`);
    return found;
  };
  return { report, row };
}

describe("titan host doctor rows", () => {
  it("passes a healthy host, reading titan-factory's version beside its linked bin", async () => {
    const { report, row } = await run(healthyScript());

    expect(report.ok).toBe(true);
    expect(report.rows.every((r) => r.status === "ok")).toBe(true);
    expect(row("cli:titan-factory")).toMatchObject({ version: "0.9.0", expected: "0.9.0" });
    expect(row("cli:chezmoi").version).toBe("2.73.0");
  });

  it("reports a CLI that is not on PATH as missing and fails the report", async () => {
    const script = { ...healthyScript(), "agent-chat doctor": "ENOENT", "agent-chat --version": "ENOENT" } as Script;

    const { report, row } = await run(script);

    expect(row("doctor:agent-chat").status).toBe("missing");
    expect(row("cli:agent-chat")).toMatchObject({ status: "missing", detail: "agent-chat is not on PATH" });
    expect(report.ok).toBe(false);
  });

  it("warns on a linked CLI whose version differs from its checkout, without failing", async () => {
    const script = { ...healthyScript(), "active-work --version": { code: 0, stdout: "0.40.0\n", stderr: "" } };

    const { report, row } = await run(script);

    expect(row("cli:active-work")).toMatchObject({
      status: "warn",
      version: "0.40.0",
      expected: "0.41.0",
      detail: "version mismatch: linked 0.40.0, checkout 0.41.0",
    });
    expect(report.ok).toBe(true);
  });

  it("fails the factory row with the cause its service check names", async () => {
    const stdout = JSON.stringify({ ok: false, cause: "stale build", message: "run titan-factory service restart" });
    const script = { ...healthyScript(), "titan-factory service check --json": { code: 1, stdout, stderr: "" } };

    const { report, row } = await run(script);

    expect(row("doctor:titan-factory")).toMatchObject({ status: "fail", detail: "stale build: run titan-factory service restart" });
    expect(report.ok).toBe(false);
  });

  it("names the failing active-work checks and carries warnings as warn", async () => {
    const checks = [
      { name: "daemon", status: "fail", detail: "not running" },
      { name: "skill", status: "warn", detail: "absent" },
    ];
    const failing = { code: 1, stdout: JSON.stringify({ ok: false, data: { ok: false, checks } }), stderr: "" };
    const warning = { code: 0, stdout: JSON.stringify({ ok: true, data: { ok: true, checks: checks.slice(1) } }), stderr: "" };

    const failed = await run({ ...healthyScript(), "active-work doctor --json": failing });
    const warned = await run({ ...healthyScript(), "active-work doctor --json": warning });

    expect(failed.row("doctor:active-work")).toMatchObject({ status: "fail", detail: "daemon: not running" });
    expect(warned.row("doctor:active-work")).toMatchObject({ status: "warn", detail: "1 checks, warn: skill" });
  });

  it("fails agent-chat on a non-zero exit with its last line", async () => {
    const script = { ...healthyScript(), "agent-chat doctor": { code: 1, stdout: "fail  broker  not running\n", stderr: "" } };

    const { row } = await run(script);

    expect(row("doctor:agent-chat")).toMatchObject({ status: "fail", detail: "fail  broker  not running" });
  });
});
