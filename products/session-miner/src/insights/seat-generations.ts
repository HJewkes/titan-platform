import { LIST_PRICE_CAVEAT, readAgentSessions, readHandoffs, seatGenerations as resolveGenerations, seatGenerationsSchema, type SeatGeneration } from "@titan-design/session-analytics";
import { z } from "zod";
import { withEventsDb } from "./blocked-flow-sources.js";
import { defineInsight, refuseSessionScope } from "./define.js";
import { readBrokerLog } from "./liveness-sources.js";

export const seatGenerationsReportSchema = z.object({
  seat: z.string(),
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }),
  generations: seatGenerationsSchema,
  /** `--session` flags for every graph session the generations ran as, ready to pass to the graph questions. */
  sessionArgs: z.string(),
});

export type SeatGenerationsReport = z.infer<typeof seatGenerationsReportSchema>;

/** A generation that started at or after `until` lies outside the window; one with no known start is kept. */
function startedBefore(until: string | undefined) {
  return (g: SeatGeneration) => !until || g.start === null || Date.parse(g.start) < Date.parse(until);
}

function sessionArgs(generations: readonly SeatGeneration[]): string {
  return generations.flatMap((g) => g.sessionIds.map((id) => `--session ${id}`)).join(" ");
}

function renderSeatGenerationsText(data: SeatGenerationsReport): string {
  const { seat, window, generations } = data;
  const header = `Generations of ${seat}, ${window.since ?? "beginning"} to ${window.until ?? "now"}: ${generations.length}`;
  const lines = generations.map(
    (g) => `${g.generation}. ${g.agentId} from ${g.start ?? "unknown"} to ${g.end ?? "now"}, ended by ${g.endedBy}; sessions: ${g.sessionIds.join(", ") || "none in the graph"}`,
  );
  const args = data.sessionArgs ? `Graph questions over these generations: ${data.sessionArgs}` : "No generation has a session in the graph.";
  return [header, ...lines, "", args, "", LIST_PRICE_CAVEAT].join("\n") + "\n";
}

export const seatGenerations = defineInsight<{ seat: string; brokerLog?: string }, SeatGenerationsReport>({
  id: "Q14",
  name: "seat-generations",
  description: "Each agent that held a seat's name in the window, how it ended, and its graph sessions as ready --session flags",
  options: {
    seat: z.string().min(1).describe("the agent-chat seat name whose generations to list"),
    brokerLog: z.string().min(1).optional().describe("agent-chat broker log to read instead of TITAN_MINER_BROKER_LOG"),
  },
  flags: {
    seat: { long: "--seat", description: "seat name" },
    brokerLog: { long: "--broker-log", description: "broker log path" },
  },
  schema: seatGenerationsReportSchema,
  cliOnly: ["brokerLog"],
  answer(db, report, options, config) {
    refuseSessionScope("seat-generations", report.scope, "; name the seat with --seat");
    const broker = readBrokerLog(options.brokerLog ?? config.brokerLog);
    const handoffs = withEventsDb(config.eventsDb, (events) => readHandoffs(events));
    const resolved = resolveGenerations({ handoffs, broker, agentSessions: readAgentSessions(db), seat: options.seat, since: report.since });
    const generations = resolved.filter(startedBefore(report.until)).map((g, i) => ({ ...g, generation: i + 1 }));
    const data = { seat: options.seat, window: { since: report.since ?? null, until: report.until ?? null }, generations, sessionArgs: sessionArgs(generations) };
    return { data, text: renderSeatGenerationsText(data) };
  },
});
