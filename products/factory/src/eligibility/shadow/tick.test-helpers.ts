import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runCli } from "../../cli.js";
import type { CliDeps } from "../../cli-types.js";
import type { LaneSignals } from "../back-pressure.js";

type Body = Record<string, unknown>;

const prediction = { metric: "lead time", direction: "decrease", baseline: 4, expected: 2, read_by: "2026-11-30" };

export function selectedBet(n: number, order: number, tasks: string[]): Body {
  return { id: `alpha/B${n}`, initiative: "alpha", week: "2026-W47", outcome: "alpha/faster-landing", order, tasks, prediction, state: "selected" };
}

/** An open synthetic task that passes every eligibility check against `alpha/B1`. */
export function task(n: number, fields: Body = {}): Body {
  const base = { id: `AL-${n}`, title: `Synthetic ${n}`, priority: 1, status: "open", created: `2026-11-0${n}`, updated: "2026-11-09", done_at: null };
  return { ...base, done_when: "A test shows it.", bet: "alpha/B1", fold: "independent", owner_steps: [], slug: "alpha", tags: ["lane-a"], ...fields };
}

/** An active-work daemon that answers only the read commands the eligibility reader calls. */
export function fakeRpc(ws: { tasks: Body[]; bets: Body[] }): { fetch: typeof globalThis.fetch; commands: string[] } {
  const commands: string[] = [];
  const answer = (command: string, body: Body): unknown => {
    if (command === "task.list") return { tasks: ws.tasks.filter((row) => body.tag === undefined || (Array.isArray(row.tags) && row.tags.includes(body.tag))) };
    if (command === "plan.bet.list") return ws.bets.filter((bet) => bet.week === body.week);
    if (command === "plan.freeze.list" || command === "plan.out-of-scope.list") return [];
    throw new Error(`unexpected ${command}`);
  };
  const fetch = (async (url, init) => {
    const command = String(url).split("/rpc/")[1]!;
    commands.push(command);
    return new Response(JSON.stringify({ ok: true, data: answer(command, z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body)))) }));
  }) as typeof globalThis.fetch;
  return { fetch, commands };
}

export const calm: LaneSignals = { openPrs: 0, mergedNotDeployed: 0, ownerQueue: 0, reviewers: { accounts: 1, exhausted: 0 }, deployStall: [], redMain: [], unread: {} };

interface Home {
  dir: string;
  shadowDir: string;
  env: NodeJS.ProcessEnv;
}

/** A factory config dir with `dispatcher.json` beside `config.json`; `rules` undefined leaves the rule file absent. */
export function shadowHome(rules?: Body): Home {
  const dir = mkdtempSync(join(tmpdir(), "shadow-tick-"));
  const shadowDir = join(dir, "shadow");
  writeFileSync(join(dir, "config.json"), "{}");
  if (rules !== undefined) writeFileSync(join(dir, "dispatcher.json"), JSON.stringify(rules));
  return { dir, shadowDir, env: { TITAN_FACTORY_CONFIG: join(dir, "config.json") } };
}

export function enabledRules(home: { shadowDir: string } | string, extra: Body = {}): Body {
  const dir = typeof home === "string" ? home : home.shadowDir;
  return { schema: "titan-dispatcher/v1", mode: "shadow", shadow: { enabled: true, dir }, lanes: [{ initiative: "alpha", tag: "lane-a" }], ...extra };
}

export async function shadowTickCli(home: Home, fetch: typeof globalThis.fetch, signals: Partial<LaneSignals> = {}, args: string[] = [], deps: Partial<CliDeps> = {}) {
  const out = { stdout: "", stderr: "" };
  const io = { stdout: (t: string) => void (out.stdout += t), stderr: (t: string) => void (out.stderr += t), env: home.env };
  const all: CliDeps = { workflows: [], routes: [], fetch, laneSignals: async () => ({ ...calm, ...signals }), ...deps };
  const code = await runCli(["dispatch", "shadow-tick", ...args], io, all);
  return { code, ...out };
}

/** Every row the shadow dir holds, file by file in name order. */
export function readRows(shadowDir: string): { file: string; rows: Body[] }[] {
  if (!existsSync(shadowDir)) return [];
  return readdirSync(shadowDir)
    .sort()
    .map((file) => ({ file, rows: readFileSync(join(shadowDir, file), "utf8").trimEnd().split("\n").map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line))) }));
}
