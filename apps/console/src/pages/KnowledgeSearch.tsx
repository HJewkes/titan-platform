import { useState, type ReactNode } from "react";
import { Alert, Button, ButtonText, EmptyState, HStack, Input, Link, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { refToRoute } from "../refs.js";
import { open } from "../router.js";
import { openRef } from "./KnowledgeTable.js";

type Hit = ConsoleCommands["work.search"]["result"]["hits"][number];

const runSearch = (q: string): void => open({ view: "knowledge", query: new URLSearchParams({ tab: "search", ...(q ? { q } : {}) }).toString() });

/** The Search tab: the query lives in `q`, so a search is a link. */
export function KnowledgeSearch({ q }: { q: string }): ReactNode {
  const [draft, setDraft] = useState(q);
  return (
    <VStack gap={4}>
      <HStack gap={2} align="center">
        <Input value={draft} onChangeText={setDraft} onSubmitEditing={() => runSearch(draft.trim())} placeholder="Search notes, briefs, sources, tasks and sessions" accessibilityLabel="Search" className="w-96" />
        <Button onPress={() => runSearch(draft.trim())}><ButtonText>Search</ButtonText></Button>
      </HStack>
      {q ? <Results q={q} /> : <Typography variant="caption" color="secondary">Search every initiative at once.</Typography>}
    </VStack>
  );
}

function Results({ q }: { q: string }): ReactNode {
  const search = useQuery("work.search", { q });
  if (search.status === "loading") return <Spinner size="sm" label="Searching" />;
  if (search.data === undefined) return <Alert status="error" message={`Could not load search results: ${search.error?.message ?? "no answer"}`} />;
  const { hits, degraded } = search.data;
  return (
    <VStack gap={2}>
      {degraded.length > 0 ? <Alert status="warning" message={`Search is partial: ${degraded.map((entry) => `${entry.retriever} failed (${entry.message})`).join("; ")}.`} /> : null}
      {hits.length === 0 ? <EmptyState title={`No results for "${q}"`} /> : hits.map((hit) => <HitRow key={hit.ref} hit={hit} />)}
    </VStack>
  );
}

/** A hit whose ref has a console route is a link; any other ref is shown as text. */
function HitRow({ hit }: { hit: Hit }): ReactNode {
  const title = hit.title ?? hit.ref;
  return (
    <VStack gap={1} testID={`search-hit-${hit.ref}`}>
      {refToRoute(hit.ref)?.kind === "route" ? (
        <Link color="primary" onPress={() => openRef(hit.ref)}>
          {title}
        </Link>
      ) : (
        <Typography>{title}</Typography>
      )}
      <Typography variant="mono">{hit.ref}</Typography>
      {hit.excerpt ? (
        <Typography variant="caption" color="secondary">
          {hit.excerpt}
        </Typography>
      ) : null}
    </VStack>
  );
}
