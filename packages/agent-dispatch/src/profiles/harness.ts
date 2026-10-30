import { HARNESSES, isHarness, type AgentProfile, type Harness } from "./schema.js";

/** CC-1516: a Claude model name means nothing to Codex, and a launch must never map it to some other model. */
const CLAUDE_MODEL = /^(?:opus|sonnet|haiku|fable)\b|^claude-/i;

/** The load-time refusal for a profile's `harness` field, or undefined when the field is absent or fits its model. */
export function harnessError(name: string, body: Record<string, unknown>): string | undefined {
  if (body.harness === undefined) return undefined;
  if (!isHarness(body.harness)) return `${name}: "harness" must be one of ${HARNESSES.join(", ")}`;
  if (body.harness === "codex" && CLAUDE_MODEL.test(String(body.model)))
    return `${name}: "model" ${JSON.stringify(body.model)} is a Claude model; a "harness": "codex" profile names a Codex model`;
  return undefined;
}

/** CC-1516: the capability a harness waits on before it can launch, or undefined once it can. */
const HARNESS_PENDING: Record<Harness, string | undefined> = {
  "claude-code": undefined,
  codex: "the Codex launch plan (CC-1517)",
};

export const HARNESS_UNSUPPORTED = "harness_unsupported";

/** The refusal for launching this profile, before any process, worktree or slot exists; undefined when it can launch. */
export function harnessRefusal(profile: AgentProfile): string | undefined {
  const harness = profile.harness ?? "claude-code";
  const pending = HARNESS_PENDING[harness];
  if (pending === undefined) return undefined;
  return `${HARNESS_UNSUPPORTED}: profile "${profile.name}" uses harness "${harness}", unsupported until ${pending}`;
}
