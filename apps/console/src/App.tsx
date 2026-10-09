import type { ReactNode } from "react";
import { AppShell, BrandLockup, TopBar } from "@titan-design/react-ui";
import { PAGES } from "./pages/index.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";
import { navigate, useRoute, type Route } from "./router.js";
import { NAV_ITEMS, viewFor } from "./views.js";

// react-ui has no console brand preset yet, so the shell borrows the agents accent and overrides the wordmark.
const BRAND = "agents";

export function App(): ReactNode {
  const route = useRoute();
  return (
    <AppShell
      brand={BRAND}
      topBar={<TopBar leading={<BrandLockup brand={BRAND} wordmark="TITAN CONSOLE" subtitle="read-only" />} />}
      navItems={NAV_ITEMS}
      activeKey={route.view}
      onNavigate={navigate}
    >
      <Page route={route} />
    </AppShell>
  );
}

function Page({ route }: { route: Route }): ReactNode {
  const Registered = PAGES[route.view];
  return Registered ? <Registered route={route} /> : <PlaceholderPage view={viewFor(route.view)} />;
}
