import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import {
  SETTINGS_DETAIL_PAGE_PARENTS,
  SETTINGS_SECTION_LABELS,
  settingsDestinationFor,
} from "./settingsSearch";

/** The pages of the open destination, when it has more than one. */
export function SettingsDestinationTabs({ pathname }: { pathname: string }) {
  const destination = settingsDestinationFor(pathname);
  if (destination === undefined || destination.paths.length < 2) return null;
  const page = SETTINGS_DETAIL_PAGE_PARENTS[pathname] ?? pathname;
  return (
    <nav
      aria-label={destination.label}
      className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 sm:px-4"
    >
      {destination.paths.map((path) => {
        const active = page === path || page.startsWith(`${path}/`);
        return (
          <Link
            key={path}
            to={path}
            hash=""
            replace
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-2.5 py-2 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {SETTINGS_SECTION_LABELS[path]}
          </Link>
        );
      })}
    </nav>
  );
}
