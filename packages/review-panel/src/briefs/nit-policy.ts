/** The PR description is author text, so it must never be able to make a blocking finding disappear. */
export const NIT_POLICY_EXEMPTION =
  "This never covers a blocking item: a stated gap that leaves the task's done-when unmet, or a pre-existing defect this PR now relies on, is still blocking whatever the PR description says.";

/** An audit of review text found about a sixth of it was nits and noise, and nit follow-ups were filed as tasks nobody needed (TP-6471). */
export const NIT_POLICY_RULE =
  "Of the notes that would not block, leave out cosmetic ones, ones on behaviour that was already on the base before this PR, and ones on a gap the PR description already states, unless one would mislead a reader of the code. " +
  `File no cosmetic note as a follow-up; a stated gap that is not cosmetic may still be one. ${NIT_POLICY_EXEMPTION}`;
