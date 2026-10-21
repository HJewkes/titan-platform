import type { WorkflowFn } from "@titan-design/workflow";
import { QuerySpecSchema, type QuerySpec } from "../types.js";
import { readContent, runPaths, writeJson, type UsageEntry } from "./run-dir.js";

/** Synthetic-only, like the judge roles: nothing here may quote a real corpus. */
export const COMPILE_ROLE = `# Role: query compiler

You turn a one-line "list every X" question about a local corpus of serial fiction into a search and judging spec.
You have no tools and cannot read the corpus.

- "entity": what one answer row is.
- "termGroups": an AND of ORs over single words; a paragraph matches when it holds one term from every group.
  Keep groups few and broad: recall matters more than precision here, a later judge filters. A trailing "*" is a prefix.
- "phrases": exact multi-word phrases that match on their own. "seedLexicon": names that match on their own.
- "mode": "phrase" only when the answer is always stated in a fixed wording; otherwise "broad".
- "inclusion" and "exclusion": the criteria a judge applies, one short sentence each.
- "canaries": two invented passages of one or two sentences in the corpus's register, about invented people and
  places: one that clearly matches ("expect": "match") and one near miss ("expect": "no-match").
- If owner rulings are given, fold them into "inclusion" and "exclusion".

Reply with the JSON object the schema asks for and nothing else.`;

export const COMPILE_STEP = "compile";

/** What the compile run leaves on disk: the spec, and the call's usage for the cost report. */
export interface CompileRecord {
  spec: QuerySpec;
  usage: UsageEntry[];
}

export function compileMessage(question: string, rules: string | undefined): string {
  return rules === undefined ? `Question: ${question}` : `Question: ${question}\n\nOwner rulings:\n${rules}`;
}

/** The `cq-compile` run: one call that turns the question into a spec, kept separate because the judge prefix is built from it. */
export function compileWorkflow(options: { dataDir: string; model: string }): WorkflowFn {
  return async (ctx) => {
    const rulesSha = ctx.param("rulesSha");
    const rules = rulesSha === undefined ? undefined : readContent(options.dataDir, "rules", rulesSha);
    const result = await ctx.dispatch(COMPILE_STEP, "{{MESSAGE}}", { schema: QuerySpecSchema, vars: { MESSAGE: compileMessage(ctx.param("question") ?? "", rules) } });
    const record: CompileRecord = { spec: QuerySpecSchema.parse(result.data), usage: result.usage ? [{ stepId: COMPILE_STEP, model: options.model, usage: result.usage }] : [] };
    writeJson(runPaths(options.dataDir, ctx.runId).compile, record);
  };
}
