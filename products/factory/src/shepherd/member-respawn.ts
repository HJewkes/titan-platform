/**
 * A panel member whose spawn the gate admitted but whose agent never registered is infra, not a reviewer that withheld its
 * verdict (TP-6831). It is spawned once more under a fresh name; still missing, its round reads as not-started.
 */

/** The step-id tag of a member's one re-spawn, after its shape. */
export const RESPAWN_TAG = "respawn";

/** The ask went through and no session ever showed on the roster by the start deadline. */
export const unseenAtDispatch = (dispatched: { kind: string }): boolean => dispatched.kind === "none" && "unseen" in dispatched && dispatched.unseen === true;

/** The wait ended on a reviewer no roster read listed and whose transcript stayed empty. */
export const unregisteredAtAwait = (awaited: { kind: string }): boolean => awaited.kind === "none" && "unregistered" in awaited && awaited.unregistered === true;

/** The next name in the member's `-<k>` series, so cleanup still finds it as this PR's reviewer and no row a dead spawn left is adopted. */
export function respawnName(name: string): string {
  const numbered = /^(.*)-(\d+)$/.exec(name);
  return numbered ? `${numbered[1]}-${Number(numbered[2]) + 1}` : `${name}-2`;
}
