import type { ReactNode } from "react";
import { AppShell, BrandLockup, TopBar } from "@titan-design/react-ui";
import { InitiativeDetailPage } from "./pages/InitiativeDetailPage.js";
import { InitiativesPage } from "./pages/InitiativesPage.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";
import { StatusPage } from "./pages/StatusPage.js";
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
  if (route.view === "status") return <StatusPage />;
  if (route.view === "initiatives") return route.slug ? <InitiativeDetailPage slug={route.slug} /> : <InitiativesPage />;
  return <PlaceholderPage view={viewFor(route.view)} />;
}
