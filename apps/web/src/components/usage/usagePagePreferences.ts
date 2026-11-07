import { UsageProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
  hiddenProviders: Schema.optional(Schema.Array(UsageProviderKind)),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

/** Null when nothing valid is saved, so the page can pick a default from what is connected. */
export function readUsagePagePreferences(): UsagePagePreferences | null {
  try {
    return getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return null;
  }
}

/** A saved choice wins; otherwise Tokens, where Local compute shows, when a local server is in use. */
export function resolveUsagePagePreferences(
  saved: UsagePagePreferences | null,
  hasEnabledInferenceServer: boolean,
): UsagePagePreferences {
  return saved ?? { metric: hasEnabledInferenceServer ? "tokens" : "limits", windowDays: 30 };
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}
