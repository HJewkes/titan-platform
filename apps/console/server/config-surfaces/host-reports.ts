/**
 * Another host's config report: `config.report` stores what `titan config report --to` sends, and
 * `config.hosts` shows it. A report is data, not authority. It names files and their facts (mode,
 * size, mtime, digest) and never a value, and nothing here writes outside the report directory, so
 * a deposit can only change what the page shows. The schema is strict at every level: a field it
 * does not name, such as a `revision` to apply, refuses the whole report.
 *
 * Only a bearer from another machine is taken. Loopback carries no credential and any local
 * process can read the token file, so either would let an agent on this host speak for another.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { depositCommand, readCommand, type ConsoleContext } from "../owner-guard.js";

export const CONFIG_REPORT = "config.report";
export const CONFIG_REPORT_SCHEMA = "titan-config-report/v1";
/** A day plus an hour of slack for a daily timer that fires late. */
const REPORT_STALE_MS = 25 * 60 * 60 * 1000;
export const MAX_REPORTING_HOSTS = 16;

const hostName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "a host is a lowercase name of letters, digits and dashes");

const reportedSurface = z
  .object({
    kind: z.string().regex(/^[a-z0-9-]{1,64}$/),
    inventory: z.number().int().min(1).max(99),
    /** `~`-relative, so two hosts' rows for one surface compare by name. */
    file: z.string().min(1).max(512),
    present: z.boolean(),
    /** A secret file is reported by presence, mode and mtime alone. */
    secret: z.boolean(),
    mode: z.string().regex(/^0[0-7]{3}$/).optional(),
    bytes: z.number().int().nonnegative().optional(),
    mtime: z.iso.datetime().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .refine((surface) => !surface.secret || (surface.bytes === undefined && surface.sha256 === undefined), "a secret surface carries no size or digest");

const hostReportSchema = z
  .object({
    schema: z.literal(CONFIG_REPORT_SCHEMA),
    host: hostName,
    platform: z.string().regex(/^[a-z0-9]{1,16}$/),
    reportedAt: z.iso.datetime(),
    surfaces: z.array(reportedSurface).max(500),
  })
  .strict();

type HostReport = z.infer<typeof hostReportSchema>;

const storedReport = z.object({ receivedAt: z.iso.datetime(), report: hostReportSchema }).strict();
type StoredReport = z.infer<typeof storedReport>;

const hostView = z.object({
  host: z.string(),
  status: z.enum(["reported", "not reported"]),
  reportedAt: z.string(),
  receivedAt: z.string(),
  platform: z.string(),
  /** Empty once the report is stale, so an old reading is never shown as current. */
  surfaces: z.array(reportedSurface),
});

const hostsResult = z.object({ hosts: z.array(hostView), gaps: z.array(z.string()) });

export type HostView = z.infer<typeof hostView>;

export interface HostReportsSource {
  /** One `<host>.json` per reporting host; created 0700 on the first report. */
  dir: string;
  now?: () => Date;
}

class ReportRefusedError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "ReportRefusedError";
  }
}

function assertRemoteBearer(ctx: ConsoleContext): void {
  if (ctx.auth?.credential !== "bearer") throw new ReportRefusedError("config.report needs a bearer on the LAN listener", EXIT.NOPERM);
  if (ctx.auth.peerLocal) throw new ReportRefusedError("config.report comes from another host; this machine's own config is read directly", EXIT.NOPERM);
}

async function reportNames(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
  return names.filter((name) => !name.startsWith(".") && name.endsWith(".json"));
}

/** tmp then rename, so a reader never sees half a report. */
async function store(dir: string, stored: StoredReport): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const names = await reportNames(dir);
  const file = `${stored.report.host}.json`;
  if (!names.includes(file) && names.length >= MAX_REPORTING_HOSTS) {
    throw new ReportRefusedError(`the console already holds reports from ${MAX_REPORTING_HOSTS} hosts`, EXIT.TEMPFAIL);
  }
  const tmp = path.join(dir, `.${file}.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(stored)}\n`, { mode: 0o600, flag: "wx" });
  await rename(tmp, path.join(dir, file));
}

/** Measured from the older of the two stamps, so neither a fast clock on the host nor a resent old report looks fresh. */
function viewOf({ receivedAt, report }: StoredReport, now: Date): HostView {
  const since = Math.min(Date.parse(receivedAt), Date.parse(report.reportedAt));
  const fresh = now.getTime() - since <= REPORT_STALE_MS;
  const base = { host: report.host, reportedAt: report.reportedAt, receivedAt, platform: report.platform };
  return fresh ? { ...base, status: "reported", surfaces: report.surfaces } : { ...base, status: "not reported", surfaces: [] };
}

async function readStored(file: string): Promise<StoredReport | null> {
  try {
    return storedReport.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return null;
  }
}

async function readHosts(dir: string, now: Date): Promise<z.infer<typeof hostsResult>> {
  const names = (await reportNames(dir)).sort();
  const stored = await Promise.all(names.map((name) => readStored(path.join(dir, name))));
  return {
    hosts: stored.flatMap((each) => (each === null ? [] : [viewOf(each, now)])),
    gaps: names.filter((_, index) => stored[index] === null).map((name) => `${name}: not a stored config report`),
  };
}

export function hostReportsCommands({ dir, now = () => new Date() }: HostReportsSource) {
  return {
    [CONFIG_REPORT]: depositCommand({
      name: CONFIG_REPORT,
      description: "Store another host's config report for `config.hosts` to show; nothing in it is ever applied",
      args: hostReportSchema,
      result: z.object({ host: z.string(), receivedAt: z.string() }),
      run: async (report: HostReport, ctx: ConsoleContext) => {
        assertRemoteBearer(ctx);
        const receivedAt = now().toISOString();
        await store(dir, { receivedAt, report });
        return { host: report.host, receivedAt };
      },
    }),
    "config.hosts": readCommand({
      name: "config.hosts",
      description: "Each other host's last config report; one older than 25 hours shows as not reported, with no surfaces",
      args: z.object({}),
      result: hostsResult,
      run: () => readHosts(dir, now()),
    }),
  };
}
