import { stopEvals } from "./run-command.js";

const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * For a CLI process that drives evals itself and has no shutdown of its own: while `work` runs, a signal stops the evals
 * it spawned, then exits by that signal as the default action would have. Serve owns its own shutdown and calls
 * {@link stopEvals} there instead.
 */
export async function stoppingEvalsOnSignal<T>(work: () => Promise<T>): Promise<T> {
  const off = (): void => {
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
  };
  const onSignal = (signal: NodeJS.Signals): void =>
    void stopEvals().then(() => {
      off();
      process.kill(process.pid, signal);
    });
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  try {
    return await work();
  } finally {
    off();
  }
}
