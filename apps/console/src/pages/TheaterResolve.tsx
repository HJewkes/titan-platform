import type { ReactNode } from "react";
import { Alert, Heading, VStack } from "@titan-design/react-ui";
import { Spinner } from "../shell/Loading.js";
import { useQuery } from "../data/rpc.js";
import { TheaterPlayer } from "./TheaterPlayer.js";

const LATEST = "latest";
const FILTERS = ["series", "tag", "subject"] as const;

/** `latest` with a filter, or an `@alias`: a link that names a video by what it is rather than by id. */
export function isResolvable(id: string, query: string | undefined): boolean {
  if (id.startsWith("@")) return id.length > 1;
  return id === LATEST && FILTERS.some((name) => new URLSearchParams(query ?? "").get(name));
}

type Lookup = { alias: string } | { series?: string; tag?: string; subject?: string };

function lookupOf(id: string, query: string | undefined): Lookup {
  if (id.startsWith("@")) return { alias: id.slice(1) };
  const params = new URLSearchParams(query ?? "");
  const lookup: { series?: string; tag?: string; subject?: string } = {};
  for (const name of FILTERS) {
    const value = params.get(name);
    if (value) lookup[name] = value;
  }
  return lookup;
}

/** Looks the link up with `videos.resolve`, then plays the video it found; `t=` and `edit=` ride along in the query. */
export function TheaterResolve({ id, query }: { id: string; query?: string | undefined }): ReactNode {
  const resolved = useQuery("videos.resolve", lookupOf(id, query));
  if (resolved.status === "loading") return <Spinner size="sm" label="Finding video" />;
  if (resolved.data === undefined) return <Failure message={`Could not look up the video: ${resolved.error.message}`} />;
  if (!resolved.data.found) return <Failure message={resolved.data.reason} />;
  return <TheaterPlayer id={resolved.data.id} query={query} />;
}

function Failure({ message }: { message: string }): ReactNode {
  return (
    <VStack gap={3}>
      <Heading level={3}>Video</Heading>
      <Alert status="error" message={message} />
    </VStack>
  );
}
