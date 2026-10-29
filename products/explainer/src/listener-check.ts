import { listenerVerdict, runListener } from "./listener-questions.js";
import { fromScriptV1 } from "./pace-items.js";
import { ScriptSchema } from "./script-schema.js";
import type { StageUsage } from "./workflow/records.js";
import type { JudgedStageCheck } from "./workflow/stage-checks.js";

/** The owner's listener exercise on the script stage's draft, reported per chapter in the run report. */
export const listenerQuestionsCheck: JudgedStageCheck = {
  name: "listener-questions",
  reads: ["draft"],
  run: async (input, judge) => {
    const draft = ScriptSchema.parse(JSON.parse(input.store.readText(input.artifacts.draft!)));
    const result = await runListener({ beats: fromScriptV1(draft), judge: judge.config, harness: judge.harness });
    const usage: StageUsage = { usd: result.spend.usd, inputTokens: result.spend.tokensIn, outputTokens: result.spend.tokensOut, cacheReadTokens: 0, calls: result.chapters.length };
    return { ...listenerVerdict(result, judge.listenerThreshold), usage };
  },
};
