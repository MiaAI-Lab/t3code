import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  inferenceModelImageGap,
  inferenceModelNotServed,
  inferenceServerOutage,
} from "@t3tools/client-runtime/state/inference-presentation";
import { useNavigate } from "@tanstack/react-router";
import { CpuIcon, ImageOffIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * A notice while the model server the selected agent is linked to is down, or is up but no longer
 * serves the selected model, or while an attached image would not reach that model.
 */
export function useInferenceOutageBannerItem(
  environmentId: EnvironmentId,
  provider: ServerProvider | null,
  modelSlug: string,
  hasImages: boolean,
  onChooseModel: () => void,
): ComposerBannerStackItem | null {
  const navigate = useNavigate();
  const servers = useEnvironmentSettings(environmentId, (settings) => settings.inferenceServers);
  const snapshots = useAtomValue(serverEnvironment.inferenceServersValueAtom(environmentId));
  const refresh = useAtomCommand(serverEnvironment.refreshInferenceServers, {
    reportFailure: false,
  });
  const checkImages = useAtomCommand(serverEnvironment.checkInferenceModelImages, {
    label: "check images",
  });
  const [checkingImages, setCheckingImages] = useState(false);
  const outage = inferenceServerOutage({
    serverId: provider?.inferenceServerId,
    servers,
    snapshots: snapshots ?? [],
  });
  if (outage === null) {
    const linked = {
      serverId: provider?.inferenceServerId,
      driver: provider?.driver,
      modelSlug,
      servers,
      snapshots: snapshots ?? [],
    };
    const notServed = inferenceModelNotServed(linked);
    const imageGap = hasImages ? inferenceModelImageGap(linked) : null;
    if (notServed === null && imageGap !== null) {
      return {
        id: `inference-images:${imageGap.id}:${imageGap.model}`,
        group: "environment",
        variant: "warning",
        icon: <ImageOffIcon />,
        title:
          imageGap.reason === "text-only"
            ? `${imageGap.model} reads text only`
            : `${imageGap.model} has not been checked for images`,
        description:
          imageGap.reason === "text-only"
            ? "It will not see the attached image. Choose a model that reads images."
            : "T3 Code sends images only to models it knows read them. Checking takes a few seconds.",
        actions: (
          <>
            {imageGap.reason === "unchecked" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={checkingImages}
                onClick={() => {
                  setCheckingImages(true);
                  void checkImages({
                    environmentId,
                    input: { serverId: imageGap.id, model: imageGap.model },
                  }).finally(() => setCheckingImages(false));
                }}
              >
                {checkingImages ? "Checking images" : "Check images"}
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={onChooseModel}>
              Choose model
            </Button>
          </>
        ),
      };
    }
    if (notServed === null) return null;
    return {
      id: `inference-not-served:${notServed.id}:${notServed.model}`,
      group: "environment",
      variant: "warning",
      icon: <CpuIcon />,
      title: `${notServed.name} no longer serves ${notServed.model}`,
      description: `It serves ${notServed.served.join(", ")} now. Choose one of them, or check again if the model is coming back.`,
      actions: (
        <>
          <Button size="xs" variant="ghost" onClick={onChooseModel}>
            Choose model
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void refresh({ environmentId, input: { id: notServed.id } })}
          >
            Check again
          </Button>
        </>
      ),
    };
  }
  return {
    id: `inference-outage:${outage.id}`,
    group: "environment",
    variant: "warning",
    icon: <CpuIcon />,
    title: `${outage.name} is not answering`,
    description: `${outage.baseUrl}: ${outage.message} Its models are hidden until it answers again.`,
    actions: (
      <>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void refresh({ environmentId, input: { id: outage.id } })}
        >
          Check again
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: "/settings/inference",
              search: { repair: outage.id, machine: environmentId },
            })
          }
        >
          Find server
        </Button>
      </>
    ),
  };
}
