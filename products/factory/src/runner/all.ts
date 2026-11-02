import { AuthorityDeniedError, AuthorityRefusedError, StepFailedError } from "@titan-design/workflow";

type AllOutcome<T> = { ok: true; value: T } | { ok: false; red: StepFailedError };

/**
 * Runs every child to its own completion. A red step is that child's outcome and never cancels a
 * sibling; any other error (a park, a cancel, a refusal) is rethrown only after every child settles.
 * An authority denial or refusal subclasses StepFailedError but is fatal, never a red outcome: a
 * recipe that tolerates red children must not carry on past the owner's no.
 * There is no deadline: a child ends when it completes or returns.
 */
export async function all<T>(children: readonly Promise<T>[]): Promise<AllOutcome<T>[]> {
  let fatal: { error: unknown } | undefined;
  const outcomes = await Promise.all(
    children.map(async (child): Promise<AllOutcome<T>> => {
      try {
        return { ok: true, value: await child };
      } catch (error) {
        if (error instanceof StepFailedError && !isAuthorityStop(error)) return { ok: false, red: error };
        fatal ??= { error };
        return { ok: false, red: new StepFailedError("all", 0, "non-step error") };
      }
    }),
  );
  if (fatal) throw fatal.error;
  return outcomes;
}

function isAuthorityStop(error: StepFailedError): boolean {
  return error instanceof AuthorityRefusedError || error instanceof AuthorityDeniedError;
}
