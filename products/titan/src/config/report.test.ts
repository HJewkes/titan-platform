import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli.js";
import { buildConfigReport, realReportPorts, reportHostName, type ConfigReport, type ReportedSurface } from "./report.js";

const TOKEN = "synthetic-token-value-0123456789";
const BUDGET_VALUE = "424242";
const AGENT_CHAT_CONFIG = `{"worktreeBudget": ${BUDGET_VALUE}}\n`;

let home: string;

async function put(relative: string, body: string, mode = 0o644): Promise<void> {
  const path = join(home, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
  await chmod(path, mode);
}

function surface(report: ConfigReport, file: string): ReportedSurface | undefined {
  return report.surfaces.find((each) => each.file === file);
}

async function report(): Promise<ConfigReport> {
  return buildConfigReport(realReportPorts, { home, env: {}, platform: "darwin", host: "laptop-a", now: new Date("2026-03-02T12:00:00.000Z") });
}

async function cli(argv: string[], fetchImpl?: typeof fetch): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t), env: {}, home, platform: "darwin", fetch: fetchImpl });
  return { code, out, err };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "titan-config-report-"));
  await put(".agent-chat/config.json", AGENT_CHAT_CONFIG);
  await put(".agent-chat/profiles/implementer.json", '{"model":"sonnet"}\n');
  await put(".agent-chat/ui.token", `${TOKEN}\n`, 0o600);
  await put(".claude-profiles/work/settings.json", "{}\n");
  await put(".claude-profiles/work/.claude.json", `{"oauthAccount":"${TOKEN}"}\n`, 0o600);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("titan config report", () => {
  it("reports a config file by mode, size and digest, and no value it holds", async () => {
    const built = await report();

    expect(surface(built, "~/.agent-chat/config.json")).toMatchObject({
      kind: "agent-chat-config",
      inventory: 7,
      present: true,
      mode: "0644",
      bytes: Buffer.byteLength(AGENT_CHAT_CONFIG),
      sha256: createHash("sha256").update(AGENT_CHAT_CONFIG).digest("hex"),
    });
    expect(JSON.stringify(built)).not.toContain(BUDGET_VALUE);
  });

  it("reports a secret file by presence, mode and mtime alone", async () => {
    const built = await report();

    for (const file of ["~/.agent-chat/ui.token", "~/.claude-profiles/work/.claude.json"]) {
      const row = surface(built, file);
      expect(row).toMatchObject({ present: true, secret: true, mode: "0600" });
      expect(row).not.toHaveProperty("sha256");
      expect(row).not.toHaveProperty("bytes");
    }
    expect(JSON.stringify(built)).not.toContain(TOKEN);
  });

  it("lists every profile and every Claude account, and an absent file as absent", async () => {
    const built = await report();

    expect(surface(built, "~/.agent-chat/profiles/implementer.json")).toMatchObject({ kind: "profile", inventory: 8, present: true });
    expect(surface(built, "~/.claude-profiles/work/settings.json")).toMatchObject({ kind: "claude-settings", present: true });
    expect(surface(built, "~/.config/titan-factory/config.json")).toEqual({ kind: "factory-config", inventory: 19, file: "~/.config/titan-factory/config.json", secret: false, present: false });
  });

  it("prints the report as JSON with --json", async () => {
    const { code, out } = await cli(["config", "report", "--json", "--host", "Laptop-A.local"]);

    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ schema: "titan-config-report/v1", host: "laptop-a", platform: "darwin" });
  });

  it("sends the report to the console's config.report over the bearer in the token file", async () => {
    await put("lan.token", `${TOKEN}\n`, 0o600);
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true, data: { host: "laptop-a", receivedAt: "2026-03-02T12:00:01.000Z" } }));

    const { code, out } = await cli(["config", "report", "--host", "laptop-a", "--to", "https://console.example.test:7501", "--token-file", join(home, "lan.token")], fetchImpl);

    expect(code).toBe(0);
    expect(out).toContain("the console received it at 2026-03-02T12:00:01.000Z");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://console.example.test:7501/rpc/config.report");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(JSON.parse(String(init?.body))).toMatchObject({ host: "laptop-a" });
  });

  it("refuses a plain-http console before anything is sent", async () => {
    await put("lan.token", TOKEN, 0o600);
    const fetchImpl = vi.fn();

    const { code, err } = await cli(["config", "report", "--to", "http://console.example.test:7500", "--token-file", join(home, "lan.token")], fetchImpl);

    expect(code).toBe(70);
    expect(err).toContain("https");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses --to without --token-file", async () => {
    expect((await cli(["config", "report", "--to", "https://console.example.test"])).code).toBe(64);
  });

  it("names the console's refusal", async () => {
    await put("lan.token", TOKEN, 0o600);
    const fetchImpl = vi.fn(async () => Response.json({ ok: false, error: "deposit command refused" }, { status: 403 }));

    const { code, err } = await cli(["config", "report", "--to", "https://console.example.test", "--token-file", join(home, "lan.token")], fetchImpl);

    expect(code).toBe(70);
    expect(err).toContain("config.report refused (HTTP 403): deposit command refused");
  });
});

describe("reportHostName", () => {
  it.each([
    ["Laptop-A.local", "laptop-a"],
    ["box_1", "box-1"],
    ["", "host"],
  ])("turns %j into %j", (raw, name) => {
    expect(reportHostName(raw)).toBe(name);
  });
});
