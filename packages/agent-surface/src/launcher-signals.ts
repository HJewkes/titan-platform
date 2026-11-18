import { spawnSync, type ChildProcess } from "node:child_process";

const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

interface LauncherSignalOptions {
  label: string;
  /** The plan's agent name, written on every line so a log of many launchers stays readable. */
  agent: string;
  /** An inherited terminal already delivers Ctrl-C to the child's whole foreground process group, so forwarding SIGINT would deliver it twice. */
  interactive: boolean;
  /**
   * A terminal hangup reaches only the session leader. It reaches the child's group only when a job-control
   * shell in front of the launcher passes it on (the iTerm `zsh -lic` command). Where the launcher is the
   * session leader (tmux), nothing else signals the child, so SIGHUP must still be forwarded.
   */
  shellPassesHangup: boolean;
}

/** Node has no `getpgid`; `ps` is the portable way to ask, and a failure must not stop the forward. */
function processGroupId(pid: number): string {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  const pgid = result.status === 0 ? result.stdout.trim() : "";
  return pgid === "" ? "unknown" : pgid;
}

/**
 * Forwards SIGTERM, SIGINT and SIGHUP to the child, one stderr line each, so a signalled launcher
 * leaves a trace and never strands a running child. Returns the function that removes the handlers.
 */
export function installLauncherSignals(child: ChildProcess, options: LauncherSignalOptions): () => void {
  const handlers = FORWARDED_SIGNALS.map(signal => {
    const handler = (): void => {
      const time = new Date().toISOString();
      const ids = `ppid=${process.ppid} pgid=${processGroupId(process.pid)}`;
      process.stderr.write(`${options.label}: ${time} agent=${options.agent} signal=${signal} ${ids}\n`);
      if (options.interactive && signal === "SIGINT") return;
      if (options.shellPassesHangup && signal === "SIGHUP") return;
      child.kill(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

export const exitLine = (label: string, agent: string, code: number | null, signal: NodeJS.Signals | null): string =>
  `${label}: agent=${agent} exited code=${code ?? "none"} signal=${signal ?? "none"}\n`;
