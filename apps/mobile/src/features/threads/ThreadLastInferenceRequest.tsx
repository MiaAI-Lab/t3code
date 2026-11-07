import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatLastInferenceRequestMeasures,
  formatLastRequestServer,
  inferenceServerSnapshotName,
  lastRequestObservations,
} from "@t3tools/client-runtime/state/inference-presentation";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { inferenceAtoms, serverEnvironment } from "../../state/server";

interface ThreadKey {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Measured numbers for the thread's latest request through T3's gateway, read when the sheet opens. */
export function ThreadLastInferenceRequest(props: ThreadKey) {
  const hasServers = useAtomValue(inferenceAtoms.hasInferenceServersAtom(props.environmentId));
  const canRead = useAtomValue(
    serverEnvironment.getThreadInferenceRequest.permissionAtom(props.environmentId),
  );
  return hasServers && canRead ? <LastRequest {...props} /> : null;
}

function LastRequest(props: ThreadKey) {
  const result = useAtomValue(inferenceAtoms.threadInferenceRequestAtom(props));
  const servers = useAtomValue(serverEnvironment.inferenceServersValueAtom(props.environmentId));
  const last = AsyncResult.getOrElse(result, () => null)?.last ?? null;
  if (last === null) return null;
  return (
    <>
      <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">
        Last request
      </Text>
      <View className="mx-4 mb-3 gap-1 rounded-2xl bg-grouped-card px-4 py-3">
        <Text className="text-sm tabular-nums text-foreground">
          {formatLastInferenceRequestMeasures(last)}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {`${last.model} · ${formatLastRequestServer(last, (id) =>
            inferenceServerSnapshotName(servers, id),
          )}`}
        </Text>
        {lastRequestObservations(last).map((observation) => (
          <Text key={observation} className="text-sm text-foreground-muted">
            {observation}
          </Text>
        ))}
        <Text className="text-xs text-foreground-muted">Measured by T3&apos;s gateway</Text>
      </View>
    </>
  );
}
