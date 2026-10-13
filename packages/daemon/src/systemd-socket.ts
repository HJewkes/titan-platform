/**
 * The systemd socket-activation handoff (sd_listen_fds(3)): a supervisor that owns the
 * listening socket passes it as fd 3 and names the receiving process in `LISTEN_PID`.
 */

/** SD_LISTEN_FDS_START: the first passed fd follows stdin, stdout and stderr. */
const SD_LISTEN_FDS_START = 3;
const LISTEN_VARS = ["LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"] as const;

/**
 * The listening fd systemd passed to `pid`, or `undefined` when none was passed to it. A
 * `LISTEN_PID` naming another pid was meant for a parent and is left alone. On a match the
 * variables are removed from `env`, so no child process mistakes the socket for its own.
 */
export function systemdListenFd(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): number | undefined {
  const listenPid = env.LISTEN_PID;
  if (listenPid === undefined || Number(listenPid) !== pid) return undefined;
  const count = env.LISTEN_FDS;
  for (const name of LISTEN_VARS) delete env[name];
  if (count !== "1") throw new Error(`expected exactly one socket from systemd, got ${count ?? 0}`);
  return SD_LISTEN_FDS_START;
}
