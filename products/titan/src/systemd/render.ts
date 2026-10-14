import { isAbsolute, join } from "node:path";

/** The same four system directories titan-factory.service puts after node's own. */
export const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** systemd expands `%` specifiers in every value below, so a literal one is doubled. */
export const noSpecifiers = (value: string): string => value.replace(/%/g, "%%");

/** systemd splits on whitespace and reads C escapes inside double quotes. */
export function quoteIfNeeded(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

/** ExecStart also expands `$VAR`, so a literal `$` is doubled there. */
export const execArg = (value: string): string => quoteIfNeeded(noSpecifiers(value).replace(/\$/g, "$$$$"));

/** XDG says a relative XDG_CONFIG_HOME is invalid and must be ignored. */
export function userUnitDir({ env, home }: { env: NodeJS.ProcessEnv; home: string }): string {
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(config, "systemd", "user");
}

export interface OneshotServiceOptions {
  description: string;
  argv: string[];
  nice?: number;
  idleIo?: boolean;
  /** Lets `systemctl show` report the run's CPU and IO use. */
  accounting?: boolean;
  environment?: Record<string, string>;
  environmentFile?: string;
  errLog?: string;
}

const line = (key: string, value: string | undefined): string[] => (value === undefined ? [] : [`${key}=${value}`]);

/**
 * The timer is what gets enabled, so the service has no [Install] section.
 * `append:` takes the rest of the line, so the log is never quoted.
 */
export function renderOneshotService(options: OneshotServiceOptions): string {
  const environment = Object.entries(options.environment ?? {});
  return [
    "[Unit]",
    `Description=${noSpecifiers(options.description)}`,
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${options.argv.map(execArg).join(" ")}`,
    ...line("Nice", options.nice?.toString()),
    ...(options.idleIo ? ["IOSchedulingClass=idle"] : []),
    ...(options.accounting ? ["CPUAccounting=yes", "IOAccounting=yes"] : []),
    ...environment.map(([key, value]) => `Environment=${quoteIfNeeded(noSpecifiers(`${key}=${value}`))}`),
    ...line("EnvironmentFile", options.environmentFile && noSpecifiers(options.environmentFile)),
    ...line("StandardError", options.errLog && `append:${noSpecifiers(options.errLog)}`),
    "",
  ].join("\n");
}

export interface CalendarTimerOptions {
  description: string;
  onCalendar: string;
  /** systemd's default coalescing window is one minute. */
  accuracySec?: string;
  /** True runs a start missed while the host was down as soon as it is back. */
  persistent: boolean;
  unit: string;
}

export function renderCalendarTimer(options: CalendarTimerOptions): string {
  return [
    "[Unit]",
    `Description=${noSpecifiers(options.description)}`,
    "",
    "[Timer]",
    `OnCalendar=${options.onCalendar}`,
    ...line("AccuracySec", options.accuracySec),
    `Persistent=${options.persistent}`,
    `Unit=${options.unit}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}
