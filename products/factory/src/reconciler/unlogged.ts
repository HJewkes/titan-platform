import type { BackstopCommit, BackstopSnapshot } from "@titan-design/github";
import type { BotActionKind } from "../bot-intent.js";

/** `id` names the action in the alarm and its not-factory mark; `subject` is the key its intent row would carry. */
interface BotAction {
  kind: BotActionKind;
  id: string;
  subject: string;
}

/** GraphQL names an app's bot user without the `[bot]` suffix REST adds, and GitHub logins ignore case. */
const normalLogin = (login: string): string => login.replace(/\[bot\]$/i, "").toLowerCase();

/**
 * TP-3094 C7: every bot write the snapshot shows. Reviews, statuses and merges count when the bot wrote them; a
 * `shepherd-train/**` head counts whoever pushed it, since only the factory may push there.
 */
export function botActions(snapshot: BackstopSnapshot, botLogin: string): BotAction[] {
  const bot = normalLogin(botLogin);
  const byBot = (login: string | null | undefined): boolean => login != null && normalLogin(login) === bot;
  const reviews = snapshot.open.flatMap((pr) =>
    pr.reviews
      .filter((review) => byBot(review.author?.login))
      .map((review): BotAction => ({ kind: "review", id: String(review.databaseId), subject: `${pr.number}@${review.commit?.oid ?? "unknown"}` })),
  );
  const commits = [...snapshot.open.flatMap((pr) => (pr.head ? [pr.head] : [])), ...snapshot.main.commits];
  const merges = snapshot.done.filter((pr) => pr.merged && byBot(pr.mergedBy)).map((pr): BotAction => ({ kind: "merge", id: String(pr.number), subject: String(pr.number) }));
  const trains = snapshot.trains.map((train): BotAction => ({ kind: "train-push", id: `${train.ref}@${train.oid}`, subject: `${train.ref}@${train.oid}` }));
  return [...reviews, ...botStatuses(commits, byBot), ...merges, ...trains];
}

function botStatuses(commits: BackstopCommit[], byBot: (login: string | null | undefined) => boolean): BotAction[] {
  const seen = new Map<string, BotAction>();
  for (const commit of commits) {
    for (const context of commit.contexts) {
      if (context.kind !== "status" || !byBot(context.creator)) continue;
      const id = `${commit.oid}/${context.context}`;
      seen.set(id, { kind: "status", id, subject: id });
    }
  }
  return [...seen.values()];
}

/** The actions no intent row names; the match is on kind and subject together. */
export function unloggedActions(actions: BotAction[], hasIntent: (kind: BotActionKind, subject: string) => boolean): BotAction[] {
  return actions.filter((action) => !hasIntent(action.kind, action.subject));
}
