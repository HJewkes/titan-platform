import { useEffect, type ReactNode } from "react";
import { HStack, Link, Typography } from "@titan-design/react-ui";
import type { RoundSummary } from "../../server/rounds.js";
import { useQuery } from "../data/rpc.js";
import { href, open, type Route } from "../router.js";
import { setPositionOf, setQuery, type SetPosition } from "./round-set.js";

const roundRoute = (round: RoundSummary): Route => ({ view: "rounds", id: round.id });
const setRoute = (set: string): Route => ({ view: "rounds", query: setQuery(set) });

/** Prev, up and next for one round, read from `rounds.list`; while that loads or fails the page shows no nav rather than a wrong one. */
export function RoundSetNav({ id }: { id: string }): ReactNode {
  const list = useQuery("rounds.list");
  if (list.data === undefined) return null;
  return <RoundSetLinks rounds={list.data.rounds} id={id} />;
}

export function RoundSetLinks({ rounds, id }: { rounds: readonly RoundSummary[]; id: string }): ReactNode {
  const position = setPositionOf(rounds, id);
  useSetKeys(position);
  if (position === null) return null;
  return (
    <HStack gap={3} align="center" wrap testID="round-set-nav">
      <StepLink step="prev" round={position.prev} />
      <Link color="primary" href={href(setRoute(position.set))} onPress={() => open(setRoute(position.set))}>
        {`${position.set} · ${position.index} of ${position.size}`}
      </Link>
      <StepLink step="next" round={position.next} />
      {position.size > 1 ? <KeyHint /> : null}
    </HStack>
  );
}

const stepText = (step: "prev" | "next", id: string | null): string => {
  if (step === "prev") return id === null ? "← Prev" : `← Prev: ${id}`;
  return id === null ? "Next →" : `Next: ${id} →`;
};

/** An end of the set keeps its label, disabled, so the row does not shift between rounds. */
function StepLink({ step, round }: { step: "prev" | "next"; round: RoundSummary | null }): ReactNode {
  if (round === null) return <Link isDisabled>{stepText(step, null)}</Link>;
  return (
    <Link color="primary" href={href(roundRoute(round))} onPress={() => open(roundRoute(round))}>
      {stepText(step, round.id)}
    </Link>
  );
}

/** A phone has no [ or ] key to press, so the hint shows from `md` up. */
function KeyHint(): ReactNode {
  return (
    <span className="hidden md:inline">
      <Typography variant="caption" color="secondary">[ and ] step through the set</Typography>
    </span>
  );
}

function typedInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** `[` and `]` open the previous and next round, unless a modifier is held or the owner is typing in a field. */
function useSetKeys(position: SetPosition | null): void {
  const prev = position?.prev ?? null;
  const next = position?.next ?? null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || typedInto(event.target)) return;
      const target = event.key === "[" ? prev : event.key === "]" ? next : null;
      if (target === null) return;
      event.preventDefault();
      open(roundRoute(target));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next]);
}
