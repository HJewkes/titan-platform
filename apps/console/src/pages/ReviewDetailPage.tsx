import type { ReactNode } from "react";
import {
  Alert,
  BreadcrumbItem,
  Breadcrumbs,
  Collapse,
  CollapseButton,
  CollapseContent,
  HStack,
  Heading,
  MarkdownProse,
  Pill,
  Spinner,
  Typography,
  VStack,
} from "@titan-design/react-ui";
import type { getReview } from "../../server/reviews.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { ReviewFindings } from "./ReviewFindings.js";
import { GapBanner, ReviewState, costText, remoteSlug } from "./ReviewsPage.js";

type ReviewDetail = Awaited<ReturnType<typeof getReview>>;
type ClaimRow = ReviewDetail["claims"][number];

const SHORT_SHA = 7;
/** The claims that undercut the review read first; any status outside the list follows them. */
const CLAIM_STATUS_ORDER = ["refuted", "partial", "not-found", "verified"];

/** One review: header, gap lines, the summary, the judged findings and the audited claims, each collapsible. */
export function ReviewDetailPage({ name }: { name: string }): ReactNode {
  const detail = useQuery("reviews.get", { name });
  if (detail.status === "loading") return <Spinner size="sm" label="Loading review" />;
  if (detail.data === undefined) return <Framed name={name}><Alert status="error" message={`Could not load ${name}: ${detail.error.message}`} /></Framed>;
  const review = detail.data;
  return (
    <Framed name={name}>
      <ReviewHeading detail={review} />
      <GapBanner gaps={review.gaps} />
      <Fold title="Summary" defaultIsOpen>
        <SummaryBody detail={review} />
      </Fold>
      <Fold title={`Findings (${review.topics.length})`} defaultIsOpen>
        <ReviewFindings topics={review.topics} />
      </Fold>
      <Fold title={`Facts and claims (${review.claims.length})`}>
        <ClaimGroups claims={review.claims} />
      </Fold>
    </Framed>
  );
}

function Framed({ name, children }: { name: string; children: ReactNode }): ReactNode {
  return (
    <VStack gap={4}>
      <Breadcrumbs>
        <BreadcrumbItem onPress={() => open({ view: "reviews" })}>Reviews</BreadcrumbItem>
        <BreadcrumbItem isCurrentPage>{name}</BreadcrumbItem>
      </Breadcrumbs>
      {children}
    </VStack>
  );
}

function Fold({ title, defaultIsOpen = false, children }: { title: string; defaultIsOpen?: boolean; children: ReactNode }): ReactNode {
  return (
    <Collapse defaultIsOpen={defaultIsOpen}>
      <CollapseButton>
        <Typography variant="subtitle1">{title}</Typography>
      </CollapseButton>
      <CollapseContent>{children}</CollapseContent>
    </Collapse>
  );
}

function ReviewHeading({ detail }: { detail: ReviewDetail }): ReactNode {
  const { review, coverage } = detail;
  const facts = [
    review.remote ? remoteSlug(review.remote) : null,
    review.head ? `pin ${review.head.slice(0, SHORT_SHA)}` : "no pin",
    `cost ${costText(review)}`,
    `P1 ${review.p1} · P2 ${review.p2}`,
  ].filter((fact) => fact !== null);
  return (
    <VStack gap={1}>
      <Heading level={3}>{review.name}</Heading>
      <ReviewState review={review} />
      <Typography variant="caption" color="secondary">{facts.join(" · ")}</Typography>
      {coverage ? <Typography variant="caption" color="secondary">{coverage}</Typography> : null}
    </VStack>
  );
}

function SummaryBody({ detail }: { detail: ReviewDetail }): ReactNode {
  const { summary, recommendations } = detail;
  if (summary === null) return <Typography variant="body2" color="secondary">This review has no SUMMARY.md yet.</Typography>;
  return (
    <VStack gap={3}>
      {summary.truncated ? <Alert status="info" size="compact" message={`Showing the first 256 KB of ${Math.round(summary.bytes / 1024)} KB.`} /> : null}
      {recommendations && recommendations.length > 0 ? (
        <HStack gap={2} align="center" wrap>
          <Typography variant="caption" color="secondary">Recommends</Typography>
          {recommendations.map((item) => (
            <Pill key={`${item.id}-${item.line}`} variant="subtle" size="xs">{item.id}</Pill>
          ))}
        </HStack>
      ) : null}
      <MarkdownProse body={summary.markdown} testID="review-summary" />
    </VStack>
  );
}

function statusRank(status: string): number {
  const at = CLAIM_STATUS_ORDER.indexOf(status);
  return at === -1 ? CLAIM_STATUS_ORDER.length : at;
}

function ClaimGroups({ claims }: { claims: readonly ClaimRow[] }): ReactNode {
  if (claims.length === 0) return <Typography variant="body2" color="secondary">No claims audited.</Typography>;
  const statuses = [...new Set(claims.map((claim) => claim.status))].sort((a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b));
  return (
    <VStack gap={4}>
      {statuses.map((status) => (
        <VStack key={status} gap={2} testID={`claims-${status}`}>
          <Typography variant="overline" color="secondary">{status}</Typography>
          {claims.filter((claim) => claim.status === status).map((claim) => (
            <VStack key={claim.line} gap={0} className="border-b border-divider pb-inset-sm">
              <Typography variant="body2">{claim.claim}</Typography>
              <Typography variant="caption" color="secondary">{`${claim.id} · ${claim.source}${claim.evidence ? ` · ${claim.evidence}` : ""}`}</Typography>
            </VStack>
          ))}
        </VStack>
      ))}
    </VStack>
  );
}
