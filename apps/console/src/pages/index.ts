import { createElement, type ReactNode } from "react";
import { VIEW_KEYS, type Route, type ViewKey } from "../router.js";
import { viewFor } from "../views.js";
import { AgentsRoute } from "./AgentsPage.js";
import { ConfigPage } from "./ConfigPage.js";
import { HomePage } from "./HomePage.js";
import { InboxPage } from "./InboxPage.js";
import { InitiativeDetailPage } from "./InitiativeDetailPage.js";
import { InitiativesPage } from "./InitiativesPage.js";
import { KnowledgePage } from "./KnowledgePage.js";
import { Page, PageHeader, type PageMaxWidth } from "./PageShell.js";
import { ReviewDetailPage } from "./ReviewDetailPage.js";
import { ReviewsPage } from "./ReviewsPage.js";
import { RoundDetailPage } from "./RoundDetailPage.js";
import { RoundsPage } from "./RoundsPage.js";
import { SessionsRoute } from "./SessionsPage.js";
import { ShepherdDetailPage } from "./ShepherdDetailPage.js";
import { ShepherdPage } from "./ShepherdPage.js";
import { TaskDetailPage } from "./TaskDetailPage.js";
import { TasksPage } from "./TasksPage.js";
import { TheaterPage } from "./TheaterPage.js";
import { TheaterPlayer } from "./TheaterPlayer.js";

type PageComponent = (props: { route: Route }) => ReactNode;

/** How a view sits in its Page. A detail route carries its own trail and heading, so only a list route gets the view's title. */
interface Layout {
  maxWidth: PageMaxWidth;
  isScrollable?: boolean;
  /** Set when the view titles itself, as the initiatives overview does. */
  hasOwnTitle?: boolean;
}

interface Shelled {
  list: Layout;
  detail?: Layout;
  render: PageComponent;
}

const WorkPage: PageComponent = ({ route }) => (route.id ? createElement(InitiativeDetailPage, { slug: route.id }) : createElement(InitiativesPage));
const RoundsView: PageComponent = ({ route }) => (route.id ? createElement(RoundDetailPage, { id: route.id }) : createElement(RoundsPage));
const ReviewsView: PageComponent = ({ route }) => (route.id ? createElement(ReviewDetailPage, { name: route.id }) : createElement(ReviewsPage));
const ShepherdView: PageComponent = ({ route }) => (route.id ? createElement(ShepherdDetailPage, { id: route.id }) : createElement(ShepherdPage));
const TasksView: PageComponent = ({ route }) => (route.id ? createElement(TaskDetailPage, { id: route.id }) : createElement(TasksPage, { query: route.query }));
const TheaterView: PageComponent = ({ route }) => (route.id ? createElement(TheaterPlayer, { id: route.id, query: route.query }) : createElement(TheaterPage, { query: route.query }));

const WIDE: Layout = { maxWidth: "wide" };
const NARROW: Layout = { maxWidth: "narrow" };
// The player and the round's frame overlay lay themselves out, so the page only gives them the gutter.
const OWNS_LAYOUT: Layout = { maxWidth: "full", isScrollable: false };

const SHELLED: Partial<Record<ViewKey, Shelled>> = {
  home: { list: WIDE, render: HomePage },
  inbox: { list: WIDE, render: InboxPage },
  initiatives: { list: { maxWidth: "wide", hasOwnTitle: true }, detail: WIDE, render: WorkPage },
  tasks: { list: { maxWidth: "full" }, detail: WIDE, render: TasksView },
  sessions: { list: WIDE, detail: WIDE, render: SessionsRoute },
  knowledge: { list: WIDE, detail: NARROW, render: KnowledgePage },
  agents: { list: WIDE, detail: WIDE, render: AgentsRoute },
  rounds: { list: WIDE, detail: OWNS_LAYOUT, render: RoundsView },
  reviews: { list: WIDE, detail: NARROW, render: ReviewsView },
  theater: { list: WIDE, detail: OWNS_LAYOUT, render: TheaterView },
  shepherd: { list: WIDE, detail: WIDE, render: ShepherdView },
  config: { list: WIDE, render: ConfigPage },
};

function inPage(view: ViewKey, { list, detail = list, render }: Shelled): PageComponent {
  return ({ route }) => {
    const layout = route.id ? detail : list;
    const header = route.id || layout.hasOwnTitle ? undefined : createElement(PageHeader, { title: viewFor(view).title });
    return createElement(Page, { header, maxWidth: layout.maxWidth, isScrollable: layout.isScrollable ?? true }, createElement(render, { route }));
  };
}

/** One entry per built view, each inside its Page; a rail entry with none here renders its placeholder. */
export const PAGES: Partial<Record<ViewKey, PageComponent>> = Object.fromEntries(
  VIEW_KEYS.flatMap((view) => {
    const shelled = SHELLED[view];
    return shelled ? [[view, inPage(view, shelled)]] : [];
  }),
);
