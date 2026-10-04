import type { ReactNode } from "react";
import { Badge, BadgeText, HStack } from "@titan-design/react-ui";
import { href, type Route } from "../router.js";
import { useReport } from "../report-context.js";
import { SearchBox } from "./SearchBox.js";

const NAV: ReadonlyArray<{ label: string; route: Route }> = [
  { label: "Overview", route: { page: "overview" } },
  { label: "Priorities", route: { page: "priorities", query: { filters: {}, sort: "severity", offset: 0 } } },
  { label: "Compare", route: { page: "compare" } },
];

export function Layout({ current, children }: { current: Route["page"]; children: ReactNode }): ReactNode {
  return (
    <div className="mx-auto max-w-6xl px-6 py-4">
      <header className="mb-6 border-b border-hairline pb-3">
        <HStack justify="between" align="center" gap={4}>
          <HStack align="center" gap={4}>
            <h1 className="m-0 text-xl font-semibold">Code report</h1>
            <nav aria-label="Report views" className="flex gap-4">
              {NAV.map(({ label, route }) => (
                <a key={label} href={href(route)} aria-current={route.page === current ? "page" : undefined}
                  className={route.page === current ? "font-semibold text-text-primary" : "text-text-link"}>
                  {label}
                </a>
              ))}
            </nav>
          </HStack>
          <SearchBox />
        </HStack>
        <SnapshotLine />
      </header>
      <main>{children}</main>
    </div>
  );
}

function SnapshotLine(): ReactNode {
  const { describe } = useReport();
  const { newest, dataset } = describe;
  const commit = newest.commit ? ` at ${newest.commit.slice(0, 8)}` : "";
  return (
    <HStack align="center" gap={2} className="mt-2">
      <Badge color={dataset === "live" ? "success" : "info"} variant="subtle" size="sm">
        <BadgeText>{dataset === "live" ? "live daemon" : "static export"}</BadgeText>
      </Badge>
      <span className="text-xs text-text-secondary">
        Snapshot {newest.id} of {newest.ref}{commit}, indexed {new Date(newest.takenAt).toLocaleString("en-US")}, read API {describe.api}
      </span>
    </HStack>
  );
}
