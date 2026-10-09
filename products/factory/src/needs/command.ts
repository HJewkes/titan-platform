import type { Command } from "commander";
import type { QueueSource } from "@titan-design/owner-queue";
import type { FactoryHost } from "../host.js";
import { activeWorkOrigin } from "../shepherd/cleanup-ports.js";
import { EXIT } from "../exit-codes.js";
import { createActiveWorkSource } from "./active-work-source.js";
import { agentChatSource } from "./agent-chat-source.js";
import { localBrokerEndpoint } from "./agent-chat-endpoint.js";
import { hitlGateSource, type GateReader } from "./hitl-source.js";
import { collectNeeds, renderNeeds } from "./merged.js";
import { createMorningSource, morningQueuesDir } from "./morning-source.js";

interface NeedsIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface NeedsVerbs {
  io: NeedsIo & { env: NodeJS.ProcessEnv };
  withHost: (fn: (host: FactoryHost) => Promise<number> | number) => Promise<void>;
}

interface SourceOptions {
  morningDir?: string;
  includePersonal?: boolean;
}

/** The four owner-queue adapters over their live homes; the gates come from whoever holds them. */
export function ownerQueueSources(env: NodeJS.ProcessEnv, gates: GateReader, { morningDir = morningQueuesDir(env), includePersonal = false }: SourceOptions = {}): QueueSource[] {
  return [
    agentChatSource(localBrokerEndpoint(env)),
    hitlGateSource({ gates }),
    createMorningSource({ dir: morningDir }),
    createActiveWorkSource({ origin: activeWorkOrigin(env), includePersonal }),
  ];
}

/** Text for the owner, or the merged OwnerItem[] as JSON; a source that cannot be read still exits unavailable after the rest print. */
export async function runNeeds(io: NeedsIo, sources: readonly QueueSource[], flags: { json: boolean }): Promise<number> {
  const list = await collectNeeds(sources);
  io.stdout(flags.json ? `${JSON.stringify(list.items, null, 2)}\n` : `${renderNeeds(list)}\n`);
  for (const gap of list.gaps) io.stderr(`${gap}\n`);
  return list.gaps.length > 0 ? EXIT.UNAVAILABLE : EXIT.OK;
}

export function registerNeeds(program: Command, { io, withHost }: NeedsVerbs): void {
  program
    .command("needs")
    .description("everything waiting on the owner, merged across agent-chat, factory gates, Morning queues and needs-decision tasks; personal initiatives left out")
    .option("--json", "print the merged list as OwnerItem[]")
    .action((opts: { json?: boolean }) => withHost((host) => runNeeds(io, ownerQueueSources(io.env, host.gates), { json: opts.json === true })));
}
