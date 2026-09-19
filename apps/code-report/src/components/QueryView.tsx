import type { ReactNode } from "react";
import { Alert, Spinner } from "@titan-design/react-ui";
import type { QueryResult } from "@titan-design/react-app";
import { EXIT } from "@titan-design/rpc-protocol";

interface QueryViewProps<T> {
  result: QueryResult<T>;
  /** What is loading, for the spinner's label and the error's title. */
  label: string;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

/** The loading, error, unavailable, and empty states every screen shares. */
export function QueryView<T>({ result, label, isEmpty, empty, children }: QueryViewProps<T>): ReactNode {
  if (result.status === "loading") return <Spinner size="sm" label={`Loading ${label}`} />;
  if (result.status === "error" && result.data === undefined) return <QueryError label={label} code={result.error.code} message={result.error.message} />;
  const data = result.data as T;
  if (isEmpty?.(data)) return empty ?? <Note>No {label}.</Note>;
  return (
    <>
      {result.status === "error" && <QueryError label={label} code={result.error.code} message={result.error.message} />}
      {children(data)}
    </>
  );
}

function QueryError({ label, code, message }: { label: string; code: number; message: string }): ReactNode {
  // UNAVAILABLE is a static export that did not record this call, or a command the source does not serve.
  if (code === EXIT.UNAVAILABLE) return <Alert status="info" message={`${label} is not available from this source: ${message}`} />;
  if (code === EXIT.NOINPUT) return <Alert status="warning" message={`Not found: ${message}`} />;
  return <Alert status="error" message={`Could not load ${label} (code ${code}): ${message}`} />;
}

export function Note({ children }: { children: ReactNode }): ReactNode {
  return <p className="text-sm text-text-secondary">{children}</p>;
}
