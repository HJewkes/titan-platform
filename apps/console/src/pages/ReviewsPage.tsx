import type { ReactNode } from "react";
import {
  Alert,
  DateTime,
  EmptyState,
  HStack,
  Link,
  Pill,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Typography,
  VStack,
} from "@titan-design/react-ui";
import type { ReviewSummary } from "../../server/reviews.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";

const COUNT_WIDTH = 64;
const DATE_WIDTH = 160;
/** The plan's phone line: a table needs at least this much width, so below it each review stacks into a card. */
const WIDE = "hidden min-[600px]:block";
const NARROW = "min-[600px]:hidden";

/** Newest first by the last headless run; a review with no runs sorts after every dated one, then by name. */
function byLastRun(reviews: readonly ReviewSummary[]): ReviewSummary[] {
  return [...reviews].sort((a, b) => {
    const left = a.cost?.lastTs ?? "";
    const right = b.cost?.lastTs ?? "";
    return left === right ? a.name.localeCompare(b.name) : right.localeCompare(left);
  });
}

/** Every repo review in the reviews dir, with a banner naming each file that did not parse. */
export function ReviewsPage(): ReactNode {
  const list = useQuery("reviews.list");
  if (list.status === "loading") return <Spinner size="sm" label="Loading reviews" />;
  if (list.data === undefined) return <Alert status="error" message={`Could not load reviews: ${list.error.message}`} />;
  const { reviews, gaps } = list.data;
  const ordered = byLastRun(reviews);
  return (
    <VStack gap={4}>
      <GapBanner gaps={gaps} />
      {ordered.length === 0 ? (
        <EmptyState title="No repo reviews yet" description="A review is a folder with a README.md under the reviews dir." />
      ) : (
        <>
          <div className={WIDE}>
            <ReviewsTable reviews={ordered} />
          </div>
          <div className={NARROW}>
            <ReviewsStack reviews={ordered} />
          </div>
        </>
      )}
    </VStack>
  );
}

/** A file that failed to read stays visible as a line here, so a review never silently loses data. */
export function GapBanner({ gaps }: { gaps: readonly string[] }): ReactNode {
  if (gaps.length === 0) return null;
  return (
    <Alert status="warning" testID="review-gaps" message={gaps.length === 1 ? "1 file did not read" : `${gaps.length} files did not read`}>
      <VStack gap={1}>
        {gaps.map((gap) => (
          <Typography key={gap} variant="caption">
            {gap}
          </Typography>
        ))}
      </VStack>
    </Alert>
  );
}

function ReviewsTable({ reviews }: { reviews: readonly ReviewSummary[] }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Review</TableHeaderCell>
          <TableHeaderCell>State</TableHeaderCell>
          <TableHeaderCell width={DATE_WIDTH}>Last run</TableHeaderCell>
          <TableHeaderCell width={COUNT_WIDTH} align="right">P1</TableHeaderCell>
          <TableHeaderCell width={COUNT_WIDTH} align="right">P2</TableHeaderCell>
          <TableHeaderCell width={COUNT_WIDTH * 1.5} align="right">Cost</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {reviews.map((review) => (
          <ReviewRow key={review.name} review={review} />
        ))}
      </TableBody>
    </Table>
  );
}

function ReviewRow({ review }: { review: ReviewSummary }): ReactNode {
  return (
    <TableRow testID={`review-row-${review.name}`}>
      <TableCell>
        <ReviewName review={review} />
      </TableCell>
      <TableCell>
        <ReviewState review={review} />
      </TableCell>
      <TableCell width={DATE_WIDTH}>
        <LastRun review={review} />
      </TableCell>
      <TableCell width={COUNT_WIDTH} align="right">{String(review.p1)}</TableCell>
      <TableCell width={COUNT_WIDTH} align="right">{String(review.p2)}</TableCell>
      <TableCell width={COUNT_WIDTH * 1.5} align="right">{costText(review)}</TableCell>
    </TableRow>
  );
}

function ReviewsStack({ reviews }: { reviews: readonly ReviewSummary[] }): ReactNode {
  return (
    <VStack>
      {reviews.map((review) => (
        <VStack key={review.name} gap={1} className="border-b border-divider px-inset-md py-inset-sm" testID={`review-card-${review.name}`}>
          <ReviewName review={review} />
          <ReviewState review={review} />
          <HStack gap={3} align="center" wrap>
            <Typography variant="caption" color="secondary">{`P1 ${review.p1} · P2 ${review.p2} · ${costText(review)}`}</Typography>
            <LastRun review={review} />
          </HStack>
        </VStack>
      ))}
    </VStack>
  );
}

function ReviewName({ review }: { review: ReviewSummary }): ReactNode {
  return (
    <VStack gap={0}>
      <Link color="primary" onPress={() => open({ view: "reviews", id: review.name })}>
        {review.name}
      </Link>
      {review.remote ? <Typography variant="caption" color="secondary">{remoteSlug(review.remote)}</Typography> : null}
    </VStack>
  );
}

/** The README's status is often stale, so it shows dimmed beside the derived state rather than as it. */
export function ReviewState({ review }: { review: ReviewSummary }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap>
      <Pill variant="subtle" size="xs">{review.state}</Pill>
      {review.label ? <Pill variant="outline" size="xs">{review.label}</Pill> : null}
      {review.readmeStatus ? <Typography variant="caption" color="tertiary">{review.readmeStatus}</Typography> : null}
    </HStack>
  );
}

function LastRun({ review }: { review: ReviewSummary }): ReactNode {
  return <DateTime value={review.cost?.lastTs ?? undefined} format="date" variant="caption" color="secondary" fallback="no runs" />;
}

export function costText(review: ReviewSummary): string {
  return review.cost ? `$${review.cost.usd.toFixed(2)}` : "–";
}

/** `https://github.com/owner/repo(.git)` reads as `owner/repo`; any other remote shows whole. */
export function remoteSlug(remote: string): string {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remote);
  return match?.[1] ?? remote;
}
