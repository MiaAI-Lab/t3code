import type { InferenceServerSnapshot, InferenceServerStatus } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { INFERENCE_SERVER_STATUS_LABELS } from "@t3tools/client-runtime/state/provider-instance-display";
import { useNavigate } from "@tanstack/react-router";
import { CpuIcon } from "lucide-react";
import { useState } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { BackgroundWritingSettings } from "./SettingsPanels";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { UseLocalModelDialog } from "./UseLocalModelDialog";

const STATUS_BADGE_VARIANTS = {
  checking: "outline",
  ready: "success",
  unreachable: "warning",
  error: "error",
} as const satisfies Record<InferenceServerStatus, string>;

const NO_SNAPSHOTS: ReadonlyArray<InferenceServerSnapshot> = [];

/**
 * Settings, Models: the one place for which model runs new threads and background writing, and
 * the model servers they run on. Servers and agents keep their own tabs for the details.
 */
export function ModelsSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <LocalModelsSummary key={environment.environmentId} environment={environment} />
      ) : null}
      <ProjectDefaultsSettings category="models" />
      <BackgroundWritingSettings />
    </SettingsPageContainer>
  );
}

function LocalModelsSummary({ environment }: { readonly environment: EnvironmentPresentation }) {
  const navigate = useNavigate();
  const environmentId = environment.environmentId;
  const snapshots =
    useAtomValue(serverEnvironment.inferenceServersValueAtom(environmentId)) ?? NO_SNAPSHOTS;
  const canDiscover = useAtomValue(
    serverEnvironment.discoverInferenceServers.permissionAtom(environmentId),
  );
  const [setupOpen, setSetupOpen] = useState(false);
  const servers = snapshots.filter((snapshot) => snapshot.enabled);
  return (
    <SettingsSection
      id="local-models"
      title={`Your hardware on ${environment.label}`}
      headerAction={
        canDiscover ? (
          <Button size="xs" onClick={() => setSetupOpen(true)}>
            <CpuIcon className="size-3" aria-hidden />
            Use a local model
          </Button>
        ) : null
      }
    >
      {servers.length === 0 ? (
        <SettingsRow
          title="No model servers yet"
          description="Run models on your own GPUs: T3 Code finds Ollama, LM Studio, llama.cpp, vLLM, SGLang, or TensorFold and sets them up for new threads."
        />
      ) : (
        servers.map((server) => (
          <SettingsRow
            key={server.id}
            title={
              <span className="flex items-center gap-2">
                {server.displayName}
                <Badge variant={STATUS_BADGE_VARIANTS[server.status]} size="sm">
                  {INFERENCE_SERVER_STATUS_LABELS[server.status]}
                </Badge>
              </span>
            }
            description={
              server.models.length > 0
                ? server.models.map((model) => model.id).join(", ")
                : (server.message ?? server.baseUrl)
            }
            control={
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void navigate({
                    to: "/settings/inference",
                    search: {
                      machine: environmentId,
                      ...(server.status === "unreachable" || server.status === "error"
                        ? { repair: server.id }
                        : {}),
                    },
                  })
                }
              >
                {server.status === "unreachable" || server.status === "error" ? "Fix" : "Details"}
              </Button>
            }
          />
        ))
      )}
      {setupOpen ? (
        <UseLocalModelDialog
          environmentId={environmentId}
          machineLabel={environment.label}
          onClose={() => setSetupOpen(false)}
        />
      ) : null}
    </SettingsSection>
  );
}
