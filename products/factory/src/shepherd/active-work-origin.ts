const DEFAULT_ACTIVE_WORK_PORT = 7400;

/** The active-work daemon's own port rule: `AW_PORT` when it parses, else 7400. Kept apart from the launch-capable ports so a fenced file can import it. */
export function activeWorkOrigin(env: NodeJS.ProcessEnv): string {
  const port = Number.parseInt(env.AW_PORT ?? "", 10);
  return `http://127.0.0.1:${Number.isFinite(port) ? port : DEFAULT_ACTIVE_WORK_PORT}`;
}
