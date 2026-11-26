/**
 * What the beat assumes about the Claude Code harness that runs it, in one place.
 *
 * A seat arms the beat with Bash `run_in_background`. Claude Code gives that task a `timeout`
 * (10 min when unset in current builds) and caps it at 2 h; at the deadline the task is killed
 * and the session is woken with no wake line. Not every build enforces it, so the beat never
 * relies on it either way: it ends itself before the cap and prints its own re-arm line.
 */

/** The largest `timeout` Bash `run_in_background` accepts; the guide tells seats to pass it. */
export const BACKGROUND_TIMEOUT_CAP_MS = 7_200_000;

/** Default self-imposed lifetime, five minutes under the cap so a slow poll still beats the kill. */
export const DEFAULT_LIFETIME = "115m";

/** How the seat must start the re-arm command, stated in every line that carries one. */
export const ARM_HOW = `with Bash run_in_background and timeout ${BACKGROUND_TIMEOUT_CAP_MS}`;
