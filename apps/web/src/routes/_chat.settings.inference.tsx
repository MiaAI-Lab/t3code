import { createFileRoute } from "@tanstack/react-router";

import { InferenceSettingsPanel } from "../components/settings/InferenceSettings";

export const Route = createFileRoute("/_chat/settings/inference")({
  validateSearch: (raw: Record<string, unknown>): { setup?: "local" } =>
    raw.setup === "local" ? { setup: "local" } : {},
  component: SettingsInferenceRoute,
});

function SettingsInferenceRoute() {
  const { setup } = Route.useSearch();
  return <InferenceSettingsPanel openLocalSetup={setup === "local"} />;
}
