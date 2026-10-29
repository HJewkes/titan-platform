import type { ReactNode } from "react";
import { Alert, AppShell, BrandLockup, TopBar } from "@titan-design/react-ui";
import { BuildFooter } from "./BuildFooter.js";
import { useRelayInvalidation, useReturnInvalidation } from "./data/live.js";
import { useRoutePerf } from "./data/perf.js";
import { useStaleSince } from "./data/stale.js";
import { PAGES } from "./pages/index.js";
import { Page } from "./pages/PageShell.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";
import { navigate, useRoute, type Route } from "./router.js";
import { NAV_ITEMS, viewFor } from "./views.js";

// react-ui has no console brand preset yet, so the shell borrows the agents accent and overrides the wordmark.
const BRAND = "agents";

export function App(): ReactNode {
  const route = useRoute();
  useRoutePerf(route);
  useRelayInvalidation();
  useReturnInvalidation();
  return (
    <AppShell
      brand={BRAND}
      topBar={<TopBar brand={BRAND} leading={<BrandLockup brand={BRAND} wordmark="TITAN CONSOLE" subtitle="read-only" />} />}
      navItems={NAV_ITEMS}
      activeKey={route.view}
      onNavigate={navigate}
    >
      <StaleLine />
      <RoutedView route={route} />
      <BuildFooter />
    </AppShell>
  );
}

function StaleLine(): ReactNode {
  const since = useStaleSince();
  if (since === null) return null;
  return (
    <div className="px-gutter-sm pt-gutter-sm sm:px-gutter-md sm:pt-gutter-md">
      <Alert status="warning" message={`Live updates are off. Data may be old since ${since.toLocaleTimeString()}.`} />
    </div>
  );
}

function RoutedView({ route }: { route: Route }): ReactNode {
  const Registered = PAGES[route.view];
  if (Registered) return <Registered route={route} />;
  return (
    <Page maxWidth="narrow">
      <PlaceholderPage view={viewFor(route.view)} />
    </Page>
  );
}
