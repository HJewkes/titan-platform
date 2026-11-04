import { shutdownOwner } from "../owner-shutdown.js";

const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * For a CLI process that drives runs itself: while `work` runs, a signal takes the process down through
 * {@link shutdownOwner}, then exits by that signal as the default action would have. Serve calls the same routine from
 * its own close.
 */
export async function shuttingDownOnSignal<T>(runtime: { quiesce(): void; shutdown(): void }, work: () => Promise<T>): Promise<T> {
  const owner = { stopAdmission: () => runtime.quiesce(), runtime };
  const off = (): void => {
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
  };
  const onSignal = (signal: NodeJS.Signals): void =>
    void shutdownOwner(owner).then(() => {
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
