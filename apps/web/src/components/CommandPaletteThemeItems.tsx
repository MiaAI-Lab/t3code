import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import type { DarkStyle } from "@t3tools/contracts/settings";
import { MonitorIcon, MoonIcon, MoonStarIcon, PaletteIcon, SunIcon } from "lucide-react";

import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { getThemeDefinition } from "../themePalette";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  ThemePreviewCircle,
} from "./settings/ThemePreviewCircles";
import { stackedThreadToast, toastManager } from "./ui/toast";

export const APPEARANCE_OPTIONS = [
  { key: "system", mode: "system", darkStyle: null, label: "System", icon: MonitorIcon },
  { key: "light", mode: "light", darkStyle: null, label: "Light", icon: SunIcon },
  { key: "dark", mode: "dark", darkStyle: "gray", label: "Dark", icon: MoonIcon },
  { key: "oled", mode: "dark", darkStyle: "oled", label: "OLED", icon: MoonStarIcon },
] as const;
export type AppearanceOption = (typeof APPEARANCE_OPTIONS)[number];

export function isAppearanceOptionActive(
  option: AppearanceOption,
  appearanceMode: AppearanceOption["mode"],
  darkStyle: DarkStyle,
): boolean {
  return (
    option.mode === appearanceMode && (option.darkStyle === null || option.darkStyle === darkStyle)
  );
}

export function appearanceLabel(mode: AppearanceOption["mode"], darkStyle: DarkStyle): string {
  const option = APPEARANCE_OPTIONS.find((candidate) =>
    isAppearanceOptionActive(candidate, mode, darkStyle),
  );
  return option?.label ?? mode;
}

/** Picks the mode, and for Dark or OLED the standard theme's dark style on this device. */
export function applyAppearanceOption(
  option: AppearanceOption,
  setAppearanceMode: (mode: AppearanceOption["mode"]) => boolean,
): boolean {
  if (option.darkStyle !== null) void updateClientSettings({ darkStyle: option.darkStyle });
  return setAppearanceMode(option.mode);
}

export function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't save theme selection",
      description: "Try again.",
    }),
  );
}

// Reads its own source hooks so the compiler caches the cards on them. Taking the
// sources as arguments would leave it hook-free, and the compiler would cache nothing.
function useThemeCards() {
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const seen = new Set<string>();
  return [
    ...STANDARD_THEME_CARDS.map((card) => ({ ...card, id: null })),
    ...[...BUILT_IN_THEMES, ...customThemes, ...environmentThemes]
      .filter((definition) => {
        if (seen.has(definition.id)) return false;
        seen.add(definition.id);
        return true;
      })
      .map(getThemeCardDefinition),
  ];
}

export function useCommandPaletteThemeItems() {
  const {
    theme,
    themeHalves,
    resolvedTheme,
    appearanceMode,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
  } = useTheme();
  const themeCards = useThemeCards();
  const darkStyle = useClientSettings((settings) => settings.darkStyle);

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "palette"],
    title: "Change theme",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "themes",
        label: "Change theme",
        items: themeCards.map(({ id, label, previews }) => ({
          kind: "action",
          value: id === null ? "theme:standard" : `theme:palette:${id}`,
          title: label,
          description: previews.length === 1 ? `For ${previews[0]!.mode} mode` : undefined,
          searchTerms: [label, "theme", "appearance"],
          icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent: (
            <span className="flex shrink-0 items-center gap-2">
              {(themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null) === id ? (
                <span className="text-xs text-muted-foreground/70">Current</span>
              ) : null}
              <span className="flex items-center gap-1" aria-hidden>
                {previews.map((preview) => (
                  <ThemePreviewCircle
                    key={preview.mode}
                    colors={preview.colors}
                    mode={preview.mode}
                    className="size-3 border-0"
                  />
                ))}
              </span>
            </span>
          ),
          run: async () => {
            const saved =
              previews.length === 1 && id !== null
                ? setThemeHalf(previews[0]!.mode, id)
                : setTheme(id ?? appearanceMode);
            if (!saved) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };

  const changeAppearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-appearance",
    searchTerms: ["change appearance", "light", "dark", "oled", "system", "mode", "toggle"],
    title: "Change appearance",
    icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "appearance.cycle",
    groups: [
      {
        value: "appearance",
        label: "Change appearance",
        items: APPEARANCE_OPTIONS.map((option) => ({
          kind: "action",
          value: `appearance:${option.key}`,
          title: option.label,
          searchTerms: [option.label, "appearance", "mode"],
          icon: <option.icon className={ITEM_ICON_CLASS} />,
          titleTrailingContent: isAppearanceOptionActive(option, appearanceMode, darkStyle) ? (
            <span className="text-xs text-muted-foreground/70">Current</span>
          ) : undefined,
          run: async () => {
            if (!applyAppearanceOption(option, setAppearanceMode)) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };

  const themeEditorItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
    title: "Toggle theme editor",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "themeEditor.toggle",
    run: async () => {
      toggleThemeEditorForTheme({
        theme,
        themeHalves,
        initialAppearance: resolvedTheme,
      });
    },
  };

  return { changeThemeItem, changeAppearanceItem, themeEditorItem };
}
