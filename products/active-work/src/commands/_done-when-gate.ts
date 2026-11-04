export const DONE_WHEN_MIN_CHARS = 40;

const fold = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** An agent runs under either variable; a human shell sets neither. */
export function agentCaller(env: NodeJS.ProcessEnv): 'agent' | undefined {
  return env.AGENT_CHAT_NAME || env.CLAUDECODE ? 'agent' : undefined;
}

/** Why a done_when is unusable, or undefined when it can be filed. */
export function doneWhenProblem(title: string, doneWhen: string | undefined): string | undefined {
  const fix = `pass --done-when with a checkable outcome of at least ${DONE_WHEN_MIN_CHARS} characters, or --draft to file it without one`;
  if (doneWhen === undefined || doneWhen.trim() === '') return `done_when is missing: ${fix}`;
  if (fold(doneWhen) === fold(title)) return `done_when repeats the title: ${fix}`;
  if (doneWhen.trim().length < DONE_WHEN_MIN_CHARS) {
    return `done_when is under ${DONE_WHEN_MIN_CHARS} characters: ${fix}`;
  }
  return undefined;
}
