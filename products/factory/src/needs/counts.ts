import type { Command } from "commander";
import type { FactoryHost } from "../host.js";
import { EXIT } from "../exit-codes.js";
import { readBrokerQueue, type BrokerEndpoint } from "./agent-chat-source.js";
import { toOwnerItem } from "./agent-chat-item.js";
import { localBrokerEndpoint } from "./agent-chat-endpoint.js";
import { hitlGateSource, type GateReader } from "./hitl-source.js";
import { QueueReadError } from "./queue-read-error.js";

interface CountsIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

interface CountsVerbs {
  io: CountsIo;
  withHost: (fn: (host: FactoryHost) => Promise<number> | number) => Promise<void>;
}

/** `kind n, kind n` in key order, so two runs compare line by line. */
export function tally(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => `${key} ${n}`).join(", ") || "none";
}

async function brokerLines(endpoint: BrokerEndpoint): Promise<string[]> {
  const rows = await readBrokerQueue(endpoint);
  const items = rows.map(toOwnerItem);
  return [
    `agent-chat /api/queue: ${rows.length} open`,
    `  by broker kind: ${tally(rows.map((row) => row.kind))}`,
    `  by owner kind: ${tally(items.map((item) => item.kind))}`,
    `  by lens: ${tally(items.map((item) => item.lens))}`,
  ];
}

async function gateLines(gates: GateReader): Promise<string[]> {
  const items = await hitlGateSource({ gates }).open();
  return [`factory hitl gates: ${items.length} pending`, `  by gate step: ${tally(items.map((item) => stepOf(item.sources[0]!.ref)))}`];
}

const stepOf = (gateId: string): string => gateId.slice(gateId.indexOf("/") + 1).replace(/:\d+$/, "");

/** Counts only, never item text: the output is safe to paste into a public pull request. */
export async function queueCounts(io: CountsIo, endpoint: BrokerEndpoint, gates: GateReader): Promise<number> {
  let code: number = EXIT.OK;
  for (const read of [() => brokerLines(endpoint), () => gateLines(gates)]) {
    try {
      io.stdout(`${(await read()).join("\n")}\n`);
    } catch (error) {
      if (!(error instanceof QueueReadError)) throw error;
      io.stderr(`${error.message} (${error.failure})\n`);
      code = EXIT.UNAVAILABLE;
    }
  }
  return code;
}

export function registerQueueCounts(program: Command, { io, withHost }: CountsVerbs): void {
  program
    .command("queue-counts")
    .description("count the owner queue's open items per source (agent-chat /api/queue, factory gates), split by kind; prints no item text")
    .action(() => withHost((host) => queueCounts(io, localBrokerEndpoint(io.env), host.gates)));
}
