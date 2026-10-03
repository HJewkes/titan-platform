import type { ReactNode } from "react";
import { EmptyState } from "@titan-design/react-ui";
import type { ViewSpec } from "../views.js";

/** Stands in for a planned view until its slice lands, and says which task builds it. */
export function PlaceholderPage({ view }: { view: ViewSpec }): ReactNode {
  const description = view.planned ? `${view.planned.summary} Planned in ${view.planned.tasks}.` : undefined;
  return <EmptyState title={view.title} description={description} />;
}
