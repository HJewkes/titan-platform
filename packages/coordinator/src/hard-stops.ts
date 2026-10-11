import type { HardStopClass } from "./charter-policy.js";

export interface HardStop {
  name: HardStopClass;
  pattern: RegExp;
}

// The first nine patterns are ported verbatim, in their order, from the burndown scorer's
// detector, which also covers every action its eligibility check reserves for a person;
// their order is the order hits are reported in. The last three close the classes that
// neither copy detected. A pattern only ever widens: a missed hard stop is worse than a
// task scored as stop-short by mistake.
export const HARD_STOPS: readonly HardStop[] = Object.freeze([
  {
    name: "broker-restart",
    pattern: /\brestart(s|ed|ing)? (the )?broker\b|\bbroker restart\b|restart window/i,
  },
  { name: "deploy", pattern: /\bdeploy(s|ed|ing)?\b|\bwrangler\b/i },
  { name: "launchd-install", pattern: /launchd install|burndown install/i },
  { name: "force-push", pattern: /force-push|reset --hard/i },
  { name: "config-edit", pattern: /CLAUDE\.md|settings\.json|~\/\.agent-chat\//i },
  { name: "spend-money", pattern: /\b(purchase|pay for|spend money|submit (the )?order)\b/i },
  {
    name: "npm-publish",
    pattern: /\bnpm publish|first publish|publish(es|ed)? to npm|version packages/i,
  },
  { name: "ruleset-write", pattern: /ruleset|branch protection/i },
  { name: "tag-move", pattern: /\bmove (the )?v1\b|cut a (release )?tag|tag push/i },
  {
    name: "dotfiles-merge",
    pattern:
      /\b(merg(e|es|ed|ing)|push(es|ed|ing)?)\b[^.;\n]*\bdotfiles\b|\bdotfiles\b[^.;\n]*\b(merg(e|es|ed|ing)|push(es|ed|ing)?)\b|chezmoi apply/i,
  },
  {
    name: "third-party-message",
    pattern:
      /\b(e-?mail|message|text|dm|contact|write to) (the |a |an |our )?(vendor|supplier|client|customer|landlord|contractor|recruiter|doctor|support|third[- ]party)\b|\bsend (an? |the )?(e-?mail|sms|text message|telegram message|calendar invite)s?\b|\bcalendar invites?\b/i,
  },
  {
    name: "personal-data",
    pattern:
      /\blab results?\b|\bmedical\b|\bhealth (data|records?)\b|\bdiagnos[ie]s\b|\bprescriptions?\b|\bbank statements?\b|\btax returns?\b|\bfinancial (data|records?|statements?)\b|\bfamily (data|records?)\b/i,
  },
]);

/**
 * The hard-stop classes whose pattern matches `text`, in `HARD_STOPS` order. Pass `among`
 * (for example the charter's `hard_stops`) to report only those classes.
 */
export function hardStopsIn(
  text: string | null | undefined,
  among?: Iterable<string>,
): HardStopClass[] {
  const body = text ?? "";
  const wanted = among === undefined ? undefined : new Set(among);
  return HARD_STOPS.filter(
    (stop) => (wanted === undefined || wanted.has(stop.name)) && stop.pattern.test(body),
  ).map((stop) => stop.name);
}
