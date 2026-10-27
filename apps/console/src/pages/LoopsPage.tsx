import { useCallback, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { Alert, Badge, BadgeText, HStack, Select, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { BoardLoop, LoopBoard, LoopStatus } from "../../server/loop-board.js";
import { useInvalidate, useQuery } from "../data/rpc.js";
import { useAnswerSource } from "../data/submit.js";
import { LoopCard } from "./LoopCard.js";
import { applyMove, filterLoops, groupByTier, TIER_ROWS, type LoopFilters, type Move, type TierRow } from "./loop-tiers.js";

const STATUS_OPTIONS = (["LOST", "STALLED", "MISSING", "ACTIVE", "DONE"] satisfies LoopStatus[]).map((status) => ({ value: status, label: status }));
const DRAG_TYPE = "text/plain";
/** The exported page has no daemon to write through. */
const SNAPSHOT_REASON = "this is a saved copy of the page";

/** The open-loops tier list: every loop in its advisory tier, re-tiered by drag or by each card's Move to menu. */
export function LoopsPage(): ReactNode {
  const read = useQuery("work.loops");
  if (read.status === "loading") return <Spinner size="sm" label="Loading open loops" />;
  if (read.data === undefined) return <Alert status="error" message={`Could not load open loops: ${read.error.message}`} />;
  const { board, unavailable, tierWritesOff } = read.data;
  if (board === null) return <Alert status="info" testID="loops-unavailable" message={`The open-loops board is not served by this host's active-work daemon: ${unavailable ?? "unknown reason"}.`} />;
  return <LoopBoardView board={board} tierWritesOff={tierWritesOff} />;
}

/** Each move shows at once and holds until the next read replaces the board, or comes back out when the console refuses it. */
function useTierMoves(loops: readonly BoardLoop[]) {
  const source = useAnswerSource();
  const invalidate = useInvalidate();
  const [pending, setPending] = useState<{ base: readonly BoardLoop[]; moves: readonly Move[] }>({ base: loops, moves: [] });
  const [refusal, setRefusal] = useState<string | null>(null);
  const moves = pending.base === loops ? pending.moves : [];
  const move = useCallback(
    async (next: Move) => {
      if (source === null) return;
      setRefusal(null);
      setPending((held) => ({ base: loops, moves: [...(held.base === loops ? held.moves : []), next] }));
      const envelope = await source.call("work.loop-tier", { id: next.id, tier: next.to, ...(next.before === undefined ? {} : { before: next.before }) });
      if (envelope.ok) return invalidate(["work.loops"]);
      setPending((held) => ({ ...held, moves: held.moves.filter((queued) => queued !== next) }));
      setRefusal(envelope.error);
    },
    [source, invalidate, loops],
  );
  const shown = useMemo(() => moves.reduce(applyMove, [...loops]), [loops, moves]);
  return { shown, move, refusal, readOnlyReason: source === null ? SNAPSHOT_REASON : null };
}

function LoopBoardView({ board, tierWritesOff }: { board: LoopBoard; tierWritesOff: string | null }): ReactNode {
  const { shown, move, refusal, readOnlyReason } = useTierMoves(board.loops);
  const [filters, setFilters] = useState<LoopFilters>({ initiative: null, status: null });
  const reason = readOnlyReason ?? tierWritesOff;
  const groups = groupByTier(filterLoops(shown, filters));
  const onMove = reason === null ? (next: Move) => void move(next) : null;
  return (
    <VStack gap={6}>
      <Typography variant="body1" color="secondary">Tiers are advisory: coordinators weigh them but choose freely. Drag a card to another tier, or use its Move to menu.</Typography>
      <BoardNotices board={board} reason={reason} refusal={refusal} />
      <BoardFilters loops={board.loops} filters={filters} onChange={setFilters} />
      {TIER_ROWS.map((row) => (
        <TierSection key={row.key} row={row} loops={groups[row.key]} onMove={onMove} />
      ))}
    </VStack>
  );
}

function BoardNotices({ board, reason, refusal }: { board: LoopBoard; reason: string | null; refusal: string | null }): ReactNode {
  return (
    <>
      {reason !== null ? <Alert status="info" testID="loops-read-only" message={`Tiers are read-only here: ${reason}.`} /> : null}
      {refusal !== null ? <Alert status="warning" testID="loops-move-refused" message={`The move was not saved: ${refusal}`} /> : null}
      {board.ledger === null ? <Alert status="info" message="No loop ledger is imported yet, so only session loops show." /> : null}
      {board.warnings.length > 0 ? (
        <Alert status="warning" testID="loops-warnings" message={`${board.warnings.length} ledger ${board.warnings.length === 1 ? "row was" : "rows were"} skipped`}>
          <VStack gap={1}>
            {board.warnings.map((warning) => (
              <Typography key={warning} variant="caption">{warning}</Typography>
            ))}
          </VStack>
        </Alert>
      ) : null}
    </>
  );
}

function BoardFilters({ loops, filters, onChange }: { loops: readonly BoardLoop[]; filters: LoopFilters; onChange: (next: LoopFilters) => void }): ReactNode {
  const initiatives = useMemo(() => [...new Set(loops.map((loop) => loop.initiative))].sort().map((slug) => ({ value: slug, label: slug })), [loops]);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:max-w-xl">
      <Select accessibilityLabel="Initiative" placeholder="Any initiative" value={filters.initiative} options={initiatives} onChange={(initiative) => onChange({ ...filters, initiative })} />
      <Select accessibilityLabel="Status" placeholder="Any status" value={filters.status} options={STATUS_OPTIONS} onChange={(status) => onChange({ ...filters, status })} />
    </div>
  );
}

/** The card a drop lands on is the one the moved card goes ahead of; a drop on open space goes to the end. */
function droppedBefore(event: DragEvent<HTMLElement>, id: string): string | undefined {
  const target = event.target instanceof Element ? event.target.closest("[data-loop-id]")?.getAttribute("data-loop-id") : null;
  return target && target !== id ? target : undefined;
}

interface TierSectionProps {
  row: TierRow;
  loops: readonly BoardLoop[];
  onMove: ((move: Move) => void) | null;
}

function TierSection({ row, loops, onMove }: TierSectionProps): ReactNode {
  const [isOver, setIsOver] = useState(false);
  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    setIsOver(false);
    const id = event.dataTransfer.getData(DRAG_TYPE);
    if (id && onMove) onMove({ id, to: row.key, before: droppedBefore(event, id) });
  };
  const dropProps = onMove
    ? { onDragOver: (event: DragEvent<HTMLElement>) => (event.preventDefault(), setIsOver(true)), onDragLeave: () => setIsOver(false), onDrop }
    : {};
  return (
    <section aria-label={`Tier ${row.label}, advisory`} data-testid={`loop-tier-${row.key}`} className={`rounded-lg border p-4 sm:p-6 ${isOver ? "border-dashed border-border-input-focus" : "border-divider"}`} {...dropProps}>
      <VStack gap={4}>
        <TierHeading row={row} count={loops.length} />
        {loops.length === 0 ? (
          <Typography variant="body2" color="tertiary">No loops in this tier.</Typography>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {loops.map((loop) => (
              <div key={loop.id} data-loop-id={loop.id} draggable={onMove !== null} onDragStart={(event) => event.dataTransfer.setData(DRAG_TYPE, loop.id)} className="min-w-0">
                <LoopCard loop={loop} onMove={onMove && ((to) => onMove({ id: loop.id, to }))} />
              </div>
            ))}
          </div>
        )}
      </VStack>
    </section>
  );
}

function TierHeading({ row, count }: { row: TierRow; count: number }): ReactNode {
  return (
    <HStack gap={3} align="center" wrap>
      <Typography variant="h6" role="heading" aria-level={2}>{row.label}</Typography>
      <Badge variant="subtle" size="sm">
        <BadgeText>{String(count)}</BadgeText>
      </Badge>
      <Typography variant="body2" color="secondary">{`Advisory · ${row.hint}`}</Typography>
    </HStack>
  );
}
