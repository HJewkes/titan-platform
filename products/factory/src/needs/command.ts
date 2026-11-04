import type { Command } from "commander";
import type { QueueSource } from "@titan-design/owner-queue";
import type { NeedsSources } from "../context.js";
import type { FactoryHost } from "../host.js";
import { activeWorkOrigin } from "../shepherd/cleanup-ports.js";
import { EXIT } from "../exit-codes.js";
import { createActiveWorkSource } from "./active-work-source.js";
import { agentChatSource } from "./agent-chat-source.js";
import { localBrokerEndpoint } from "./agent-chat-endpoint.js";
import { hitlGateSource, type GateReader } from "./hitl-source.js";
import { keptSource, type KeepWindow } from "./kept-source.js";
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
  /** Replaces the live active-work adapter; the serving factory passes a kept one. */
  activeWork?: QueueSource;
}

/** The four owner-queue adapters over their live homes; the gates come from whoever holds them. */
export function ownerQueueSources(env: NodeJS.ProcessEnv, gates: GateReader, { morningDir = morningQueuesDir(env), includePersonal = false, activeWork }: SourceOptions = {}): QueueSource[] {
  return [
    agentChatSource(localBrokerEndpoint(env)),
    hitlGateSource({ gates }),
    createMorningSource({ dir: morningDir }),
    activeWork ?? createActiveWorkSource({ origin: activeWorkOrigin(env), includePersonal }),
  ];
}

/**
 * Gates are fast, local and written here, and broker items are answered from the console, so both are read live.
 * Only the seconds-long active-work leg is kept. needs-decision tasks change over hours, and a read past the fresh
 * window still starts a refresh, so a console opened after a quiet night answers at once and is current on its next poll.
 */
const ACTIVE_WORK_KEEP: KeepWindow = { freshMs: 15_000, staleMs: 6 * 60 * 60_000 };

/** The serving factory's needs sources: built once, so the kept active-work read outlives each request. */
export function keptNeedsSources(env: NodeJS.ProcessEnv, gates: GateReader, window: KeepWindow = ACTIVE_WORK_KEEP): NeedsSources {
  const kept = new Map<boolean, QueueSource>();
  const activeWorkFor = (includePersonal: boolean): QueueSource => {
    const source = kept.get(includePersonal) ?? keptSource(createActiveWorkSource({ origin: activeWorkOrigin(env), includePersonal }), window);
    kept.set(includePersonal, source);
    return source;
  };
  return ({ personal }) => ownerQueueSources(env, gates, { includePersonal: personal, activeWork: activeWorkFor(personal) });
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
