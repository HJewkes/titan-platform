/**
 * agent-chat's unlock table, ported from `src/broker/decisions.ts` and held to it by
 * `unlock.test.ts`. Every match errs towards the owner: a false positive costs one
 * answer, a false negative is an unlock decided by a model.
 */

/** Categories a decider may answer; everything else stays with the owner. */
export const DECIDABLE_CATEGORIES: readonly string[] = Object.freeze([
  "session_control",
  "agent_ops",
  "tech_design",
  "scope_priority",
]);

/** Categories that are themselves unlock-table rows, so no mode can raise them. */
export const UNLOCK_CATEGORIES: readonly string[] = Object.freeze(["merge_gate", "release_publish"]);

/** Deliberately broad: "release" also matches "release the claim", which is the safe direction. */
const UNLOCK_TABLE: readonly (readonly [string, RegExp])[] = [
  ["merge", /\bmerg(e|es|ed|ing)\b|\bsquash\b/i],
  ["publish or release", /\bpublish|\breleas(e|es|ed|ing)\b|\bnpm\b|\bchangeset|\btag push\b/i],
  ["deploy", /\bdeploy|\bwrangler\b|\blaunch(d|ctl)\b/i],
  [
    "money",
    /\b(pay|payment|purchase|buy|money|invoice|billing|subscription)\b|\bspend(ing)? (\$|money)|\b(place|submit) (an |the )?order\b|\$\d/i,
  ],
  [
    "external account",
    /\baccounts?\b|\boauth\b|\bpasskey|\botp\b|\b2fa\b|\bpassword|\bcredential|\bapi key|\blog ?in\b|\bsign ?in\b/i,
  ],
  ["deletion", /\bdelet(e|es|ed|ing|ion)\b|\brm -|\btrash|\bpurge|\bwipe|\bdestroy|--force\b|force-push|reset --hard/i],
  ["broker restart or cap lift", /\brestart|\bretire --force\b/i],
  ["publicity or sharing", /\bmake (it |this |the \w+ )?public\b|\bvisibility\b|\bshar(e|ing) (it |this )?with\b/i],
  ["third-party send", /\b(send|email|mail) (it |this )?to\b|\bcalendar invite/i],
  [
    "settings or policy edit",
    /claude\.md|settings(\.local)?\.json|~\/\.agent-chat|\b(edit|change|add|update)\b[^.?]*\b(hook|profile|permission)s?\b/i,
  ],
  ["permission prompt", /\bapprov(e|al)\b|\bendorse/i],
];

/** The unlock-table row a text touches, or undefined when it touches none. */
export function unlockTableRow(text: string): string | undefined {
  return UNLOCK_TABLE.find(([, pattern]) => pattern.test(text))?.[0];
}

export type UnlockCheck = { ok: true } | { ok: false; code: "not_decidable" | "unlock_table"; reason: string };

/** agent-chat's `checkDecision` minus its citation check: whether a decider may answer at all. */
export function checkUnlock(question: string, answer: string, category: string): UnlockCheck {
  if (!DECIDABLE_CATEGORIES.includes(category))
    return {
      ok: false,
      code: "not_decidable",
      reason: `category "${category}" is the owner's to answer; decidable: ${DECIDABLE_CATEGORIES.join(", ")}`,
    };
  const row = unlockTableRow(question) ?? unlockTableRow(answer);
  if (row !== undefined)
    return {
      ok: false,
      code: "unlock_table",
      reason: `this touches the unlock table (${row}); it stays with the owner`,
    };
  return { ok: true };
}
