import type { ReactNode } from "react";
import { Alert, AppShell, BrandLockup, TopBar } from "@titan-design/react-ui";
import { BlockerBanner } from "./BlockerBanner.js";
import { BuildFooter } from "./BuildFooter.js";
import { useRelayInvalidation, useReturnInvalidation } from "./data/live.js";
import { useRoutePerf } from "./data/perf.js";
import { useStaleSince } from "./data/stale.js";
import { PAGES } from "./pages/index.js";
import { useMediaQuery } from "./pages/FramePins.js";
import { Page } from "./pages/PageShell.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";
import { BELOW_MD } from "./pages/TasksPage.js";
import { navigate, useRoute, type Route } from "./router.js";
import { PhoneNav } from "./shell/PhoneNav.js";
import { NAV_ITEMS, viewFor } from "./views.js";

// react-ui has no console brand preset yet, so the shell borrows the agents accent and overrides the wordmark.
const BRAND = "agents";

export function App(): ReactNode {
  const route = useRoute();
  useRoutePerf(route);
  useRelayInvalidation();
  useReturnInvalidation();
  const isPhone = useMediaQuery(BELOW_MD);
  const lockup = <BrandLockup brand={BRAND} wordmark="TITAN CONSOLE" subtitle="read-only" />;
  return (
    <AppShell
      brand={BRAND}
      topBar={<TopBar brand={BRAND} leading={isPhone ? <PhoneNav activeKey={route.view} brand={lockup} /> : lockup} />}
      // `false`, not null: the shell falls back to its rail on a nullish nav.
      nav={isPhone ? false : undefined}
      navItems={NAV_ITEMS}
      activeKey={route.view}
      onNavigate={navigate}
    >
      <BlockerBanner />
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
