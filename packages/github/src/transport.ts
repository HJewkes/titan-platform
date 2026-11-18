/**
 * How a failed GitHub call's transport gave out, set where the `GhError` is raised. `none` is an answer GitHub meant (a
 * 4xx, a refusal) or a failure that is not the transport's, a timed-out write included: it may have landed.
 */
export type GhTransport = "none" | "server-5xx" | "no-connection" | "empty-or-cut-body" | "read-timeout";

/** The kind an HTTP status the transport saw gives. */
export function transportOfStatus(status: number | undefined): GhTransport {
  return status !== undefined && status >= 500 ? "server-5xx" : "none";
}

/** A deadline that fired on a read is `read-timeout`; on a write it is `none`, so nothing ever sends the write again. */
export function transportOfDeadline(method: string): GhTransport {
  return method === "GET" || method === "HEAD" ? "read-timeout" : "none";
}

/**
 * The one place the `gh` CLI's own words are read. `gh api` reports a failure it met before any HTTP answer only as
 * text, so its output is matched here, once, and every reader takes the kind instead.
 */
export function transportOfGhOutput(stderr: string, stdout: string): GhTransport {
  const said = stderr.trim() || stdout.trim();
  if (said === "" || said.includes("unexpected end of JSON input")) return "empty-or-cut-body";
  if (said.includes("error connecting")) return "no-connection";
  return /HTTP 5\d\d/.test(said) ? "server-5xx" : "none";
}
