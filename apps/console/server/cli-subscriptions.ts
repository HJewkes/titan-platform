/**
 * `titan-console rounds subscribe | unsubscribe | list-subscriptions`: local verbs over `round-subscriptions.ts`, so a
 * seat can hear of answers to rounds it did not file. Like `decisions file`, they need no running console and the seat
 * defaults to `AGENT_CHAT_NAME`; nothing that reaches `/rpc` can change who is told.
 */
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { runVerb, valueFlags } from "./cli-rounds.js";
import type { ConsoleConfig } from "./config.js";
import { listSubscriptions, subscribe, subscriptionsDirOf, unsubscribe, type Subscription } from "./round-subscriptions.js";

type SubscriptionVerb = "subscribe" | "unsubscribe" | "list-subscriptions";

interface SubscriptionArgs {
  verb: SubscriptionVerb;
  targets: string[];
  seat: string | null;
  json: boolean;
}

const VERBS: readonly SubscriptionVerb[] = ["subscribe", "unsubscribe", "list-subscriptions"];
const isVerb = (arg: string | undefined): arg is SubscriptionVerb => VERBS.some((verb) => verb === arg);

/**
 * `rounds subscribe|unsubscribe <target>... [--seat <name>] [--json]` and `rounds list-subscriptions [--seat <name>] [--json]`,
 * flags anywhere after the verb; null for anything else. Only `list-subscriptions` reads no `AGENT_CHAT_NAME`, so with no
 * `--seat` it lists every seat.
 */
export function subscriptionArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): SubscriptionArgs | null {
  const verb = argv[1];
  if (argv[0] !== "rounds" || !isVerb(verb)) return null;
  const split = valueFlags(argv.slice(2));
  if (split === null || split.values.has("--initiative")) return null;
  const targets = split.others.filter((arg) => arg !== "--json");
  const json = split.others.length - targets.length;
  const listing = verb === "list-subscriptions";
  if (json > 1 || targets.some((arg) => arg.startsWith("--")) || (listing ? targets.length > 0 : targets.length === 0)) return null;
  const seat = split.values.get("--seat") ?? (listing ? null : env.AGENT_CHAT_NAME || null);
  return { verb, targets, seat, json: json === 1 };
}

const subscriptionLine = ({ seat, target, at }: Subscription): string => `${seat} ${target} ${at}`;

async function runSubscription(config: ConsoleConfig, { verb, targets, seat }: SubscriptionArgs): Promise<{ lines: string[]; result: unknown }> {
  const dir = subscriptionsDirOf(config.stateDir);
  if (verb === "list-subscriptions") {
    const subscriptions = (await listSubscriptions(dir)).filter((subscription) => seat === null || subscription.seat === seat);
    return { lines: subscriptions.length === 0 ? ["no subscriptions"] : subscriptions.map(subscriptionLine), result: subscriptions };
  }
  if (seat === null) throw failure(`${verb} refused: name the seat with --seat <name> (or set AGENT_CHAT_NAME)`, EXIT.USAGE);
  if (verb === "subscribe") {
    const outcomes = await subscribe(dir, seat, targets);
    return { lines: outcomes.map(({ target, created }) => `${created ? "subscribed" : "already subscribed"}: ${seat} ${target}`), result: { seat, outcomes } };
  }
  const outcomes = await unsubscribe(dir, seat, targets);
  return { lines: outcomes.map(({ target, removed }) => `${removed ? "unsubscribed" : "not subscribed"}: ${seat} ${target}`), result: { seat, outcomes } };
}

export async function subscriptionCli(config: ConsoleConfig, args: SubscriptionArgs): Promise<void> {
  await runVerb(
    () => runSubscription(config, args),
    ({ lines, result }) => (args.json ? JSON.stringify(result) : lines.join("\n")),
  );
}
