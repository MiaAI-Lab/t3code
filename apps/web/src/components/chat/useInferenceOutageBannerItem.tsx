import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { inferenceServerOutage } from "@t3tools/client-runtime/state/inference-presentation";
import { useNavigate } from "@tanstack/react-router";
import { CpuIcon } from "lucide-react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** A notice while the model server the selected agent is linked to is down, with ways to fix it. */
export function useInferenceOutageBannerItem(
  environmentId: EnvironmentId,
  provider: ServerProvider | null,
): ComposerBannerStackItem | null {
  const navigate = useNavigate();
  const servers = useEnvironmentSettings(environmentId, (settings) => settings.inferenceServers);
  const snapshots = useAtomValue(serverEnvironment.inferenceServersValueAtom(environmentId));
  const refresh = useAtomCommand(serverEnvironment.refreshInferenceServers, {
    reportFailure: false,
  });
  const outage = inferenceServerOutage({
    serverId: provider?.inferenceServerId,
    servers,
    snapshots: snapshots ?? [],
  });
  if (outage === null) return null;
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
