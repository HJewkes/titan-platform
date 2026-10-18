/**
 * `titan config report`: this host's config files as facts (present, mode, size, mtime, digest),
 * never their values, so a report sent to the console cannot carry a secret a file holds. A
 * secret file is not even opened: it is reported by presence, mode and mtime alone.
 *
 * `--to` sends the report to the console's `config.report` deposit over the LAN listener's
 * bearer. The console only stores and shows it; nothing in a report is ever applied.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join, relative, sep } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { CLIENT_HEADER } from "@titan-design/daemon";

const CONFIG_REPORT_SCHEMA = "titan-config-report/v1";

export interface ReportedSurface {
  kind: string;
  inventory: number;
  file: string;
  present: boolean;
  secret: boolean;
  mode?: string;
  bytes?: number;
  mtime?: string;
  sha256?: string;
}

export interface ConfigReport {
  schema: typeof CONFIG_REPORT_SCHEMA;
  host: string;
  platform: string;
  reportedAt: string;
  surfaces: ReportedSurface[];
}

interface FileFacts {
  isFile: boolean;
  mode: number;
  size: number;
  mtimeMs: number;
}

/** Every file touch the report makes; tests inject fakes. */
export interface ReportPorts {
  /** Symlinks followed; null when nothing is there. */
  stat(path: string): Promise<FileFacts | null>;
  readBytes(path: string): Promise<Buffer>;
  /** Entry names, or none when the directory cannot be listed. */
  list(dir: string): Promise<string[]>;
}

export const realReportPorts: ReportPorts = {
  stat: async (path) => {
    const facts = await stat(path).catch(() => null);
    return facts === null ? null : { isFile: facts.isFile(), mode: facts.mode, size: facts.size, mtimeMs: facts.mtimeMs };
  },
  readBytes: (path) => readFile(path),
  list: (dir) => readdir(dir).catch(() => []),
};

interface Target {
  kind: string;
  inventory: number;
  path: string;
  secret: boolean;
}

interface Roots {
  home: string;
  agentChatDir: string;
  configHome: string;
}

const target = (kind: string, inventory: number, path: string, secret = false): Target => ({ kind, inventory, path, secret });

/** The TP-3579 inventory rows that live on every host; the leak-guard term list is never named. */
function fixedTargets({ agentChatDir, configHome, home }: Roots): Target[] {
  return [
    target("agent-chat-config", 7, join(agentChatDir, "config.json")),
    target("burndown-config", 9, join(agentChatDir, "burndown.config.json")),
    target("seat-watchdog", 10, join(agentChatDir, "seat-watchdog.json")),
    target("agent-chat-hooks", 11, join(agentChatDir, "hooks.json")),
    target("agent-chat-ui-token", 13, join(agentChatDir, "ui.token"), true),
    target("factory-config", 19, join(configHome, "titan-factory", "config.json")),
    ...claudeTargets(join(home, ".claude")),
  ];
}

const claudeTargets = (dir: string): Target[] => [target("claude-settings", 14, join(dir, "settings.json")), target("claude-json", 15, join(dir, ".claude.json"), true)];

async function listedTargets(roots: Roots, ports: ReportPorts): Promise<Target[]> {
  const profilesDir = join(roots.agentChatDir, "profiles");
  const profiles = (await ports.list(profilesDir)).filter((name) => name.endsWith(".json")).sort();
  const accountsDir = join(roots.home, ".claude-profiles");
  const accounts = await Promise.all((await ports.list(accountsDir)).sort().map(async (name) => ((await ports.stat(join(accountsDir, name)))?.isFile === false ? name : null)));
  return [
    ...profiles.map((name) => target("profile", 8, join(profilesDir, name))),
    ...accounts.flatMap((name) => (name === null ? [] : claudeTargets(join(accountsDir, name)))),
  ];
}

const octal = (mode: number): string => `0${(mode & 0o777).toString(8).padStart(3, "0")}`;

/** `~`-relative under home, so two hosts' rows for one surface compare by name. */
function shownPath(path: string, home: string): string {
  const under = relative(home, path);
  return under === "" || under.startsWith("..") || under.startsWith(sep) ? path : `~/${under.split(sep).join("/")}`;
}

async function surfaceOf(each: Target, ports: ReportPorts, home: string): Promise<ReportedSurface> {
  const base = { kind: each.kind, inventory: each.inventory, file: shownPath(each.path, home), secret: each.secret };
  const facts = await ports.stat(each.path);
  if (facts === null || !facts.isFile) return { ...base, present: false };
  const known = { ...base, present: true, mode: octal(facts.mode), mtime: new Date(facts.mtimeMs).toISOString() };
  if (each.secret) return known;
  const sha256 = createHash("sha256").update(await ports.readBytes(each.path)).digest("hex");
  return { ...known, bytes: facts.size, sha256 };
}

/** The short host name, lowercased to what the console's report schema takes. */
export function reportHostName(raw: string): string {
  const short = raw.split(".")[0]?.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "") ?? "";
  return short.slice(0, 63) || "host";
}

interface ReportOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: string;
  host: string;
  now: Date;
}

export async function buildConfigReport(ports: ReportPorts, options: ReportOptions): Promise<ConfigReport> {
  const roots: Roots = {
    home: options.home,
    agentChatDir: options.env.AGENT_CHAT_HOME ?? join(options.home, ".agent-chat"),
    configHome: options.env.XDG_CONFIG_HOME ?? join(options.home, ".config"),
  };
  const targets = [...fixedTargets(roots), ...(await listedTargets(roots, ports))];
  const surfaces = await Promise.all(targets.map((each) => surfaceOf(each, ports, options.home)));
  return { schema: CONFIG_REPORT_SCHEMA, host: options.host, platform: options.platform, reportedAt: options.now.toISOString(), surfaces };
}

const replyEnvelope = z.object({ ok: z.boolean(), data: z.object({ receivedAt: z.string() }).optional(), error: z.string().optional() });

/** HTTPS only, and a redirect is refused, so the bearer never crosses the network in the clear or to a second address. */
async function sendReport(report: ConfigReport, to: string, token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const origin = new URL(to);
  if (origin.protocol !== "https:") throw new Error(`--to must be an https URL: the console's LAN listener serves HTTPS only`);
  const response = await fetchImpl(new URL("/rpc/config.report", origin), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, [CLIENT_HEADER]: "titan config report" },
    body: JSON.stringify(report),
    redirect: "error",
  });
  const envelope = replyEnvelope.safeParse(await response.json().catch(() => null));
  if (envelope.success && envelope.data.ok) return envelope.data.data?.receivedAt ?? "";
  throw new Error(`config.report refused (HTTP ${response.status}): ${(envelope.success ? envelope.data.error : undefined) ?? "no envelope in the reply"}`);
}

function renderReport(report: ConfigReport): string {
  const lines = report.surfaces.map((each) => `${(each.present ? "present" : "absent").padEnd(8)} ${(each.mode ?? "").padEnd(5)} ${each.file} (${each.kind})`);
  return `${report.host} ${report.platform} at ${report.reportedAt}\n${lines.join("\n")}\n`;
}

interface ConfigIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  setExitCode: (code: number) => void;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  reportPorts?: ReportPorts;
  fetch?: typeof fetch;
}

interface ReportFlags {
  json?: boolean;
  host?: string;
  to?: string;
  tokenFile?: string;
}

async function runReport(io: ConfigIo, flags: ReportFlags): Promise<void> {
  if (flags.to !== undefined && flags.tokenFile === undefined) {
    io.stderr("titan config report: --to needs --token-file, the console's LAN token\n");
    io.setExitCode(64);
    return;
  }
  const ports = io.reportPorts ?? realReportPorts;
  const host = reportHostName(flags.host ?? hostname());
  const report = await buildConfigReport(ports, { home: io.home, env: io.env, platform: io.platform, host, now: new Date() });
  if (flags.to === undefined || flags.tokenFile === undefined) return io.stdout(flags.json ? `${JSON.stringify(report)}\n` : renderReport(report));
  const token = (await ports.readBytes(flags.tokenFile)).toString("utf8").trim();
  const receivedAt = await sendReport(report, flags.to, token, io.fetch);
  io.stdout(`reported ${report.surfaces.length} surfaces for ${host}; the console received it at ${receivedAt}\n`);
}

export function registerConfig(program: Command, io: ConfigIo): void {
  const config = program.command("config").description("Read this host's config surfaces");
  config
    .command("report")
    .description("List this host's config files as facts (present, mode, size, mtime, digest), never their values; --to sends them to the console")
    .option("--json", "print the report as one JSON object")
    .option("--host <name>", "the host name to report under; defaults to this machine's short host name")
    .option("--to <url>", "the console's https LAN origin to deposit the report to")
    .option("--token-file <path>", "the console's LAN token, sent as the bearer")
    .action((flags: ReportFlags) => runReport(io, flags));
}
