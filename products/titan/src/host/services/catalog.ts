import { join } from "node:path";
import { userUnitDir } from "@titan-design/daemon/service";
import type { HostPorts } from "../ports.js";
import { BACKUP_SERVICE, BACKUP_TIMER, backupScriptPath, renderBackupService, renderBackupTimer } from "./backup.js";

type ServiceSource = "render" | "delegate" | "chezmoi" | "deferred";
type CatalogPlatform = "linux" | "darwin";

interface CatalogRow {
  id: string;
  source: ServiceSource;
  detail: string;
  /** The host-job task a deferred row waits on. */
  task?: string;
  /** Commands the owner runs for a delegated row; titan runs none of them. */
  commands?: string[];
  /** Hand-written units a rendered row replaces once installed. */
  legacyUnits?: string[];
}

const USAGE_POLL_COMMANDS = [
  "npm install -g --prefix ~/.local @titan-design/anthropic-account",
  'cp "$(npm root -g --prefix ~/.local)/@titan-design/anthropic-account/systemd/"anthropic-account-poll* ~/.config/systemd/user/',
  "systemctl --user daemon-reload",
  "systemctl --user enable --now anthropic-account-poll.timer",
];

const MEMORY_SAMPLER: CatalogRow = {
  id: "memory-sampler",
  source: "deferred",
  task: "TP-792",
  detail: "darwin-only sampler; its host job is TP-792",
};

/** Item 62 OQ-3 allows no new plists, so no darwin row may render: each names its owner or task. */
const CATALOG: Record<CatalogPlatform, CatalogRow[]> = {
  linux: [
    {
      id: "backup",
      source: "render",
      detail: `${BACKUP_SERVICE} and ${BACKUP_TIMER}, running scripts/host-backup.sh`,
      legacyUnits: ["restic-nightly.timer", "restic-nightly.service"],
    },
    { id: "health-sampler", source: "delegate", detail: "installed by titan health install", commands: ["titan health install"] },
    {
      id: "usage-refresh",
      source: "delegate",
      detail: "systemd units shipped by @titan-design/anthropic-account",
      commands: USAGE_POLL_COMMANDS,
    },
    MEMORY_SAMPLER,
  ],
  darwin: [
    { id: "backup", source: "deferred", task: "TP-1558", detail: "host job TP-1558 replaces the hand-written launchd backup" },
    { id: "health-sampler", source: "deferred", task: "TP-1659", detail: "host job TP-1659; titan health install is linux-only" },
    { id: "usage-refresh", source: "chezmoi", detail: "launch agent and refresh script owned by the dotfiles (chezmoi)" },
    MEMORY_SAMPLER,
  ],
};

interface UnitFile {
  path: string;
  text: string;
}

export interface PlannedService extends CatalogRow {
  /** Only render rows carry units and the systemctl commands that would enable them. */
  units?: UnitFile[];
  /** The legacy units found in the user unit dir. */
  legacyFound?: string[];
}

export interface ServicesPlan {
  platform: NodeJS.Platform;
  services: PlannedService[];
}

interface PlanPaths {
  home: string;
  xdgConfigHome?: string;
  titanBin: string;
}

const isCatalogPlatform = (platform: NodeJS.Platform): platform is CatalogPlatform => platform in CATALOG;

/** Stats the legacy units only; nothing here reads, writes or runs anything. */
export async function planServices(platform: NodeJS.Platform, ports: HostPorts, paths: PlanPaths): Promise<ServicesPlan> {
  const rows = isCatalogPlatform(platform) ? CATALOG[platform] : [];
  const services = await Promise.all(rows.map((row) => (row.source === "render" ? planRendered(row, ports, paths) : row)));
  return { platform, services };
}

async function planRendered(row: CatalogRow, ports: HostPorts, paths: PlanPaths): Promise<PlannedService> {
  const dir = userUnitDir(paths.home, paths.xdgConfigHome);
  const units = [
    { path: join(dir, BACKUP_SERVICE), text: renderBackupService(backupScriptPath(paths.titanBin)) },
    { path: join(dir, BACKUP_TIMER), text: renderBackupTimer() },
  ];
  const legacy = row.legacyUnits ?? [];
  const found = await Promise.all(legacy.map(async (unit) => ((await ports.stat(join(dir, unit))) === null ? [] : [unit])));
  const legacyFound = found.flat();
  const disable = legacyFound.filter((unit) => unit.endsWith(".timer")).map((unit) => `systemctl --user disable --now ${unit}`);
  const commands = [...disable, "systemctl --user daemon-reload", `systemctl --user enable --now ${BACKUP_TIMER}`];
  return { ...row, units, legacyFound, commands };
}
