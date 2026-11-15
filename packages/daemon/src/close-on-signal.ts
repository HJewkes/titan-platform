import type { DaemonHandle } from "./daemon.js";

interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
}

/** Closes on SIGINT or SIGTERM, then runs `onClose` so a caller can stop what it started beside the daemon. */
export function closeOnSignal(
  handle: Pick<DaemonHandle, "close">,
  onClose: () => Promise<void> = async () => {},
  signals: SignalSource = process,
): void {
  const stop = (): void => {
    // A failing onClose must not leave the daemon bound, nor surface as an unhandled rejection.
    void onClose()
      .catch(() => undefined)
      .finally(() => handle.close());
  };
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
}
