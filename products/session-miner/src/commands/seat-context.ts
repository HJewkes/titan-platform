import { EXIT, defineCommand } from "@titan-design/registry";
import { seatContext, seatContextSchema, type SeatContextRow, type SeatSessions } from "@titan-design/session-analytics";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { isoTime, utc } from "../insights/define.js";

const DAYS = /^(\d+)d$/;
const SEAT = /^([^=\s]+)=(.+)$/;

const SeatContextArgs = z
  .object({
    seat: z.array(z.string().regex(SEAT, "expected name=sessionId,sessionId")).min(1).describe("a seat and its session ids, as name=id,id (repeatable)"),
    since: z.union([z.string().regex(DAYS), isoTime]).describe("ISO timestamp or date, inclusive, or Nd for N days before now"),
    until: isoTime.optional().describe("ISO timestamp or date, exclusive"),
    p90Max: z.number().int().nonnegative().optional().describe("fail a seat whose p90 context is above this"),
    autoMax: z.number().int().nonnegative().optional().describe("fail a seat with more auto-compactions than this"),
  })
  .strict();

type Args = z.infer<typeof SeatContextArgs>;

interface SeatVerdict extends SeatContextRow {
  /** Empty when the seat is within every given limit. */
  failures: string[];
}

export const seatContextCommand = defineCommand<Args, SeatVerdict[] | string, MinerContext>({
  name: "seat-context",
  description: "Per-seat context p50/p90/max per call and auto-compactions over a window, with optional limits",
  args: SeatContextArgs,
  result: z.union([z.array(seatContextSchema.element.extend({ failures: z.array(z.string()) })), z.string()]),
  cli: {
    options: {
      seat: { long: "--seat", description: "name=sessionId,sessionId (repeatable)" },
      since: { long: "--since", description: "ISO timestamp, date, or Nd" },
      until: { long: "--until", description: "ISO timestamp or date, exclusive" },
      p90Max: { long: "--p90-max", description: "max p90 context tokens per seat" },
      autoMax: { long: "--auto-max", description: "max auto-compactions per seat" },
    },
  },
  async run(args, ctx) {
    const window = { since: resolveSince(args.since, new Date()), until: utc(args.until) ?? null };
    const rows = seatContext(ctx.graph().db, { window, sessions: args.seat.map(parseSeat) });
    const verdicts = rows.map((row) => ({ ...row, failures: seatFailures(row, args) }));
    const text = verdicts.map(renderSeatLine).join("\n");
    if (verdicts.some((verdict) => verdict.failures.length > 0)) throw Object.assign(new Error(text), { code: EXIT.GENERIC });
    return ctx.format === "human" ? text : verdicts;
  },
});

function resolveSince(since: string, now: Date): string {
  const days = DAYS.exec(since);
  return days ? new Date(now.getTime() - Number(days[1]) * 86_400_000).toISOString() : utc(since)!;
}

function parseSeat(spec: string): SeatSessions {
  const [, name, ids] = SEAT.exec(spec)!;
  return { name: name!, sessionIds: ids!.split(",").map((id) => id.trim()).filter(Boolean) };
}

function seatFailures(row: SeatContextRow, limits: Pick<Args, "p90Max" | "autoMax">): string[] {
  const failures: string[] = [];
  if (limits.p90Max !== undefined && row.p90 > limits.p90Max) failures.push(`p90 ${kTokens(row.p90)} > ${kTokens(limits.p90Max)}`);
  if (limits.autoMax !== undefined && row.compactions.auto > limits.autoMax) failures.push(`auto-compactions ${row.compactions.auto} > ${limits.autoMax}`);
  return failures;
}

function renderSeatLine(verdict: SeatVerdict): string {
  const { name, requests, p50, p90, max, compactions, failures } = verdict;
  const stats = `calls ${requests}  p50 ${kTokens(p50)}  p90 ${kTokens(p90)}  max ${kTokens(max)}  auto ${compactions.auto}  manual ${compactions.manual}`;
  return `${name}  ${stats}  ${failures.length === 0 ? "PASS" : `FAIL ${failures.join("; ")}`}`;
}

function kTokens(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}
