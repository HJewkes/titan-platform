import type { ReactNode } from "react";
import { Alert } from "@titan-design/react-ui";
import { Layout } from "./components/Layout.js";
import { QueryView } from "./components/QueryView.js";
import { useQuery } from "./data/rpc.js";
import { ComparePage } from "./pages/ComparePage.js";
import { FindingPage } from "./pages/FindingPage.js";
import { NodePage } from "./pages/NodePage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { PrioritiesPage } from "./pages/PrioritiesPage.js";
import { ReportContext, type ReportInfo } from "./report-context.js";
import { useRoute, type Route } from "./router.js";

/** Pins the newest snapshot once, so every page reads the same one even if the index moves underneath. */
export function App(): ReactNode {
  const describe = useQuery("api.describe");
  return (
    <QueryView result={describe} label="the read API description">
      {(data) =>
        data.newest ? (
          <ReportContext.Provider value={{ snapshotId: data.newest.id, describe: data as ReportInfo["describe"] }}>
            <Routed />
          </ReportContext.Provider>
        ) : (
          <div className="p-6">
            <Alert status="info" message="This index has no snapshots yet. Run `pnpm --filter code-report index`, then reload." />
          </div>
        )
      }
    </QueryView>
  );
}

function Routed(): ReactNode {
  const route = useRoute();
  return (
    <Layout current={route.page}>
      <Page route={route} />
    </Layout>
  );
}

function Page({ route }: { route: Route }): ReactNode {
  switch (route.page) {
    case "priorities":
      return <PrioritiesPage query={route.query} />;
    case "node":
      return <NodePage key={route.id} id={route.id} />;
    case "finding":
      return <FindingPage key={route.id} id={route.id} />;
    case "compare":
      return <ComparePage />;
    default:
      return <OverviewPage />;
  }
}
