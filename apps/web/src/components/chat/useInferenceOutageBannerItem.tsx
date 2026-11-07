import type { EnvironmentId, InferenceServerId, ServerProvider } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  inferenceModelImageGap,
  inferenceModelNotServed,
  inferenceServerOutage,
} from "@t3tools/client-runtime/state/inference-presentation";
import { useNavigate } from "@tanstack/react-router";
import { CpuIcon, ImageOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
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
  const canCheckImages = useAtomValue(
    serverEnvironment.checkInferenceModelImages.permissionAtom(environmentId),
  );
  const [imageCheck, setImageCheck] = useState<{
    readonly key: string;
    readonly running: boolean;
    readonly detail?: string;
  } | null>(null);
  const outage = inferenceServerOutage({
    serverId: provider?.inferenceServerId,
    servers,
    snapshots: snapshots ?? [],
  });
  const linked = {
    serverId: provider?.inferenceServerId,
    driver: provider?.driver,
    modelSlug,
    servers,
    snapshots: snapshots ?? [],
  };
  const notServed = outage === null ? inferenceModelNotServed(linked) : null;
  const imageGap =
    outage === null && notServed === null && hasImages ? inferenceModelImageGap(linked) : null;
  const imageKey = imageGap === null ? null : `${environmentId}:${imageGap.id}:${imageGap.model}`;
  const runImageCheck = useStableCallback(
    async (key: string, serverId: InferenceServerId, model: string) => {
      setImageCheck({ key, running: true });
      const result = await checkImages({ environmentId, input: { serverId, model } });
      setImageCheck(
        result._tag === "Success" && result.value.outcome === "unknown"
          ? { key, running: false, detail: result.value.detail }
          : null,
      );
    },
  );
  const autoChecked = useRef(new Set<string>());
  const autoServerId = imageGap?.reason === "unchecked" && canCheckImages ? imageGap.id : null;
  const autoModel = imageGap?.model ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an attached image starts the model's image check on the user's own server, once per model
  useEffect(() => {
    if (autoServerId === null || autoModel === null || imageKey === null) return;
    if (autoChecked.current.has(imageKey)) return;
    autoChecked.current.add(imageKey);
    void runImageCheck(imageKey, autoServerId, autoModel);
  }, [autoChecked, autoServerId, autoModel, imageKey, runImageCheck]);
  if (outage === null) {
    if (imageGap !== null) {
      const check = imageCheck?.key === imageKey ? imageCheck : null;
      return {
        id: `inference-images:${imageGap.id}:${imageGap.model}`,
        group: "environment",
        variant: "warning",
        icon: <ImageOffIcon />,
        title:
          imageGap.reason === "text-only"
            ? `${imageGap.model} reads text only`
            : check?.running === true
              ? `Checking whether ${imageGap.model} reads images`
              : `Not known whether ${imageGap.model} reads images`,
        description:
          imageGap.reason === "text-only"
            ? "It will not see the attached image. Choose a model that reads images."
            : `${check?.detail === undefined ? "" : `${check.detail} `}The image is sent anyway; if the model cannot read it, its server will say so.`,
        actions: (
          <>
            {imageGap.reason === "unchecked" && canCheckImages ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={check?.running === true}
                onClick={() => void runImageCheck(imageKey!, imageGap.id, imageGap.model)}
              >
                {check?.running === true ? "Checking images" : "Check images"}
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
