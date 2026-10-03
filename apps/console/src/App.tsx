import type { ReactNode } from "react";
import { AppShell, BrandLockup, TopBar } from "@titan-design/react-ui";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";
import { StatusPage } from "./pages/StatusPage.js";
import { navigate, useRoute } from "./router.js";
import { NAV_ITEMS, viewFor } from "./views.js";

// react-ui has no console brand preset yet, so the shell borrows the agents accent and overrides the wordmark.
const BRAND = "agents";

export function App(): ReactNode {
  const { view } = useRoute();
  return (
    <AppShell
      brand={BRAND}
      topBar={<TopBar leading={<BrandLockup brand={BRAND} wordmark="TITAN CONSOLE" subtitle="read-only" />} />}
      navItems={NAV_ITEMS}
      activeKey={view}
      onNavigate={navigate}
    >
      {view === "status" ? <StatusPage /> : <PlaceholderPage view={viewFor(view)} />}
    </AppShell>
  );
}
