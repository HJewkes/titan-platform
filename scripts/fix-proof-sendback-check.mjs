// Asserts, over `titan-factory shepherd timeline --json` entries, that Shepherd sent a vacuous fix PR back to its
// implementer at one head before any reviewer looked at it (TP-538).

const PROOF_STEP = "sh-fix-proof";
const FIX_PROOF_WAKE_STEP = "sh-wake-fix-proof";
const IMPLEMENTER_WAKE_STEP = "sh-wake-implementer";
// Any of these after the proof means a reviewer was asked or answered at a head the gate should have bounced.
const REVIEW_STEPS = ["sh-review-intent", "sh-review", "sh-review-panel", "sh-await-verdict"];

/** Same rule as the factory's `stepIdMatches`: the bare id or the id followed by `:`. */
function matches(id, stepId) {
  return stepId === id || stepId.startsWith(`${id}:`);
}

function isDoneStep(entry, id) {
  return entry.kind === "step" && entry.status === "done" && matches(id, entry.stepId);
}

function isReview(entry) {
  return entry.kind === "verdict" || (entry.kind === "step" && REVIEW_STEPS.some((id) => matches(id, entry.stepId)));
}

/**
 * The implementer wake row records its outcome, not its request, so `request` is null for every implementer wake
 * (view.ts `wakeEntry`); the `sh-wake-fix-proof` step before it is what marks it as a fix-proof wake, because only
 * `fixProofBounce` records that step. A FIX_FIRST wake shows as `request: "review"`.
 */
function isFixProofWake(entry) {
  return entry.kind === "wake" && matches(IMPLEMENTER_WAKE_STEP, entry.stepId) && entry.outcome === "woken" && (entry.request === null || entry.request === "fix-proof");
}

function violations(after) {
  const failures = [];
  for (const entry of after.filter(isReview)) failures.push(`reviewer spawned after the proof: ${entry.kind} ${entry.stepId}`);
  for (const entry of after.filter((e) => e.kind === "wake" && e.request === "review")) failures.push(`review-kind wake after the proof: ${entry.stepId}`);
  return failures;
}

function missingWake(entries, proofAt, after) {
  const marker = after.findIndex((entry) => isDoneStep(entry, FIX_PROOF_WAKE_STEP));
  const woken = marker !== -1 && after.slice(marker + 1).some(isFixProofWake);
  if (woken) return { pending: false, failures: [] };
  // A wake after an older head's proof answers that proof; only one with no proof of its own is out of order.
  const olderProof = entries.slice(0, proofAt).findLastIndex((entry) => entry.kind === "step" && matches(PROOF_STEP, entry.stepId));
  const early = entries.slice(olderProof + 1, proofAt).some((entry) => isDoneStep(entry, FIX_PROOF_WAKE_STEP) || isFixProofWake(entry));
  return early ? { pending: false, failures: ["fix-proof wake recorded before the proof at this head, none after it"] } : { pending: true, failures: [] };
}

/** `{ ok, pending, failures }`: pending while the proof at `head` has not finished or its wake has not been recorded yet. */
export function checkSendBack(entries, head) {
  const proofId = `${PROOF_STEP}:${head}`;
  const proofAt = entries.findIndex((entry) => entry.kind === "step" && entry.stepId === proofId);
  if (proofAt === -1 || entries[proofAt].status !== "done") return { ok: false, pending: true, failures: [] };
  const after = entries.slice(proofAt + 1);
  const failures = violations(after);
  const wake = missingWake(entries, proofAt, after);
  failures.push(...wake.failures);
  const pending = failures.length === 0 && wake.pending;
  return { ok: failures.length === 0 && !pending, pending, failures };
}
