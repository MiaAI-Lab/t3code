import { createFileRoute } from "@tanstack/react-router";

import { ModelsSettingsPanel } from "../components/settings/ModelsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/models")({
  component: ModelsSettingsPanel,
});
