import type { ModelStageInput } from "./model-stages.js";
import type { StageOutcome } from "./records.js";
import { gatherFacts, type GatherDeps, type GatherRequest } from "./run-gather.js";

/**
 * Stage 1: the profile's gather body (gatherDaily, gatherPr or gatherArticle) on the request the run was planned with.
 * Its facts file is the `facts` the audition and script read; a gather that reads a repo also leaves `code`.
 */
export async function runGatherStage(request: GatherRequest, input: ModelStageInput, dataDir: string, deps: GatherDeps = {}): Promise<StageOutcome> {
  const gathered = await gatherFacts(request, dataDir, deps);
  const facts = input.store.putText(gathered.factsText, "facts", input.from);
  const outputs: Record<string, string> = { facts };
  if (gathered.code !== undefined) outputs.code = input.store.putText(gathered.code, "code", input.from);
  const where = `${request.adapter} gathered ${gathered.items} facts for ${request.type} into ${gathered.facts}`;
  return { outputs, notes: [where, ...gathered.notes] };
}
