#!/usr/bin/env node
import { demoSnapshot } from "./demo.js";
import { EventBook } from "./events.js";
import { Feed, ReconcileSchedule, type Timers } from "./feed.js";
import { brokerAddress, nodeSources } from "./sources.js";
import { EventFollower, followEvents } from "./stream.js";

const POLL_MS = 15_000;
const MIN_GAP_MS = 1_000;

interface Running {
  schedule: ReconcileSchedule;
  stop: AbortController;
}

function quitOnHangup({ schedule, stop }: Running): void {
  const quit = () => {
    stop.abort();
    schedule.stop();
    process.exit(0);
  };
  // The mod reads stdout; once it is gone there is no one to draw for.
  process.stdout.on("error", quit);
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
}

function main(): void {
  const address = brokerAddress(process.env);
  const book = new EventBook();
  const stop = new AbortController();
  const stream: { error: string | null } = { error: null };
  const feed = new Feed({
    sources: nodeSources(address, process.env),
    book,
    emit: (snapshot) => process.stdout.write(`${JSON.stringify(snapshot)}\n`),
    now: Date.now,
    streamError: () => stream.error,
  });
  const timers: Timers = { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (handle) => clearTimeout(handle) };
  const schedule = new ReconcileSchedule(() => feed.reconcile(), { pollMs: POLL_MS, minGapMs: MIN_GAP_MS, now: Date.now, timers });
  quitOnHangup({ schedule, stop });
  schedule.start();
  const onError = (message: string | null) => {
    stream.error = message;
  };
  void followEvents({ address, follower: new EventFollower(book), onChange: () => schedule.poke(), onError, signal: stop.signal });
}

/** Prints the synthetic fixture on the poll interval, reading nothing. */
function demo(): void {
  const print = () => process.stdout.write(`${JSON.stringify(demoSnapshot(Date.now()))}\n`);
  process.stdout.on("error", () => process.exit(0));
  print();
  setInterval(print, POLL_MS);
}

// The variable reaches a feed the mod starts from a session launched with it, with no settings edit.
if (process.argv.includes("--demo") || process.env.TITAN_FLEET_DEMO === "1") demo();
else main();
