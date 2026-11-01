import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, ButtonText, Card, CardContent, Table, TableBody, TableCell, TableRow, Typography, VStack } from "@titan-design/react-ui";
import type { Question } from "../../server/round-schema.js";
import { choicesOf } from "./RoundQuestion.js";
import { ROUND_KEYS, ROUND_KEY_GROUPS, pressed, type RoundKey } from "./round-keys.js";
import { onControl, typedInto } from "./typed-into.js";
import { PHONE_TAP } from "./phone.js";

/** Calls `act` on each press of `binding` outside a field; `act` absent, the key is left to the browser. */
function useRoundKey(binding: RoundKey, act: (() => void) | undefined, skip: (target: EventTarget | null) => boolean = typedInto): void {
  useEffect(() => {
    if (act === undefined) return;
    const onKey = (event: KeyboardEvent): void => {
      if (!pressed(binding, event) || skip(event.target)) return;
      event.preventDefault();
      act();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [binding, act, skip]);
}

const typedOrControl = (target: EventTarget | null): boolean => typedInto(target) || onControl(target);

/** Cmd/Ctrl+Enter opens the check-before-send screen, while the round can still be sent. */
export function useReviewKey(review: (() => void) | undefined): void {
  useRoundKey(ROUND_KEYS.check, review);
}

/** Enter takes the `advance` step, unless the owner is typing or Enter is already pressing a focused button or link. */
export function useAdvanceKey(advance: (() => void) | undefined): void {
  useRoundKey(ROUND_KEYS.advance, advance, typedOrControl);
}

/** The open question after `from` in round order, wrapping round to the first open one. */
function nextOpen(all: readonly Question[], open: readonly Question[], from: string | undefined): Question | undefined {
  const at = all.findIndex((question) => question.id === from);
  return open.find((question) => all.indexOf(question) > at) ?? open[0];
}

interface Advancing {
  all: readonly Question[];
  open: readonly Question[];
  activeId: string | undefined;
  land: (questionId: string) => void;
  review: (() => void) | undefined;
}

/**
 * The step Enter takes. A text question never becomes the active one, so the step remembers where it landed: a second
 * Enter moves on from there rather than landing on the same open text question again.
 */
export function useAdvance({ all, open, activeId, land, review }: Advancing): () => void {
  const landed = useRef<{ activeId: string | undefined; id: string } | undefined>(undefined);
  return useCallback(() => {
    const last = landed.current;
    const from = last !== undefined && last.activeId === activeId ? last.id : activeId;
    const next = nextOpen(all, open, from);
    if (next === undefined) return review?.();
    landed.current = { activeId: choicesOf(next).length > 0 ? next.id : activeId, id: next.id };
    land(next.id);
  }, [all, open, activeId, land, review]);
}

/** A "Keys" button, and `?`, show every round key from the one table its handlers read. */
export function RoundKeyLegend(): ReactNode {
  const [shown, setShown] = useState(false);
  const toggle = useCallback(() => setShown((current) => !current), []);
  useRoundKey(ROUND_KEYS.legend, toggle);
  return (
    <VStack gap={2}>
      <Button size="sm" variant="ghost" color="secondary" aria-expanded={shown} onPress={toggle} className={PHONE_TAP} testID="round-keys-toggle"><ButtonText>Keys</ButtonText></Button>
      {shown ? <LegendTable /> : null}
    </VStack>
  );
}

function LegendTable(): ReactNode {
  const keys: readonly RoundKey[] = Object.values(ROUND_KEYS);
  return (
    <Card variant="outline" testID="round-key-legend">
      <CardContent>
        <VStack gap={3}>
          {ROUND_KEY_GROUPS.map((group) => (
            <VStack key={group} gap={1}>
              <Typography variant="microLabel" color="secondary">{group.toUpperCase()}</Typography>
              <Table density="dense">
                <TableBody>
                  {keys.filter((each) => each.group === group).map((each) => (
                    <TableRow key={`${each.label} ${each.does}`}>
                      <TableCell width={160}>{each.label}</TableCell>
                      <TableCell>{each.does}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </VStack>
          ))}
        </VStack>
      </CardContent>
    </Card>
  );
}
