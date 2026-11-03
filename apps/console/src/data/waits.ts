import type { DataSource } from "@titan-design/rpc-client";
import type { ViewKey } from "../view-keys.js";
import type { PerfRow, WaitRow } from "./perf.js";

/** The server takes at most this many command names on one wait row. */
export const MAX_WAIT_COMMANDS = 20;

interface Call {
  command: string;
  /** Sent through the answer source: a tap or button, not a page's query. */
  action: boolean;
}

interface Episode {
  view: ViewKey;
  t0: number;
  shown: number;
  commands: Set<string>;
  answeredBefore: ReadonlySet<string>;
}

export interface WaitTracker {
  /** The view a wait that starts from now on is charged to. */
  setView(view: ViewKey): void;
  /** A loading state became visible; the returned function hides it. Overlapping loaders of one kind are one wait. */
  show(mutation: boolean): () => void;
  /** A call began; the returned function marks it answered or failed. */
  callStarted(command: string, action: boolean): (ok: boolean) => void;
}

interface WaitTrackerOptions {
  emit: (row: PerfRow) => void;
  now?: () => number;
}

/** A button's wait is on the writes it sent; a page's wait is on every call in flight. */
const counts = (mutation: boolean, call: Call): boolean => !mutation || call.action;

/**
 * Times only what the owner sees: a wait starts when the first loader of its kind shows and ends when the last one
 * hides, so a refetch that renders no loader writes no row.
 */
export function createWaitTracker({ emit, now = () => performance.now() }: WaitTrackerOptions): WaitTracker {
  let view: ViewKey = "home";
  const inFlight = new Set<Call>();
  const answered = new Set<string>();
  const open = new Map<boolean, Episode>();

  const finish = (mutation: boolean, episode: Episode): void => {
    open.delete(mutation);
    const commands = [...episode.commands].sort().slice(0, MAX_WAIT_COMMANDS);
    const cold = commands.length === 0 || commands.some((command) => !episode.answeredBefore.has(command));
    const row: WaitRow = { kind: "wait", view: episode.view, commands, ms: now() - episode.t0, phase: cold ? "cold" : "refetch", mutation };
    emit(row);
  };

  const begin = (mutation: boolean): Episode => {
    const commands = new Set([...inFlight].filter((call) => counts(mutation, call)).map((call) => call.command));
    const episode: Episode = { view, t0: now(), shown: 0, commands, answeredBefore: new Set(answered) };
    open.set(mutation, episode);
    return episode;
  };

  return {
    setView(next) {
      view = next;
    },
    show(mutation) {
      const episode = open.get(mutation) ?? begin(mutation);
      episode.shown += 1;
      let hidden = false;
      return () => {
        if (hidden) return;
        hidden = true;
        episode.shown -= 1;
        if (episode.shown === 0 && open.get(mutation) === episode) finish(mutation, episode);
      };
    },
    callStarted(command, action) {
      const call: Call = { command, action };
      inFlight.add(call);
      for (const [mutation, episode] of open) if (counts(mutation, call)) episode.commands.add(command);
      return (ok) => {
        inFlight.delete(call);
        if (ok) answered.add(command);
      };
    },
  };
}

/** Tells the tracker about each call; an answer-source wrap also times the call itself as an action row. */
export function trackWaitCalls(source: DataSource, tracker: WaitTracker, action: { emit: (row: PerfRow) => void; now?: () => number } | null): DataSource {
  const now = action?.now ?? (() => performance.now());
  return {
    ...source,
    call(command, args, options) {
      const t0 = now();
      const done = tracker.callStarted(command, action !== null);
      const settle = (ok: boolean): void => {
        done(ok);
        action?.emit({ kind: "action", command, ms: now() - t0, ok });
      };
      const answer = source.call(command, args, options);
      answer.then((envelope) => settle(envelope.ok), () => settle(false));
      return answer;
    },
  };
}
