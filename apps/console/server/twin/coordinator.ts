// The coordinator day's twin answers: synthetic accounts, coordinators and PRs, typed by the commands the page calls.
import { answer, type TwinCall } from "./answers.js";
import { TWIN_NOW } from "./clock.js";

const HOUR = 3_600_000;
const DATE = "2031-03-05";
const FROM = "2031-03-05T07:00:00.000Z";
const TO = "2031-03-06T07:00:00.000Z";

const pr = (repo: string, number: number, task: string) => ({ repo, number, task, initiative: "orbit-relay", url: `https://github.com/${repo}/pull/${number}` });

const ACCOUNTS = [
  {
    pool: "relay", members: ["relay", "relay-spare"], current: 58, beforeToday: 41, today: 17, reserveLine: 72, target: 64, level: "on_pace",
    perDayGuard: 61, resetsAt: TWIN_NOW + 3 * 24 * HOUR, ageSeconds: 240, stale: false,
  },
  {
    pool: "kiln", members: ["kiln"], current: 22, beforeToday: 20, today: 2, reserveLine: 72, target: 51, level: "at_risk",
    perDayGuard: 40, resetsAt: TWIN_NOW + 4 * 24 * HOUR, ageSeconds: 5_400, stale: true,
  },
  {
    pool: "lantern", members: ["lantern"], current: null, beforeToday: null, today: null, reserveLine: null, target: null, level: "no_reading",
    perDayGuard: null, resetsAt: null, ageSeconds: null, stale: null, error: "lantern: no reading",
  },
];

const CARDS = [
  {
    coordinator: "orbit-coord", seat: "orbit-coord", agentsRun: 4, liveNow: 1, costUsd: 6.4,
    prsMerged: [pr("orbit/relay", 12, "OR-12"), pr("orbit/relay", 14, "OR-15")],
    tasks: [{ id: "OR-12", title: "Retry the relay with capped backoff" }, { id: "OR-15", title: "Document the backoff ceiling" }],
  },
  { coordinator: "kiln-session-7", seat: null, agentsRun: 2, liveNow: 0, costUsd: null, prsMerged: [], tasks: [{ id: "OR-18" }] },
];

const SHIPPED_PRS = [pr("orbit/relay", 12, "OR-12"), pr("orbit/relay", 14, "OR-15"), pr("orbit/docs", 31, "OR-20")];

const DIGEST = {
  v: 1 as const, date: DATE, builtAt: "2031-03-06T07:10:00.000Z", prSetHash: "synthetic-hash",
  groups: [
    {
      initiative: "orbit-relay",
      themes: [
        { title: "Retries back off", summary: "The relay now retries a failed send with a capped exponential backoff, and the ceiling is documented.", prs: [SHIPPED_PRS[0], SHIPPED_PRS[1]] },
      ],
      unsummarized: [SHIPPED_PRS[2]],
    },
  ],
};

export const COORDINATOR_ANSWERS: readonly TwinCall[] = [
  answer("coord.pools", {}, { date: DATE, from: FROM, to: TO, accounts: ACCOUNTS, gaps: [] }),
  answer("coord.cards", {}, { date: DATE, cards: CARDS, unattributed: [pr("orbit/docs", 31, "OR-20")], gaps: [] }),
  answer("coord.shipped", {}, { date: DATE, built: true, stale: false, digest: DIGEST, merged: SHIPPED_PRS }),
];
