import type { ShepherdServices } from "./services.js";

interface ThawWatch {
  /** Repos thawed, or with a run's hold eased, since the sweep last read them. */
  thawed: Set<string>;
  /** Runs `start` on each later thaw or eased hold, outside its own call, so a gate the freeze caused is not left waiting out the sweep interval. */
  onThaw(start: () => void): void;
  stop(): void;
}

/** Watches from before resync and the first adoption, so a thaw then is still swept; a thaw keeps an owner hold's gate, so a hold easing here queues its repo too. */
export function watchThaws(services: ShepherdServices | undefined): ThawWatch {
  const thawed = new Set<string>();
  let start = (): void => undefined;
  const queue = (repo: string): void => void (thawed.add(repo), queueMicrotask(() => start()));
  const stopThaws = services?.freeze?.onThaw(queue);
  const store: ShepherdServices["store"] | undefined = services?.store;
  const stopReleases = store?.onChange?.((registration, change) => void (change === "hold-eased" && queue(registration.repo)));
  return { thawed, onThaw: (next) => void (start = next), stop: () => (stopThaws?.(), stopReleases?.()) };
}
