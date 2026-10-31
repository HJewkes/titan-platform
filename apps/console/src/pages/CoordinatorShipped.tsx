import type { ReactNode } from "react";
import { Alert, HStack, Link, Section, SectionContent, SectionHeader, Skeleton, Typography, VStack } from "@titan-design/react-ui";
import { useQuery, type ServedCommands } from "../data/rpc.js";
import { openExternal } from "./homeLinks.js";
import { PHONE_TAP_LINK } from "./phone.js";

type ShippedResult = ServedCommands["coord.shipped"]["result"];
type PrRef = ShippedResult["merged"][number];
type Group = NonNullable<ShippedResult["digest"]>["groups"][number];
type DayArgs = ServedCommands["coord.shipped"]["args"];

const SKELETONS = 2;

/** The day's merged PRs grouped into themes with a summary each, from the digest `titan-console shipped build` caches; unbuilt, the plain merged list. */
export function CoordinatorShipped({ day }: { day: DayArgs }): ReactNode {
  const shipped = useQuery("coord.shipped", day);
  return (
    <Section>
      <SectionHeader title="What shipped" subtitle="The PRs Shepherd merged this day, by theme" />
      <SectionContent>
        {shipped.status === "loading" ? (
          <VStack gap={3} testID="coord-shipped-loading">
            {Array.from({ length: SKELETONS }, (_, index) => (
              <Skeleton key={index} variant="rounded" width="100%" height={56} accessibilityLabel={index === 0 ? "Loading what shipped" : undefined} />
            ))}
          </VStack>
        ) : shipped.data === undefined ? (
          <Alert status="error" message={`Could not load what shipped: ${shipped.error.message}`} testID="coord-shipped-error" />
        ) : (
          <ShippedBody result={shipped.data} />
        )}
      </SectionContent>
    </Section>
  );
}

function ShippedBody({ result }: { result: ShippedResult }): ReactNode {
  const groups = result.digest?.groups ?? [];
  if (groups.length === 0 && result.merged.length === 0) {
    return (
      <Typography variant="body2" color="secondary" testID="coord-shipped-empty">
        Shepherd merged no PR in this day, so there is nothing to summarize.
      </Typography>
    );
  }
  return (
    <VStack gap={4}>
      {result.digest === null ? (
        <>
          <Alert status="info" message="No digest has been built for this day yet; the 07:10 timer builds it. Until then, these are the PRs Shepherd merged, unsummarized." testID="coord-shipped-unbuilt" />
          <PrList prs={result.merged} />
        </>
      ) : (
        <>
          {result.stale ? <Alert status="warning" message="The set of merged PRs changed after this digest was built, so it may be missing the newest ones." testID="coord-shipped-stale" /> : null}
          {groups.map((group) => (
            <GroupView key={group.initiative} group={group} />
          ))}
        </>
      )}
    </VStack>
  );
}

function GroupView({ group }: { group: Group }): ReactNode {
  return (
    <VStack gap={3} className="min-w-0" testID={`coord-shipped-group-${group.initiative}`}>
      <Typography variant="subtitle1" className="break-words">
        {group.initiative}
      </Typography>
      {group.themes.map((theme) => (
        <VStack key={theme.title} gap={1} className="min-w-0" testID={`coord-shipped-theme-${theme.title}`}>
          <Typography variant="subtitle2" className="break-words">
            {theme.title}
          </Typography>
          <Typography variant="body2" className="break-words">
            {theme.summary}
          </Typography>
          <PrList prs={theme.prs} />
        </VStack>
      ))}
      {group.unsummarized.length === 0 ? null : (
        <VStack gap={1} className="min-w-0" testID={`coord-shipped-unsummarized-${group.initiative}`}>
          <Typography variant="caption" color="secondary">
            Merged, but not placed in a theme
          </Typography>
          <PrList prs={group.unsummarized} />
        </VStack>
      )}
    </VStack>
  );
}

function PrList({ prs }: { prs: readonly PrRef[] }): ReactNode {
  return (
    <VStack gap={1} className="min-w-0">
      {prs.map((pr) => (
        <HStack key={`${pr.repo}#${pr.number}`} gap={2} align="center" className="min-w-0 flex-wrap">
          <Link color="primary" href={pr.url} isExternal className={`${PHONE_TAP_LINK} break-all`} onPress={() => openExternal(pr.url)} testID={`coord-shipped-pr-${pr.repo}#${pr.number}`}>
            {`${pr.repo}#${pr.number}`}
          </Link>
          <Typography variant="caption" color="secondary" className="break-words">
            {pr.task}
          </Typography>
        </HStack>
      ))}
    </VStack>
  );
}
