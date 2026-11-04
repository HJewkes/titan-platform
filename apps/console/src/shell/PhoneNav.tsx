import { useEffect, useRef, useState, type ReactNode } from "react";
import { Drawer, DrawerBody } from "@titan-design/react-ui";
import { href } from "../router.js";
import { VIEWS } from "../views.js";

/** A phone tap needs a 44px target. */
const TAP_TARGET = "flex min-h-11 min-w-11 items-center";

interface PhoneNavProps {
  activeKey: string;
  /** The brand lockup, drawn beside the menu button. */
  brand: ReactNode;
}

/** Below md the 60px rail eats a phone's width and runs past the fold, so the routes move into a drawer the menu button opens. */
export function PhoneNav({ activeKey, brand }: PhoneNavProps): ReactNode {
  const [isOpen, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const close = (): void => {
    setOpen(false);
    menuButton.current?.focus();
  };
  useCloseOnEscape(isOpen, close);
  return (
    <div className="flex items-center gap-2">
      <button ref={menuButton} type="button" className={`${TAP_TARGET} justify-center rounded px-2 text-text-primary`} aria-label="Open navigation" aria-expanded={isOpen} onClick={() => setOpen(true)} data-testid="phone-nav-open">
        <MenuGlyph />
      </button>
      {brand}
      <Drawer isOpen={isOpen} onClose={close} placement="left" size="sm" showCloseButton={false} accessibilityLabel="Navigation" testID="phone-nav">
        <DrawerBody>
          <PhoneNavLinks activeKey={activeKey} onNavigate={close} />
        </DrawerBody>
      </Drawer>
    </div>
  );
}

/** The modal under the drawer hears Escape only once its fade-in ends, so a quick Escape would be lost without this. */
function useCloseOnEscape(isOpen: boolean, close: () => void): void {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, close]);
}

/** The current route takes focus as the drawer opens, so a keyboard user starts where they are. A stable ref, so a re-render never steals focus back. */
const focusOnMount = (link: HTMLAnchorElement | null): void => link?.focus();

/** Plain hash links, so every route, Theater's included, opens the same way a typed URL does. */
function PhoneNavLinks({ activeKey, onNavigate }: { activeKey: string; onNavigate: () => void }): ReactNode {
  return (
    <nav aria-label="Primary">
      <ul>
        {VIEWS.map((view) => {
          const isActive = view.key === activeKey;
          return (
            <li key={view.key}>
              <a
                href={href({ view: view.key })}
                ref={isActive ? focusOnMount : undefined}
                aria-current={isActive ? "page" : undefined}
                onClick={onNavigate}
                className={`${TAP_TARGET} gap-3 rounded px-3 ${isActive ? "bg-interactive-selected font-semibold text-text-primary" : "text-text-secondary"}`}
              >
                {view.icon}
                <span>{view.title}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function MenuGlyph(): ReactNode {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
