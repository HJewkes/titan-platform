import { CODE_READ_API_VERSION, type CommandArgs, type CommandName, type CommandResult } from "./contract.js";
import type { ReadSource } from "./source.js";

export type QueryFn<N extends CommandName> = (source: ReadSource, args: CommandArgs<N>) => CommandResult<N>;

export function describeApi(source: ReadSource): CommandResult<"api.describe"> {
  const facts = source.facts();
  const snapshots = source.snapshots();
  const newest = snapshots[0] ?? null;
  return {
    api: CODE_READ_API_VERSION,
    dataset: facts.dataset,
    commands: [...facts.commands],
    newest,
    indexVersions: [...new Set(snapshots.map((s) => s.indexVersion))],
    capabilities: facts.capabilities,
    metrics: newest ? [...source.model(newest.id).metricCatalogue] : [],
    rules: [...facts.rules],
  };
}

export function listSnapshots(source: ReadSource, args: CommandArgs<"snapshot.list">): CommandResult<"snapshot.list"> {
  const matching = source.snapshots().filter((s) => args.ref === undefined || s.ref === args.ref);
  return { snapshots: matching.slice(0, args.limit) };
}

/** One pure function per command; the registry commands and the static resolver both dispatch here. */
export const QUERIES: { [N in CommandName]: QueryFn<N> } = {
  "api.describe": describeApi,
  "snapshot.list": listSnapshots,
};
