import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, InferenceUsageRow, InferenceUsageWindow } from "@t3tools/contracts";
import {
  INFERENCE_PURPOSE_LABELS,
  LOCAL_COMPUTE_FOOTNOTE,
  LOCAL_COMPUTE_WINDOWS,
  LOCAL_COMPUTE_WINDOW_LABELS,
  formatCachedShare,
  formatLocalComputeDistribution,
  groupLocalCompute,
  localComputeCachedShare,
  sumLocalCompute,
  type LocalComputeGroup,
} from "@t3tools/client-runtime/state/inference-presentation";
import { formatCount, formatTokens } from "@t3tools/shared/usageFormat";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { inferenceAtoms, serverEnvironment } from "../../state/server";
import { SettingsSection } from "../settings/components/SettingsSection";

const WINDOW_OPTIONS = LOCAL_COMPUTE_WINDOWS.map((window) => ({
  value: window,
  label: window,
  accessibilityLabel: `Past ${LOCAL_COMPUTE_WINDOW_LABELS[window]}`,
}));

/** Requests T3's gateway sent to the user's own inference servers, as on web's Usage page. */
export function UsageLocalCompute(props: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly initialWindow: InferenceUsageWindow;
}) {
  const [window, setWindow] = useState(props.initialWindow);
  const withServers = useAtomValue(
    inferenceAtoms.environmentsWithInferenceServersAtom(
      JSON.stringify(props.environments.map((environment) => environment.environmentId)),
    ),
  );
  if (withServers.length === 0) return null;
  const shown = props.environments.filter((environment) =>
    withServers.includes(environment.environmentId),
  );
  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between gap-3 px-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
          Local compute
        </Text>
        <SegmentedControl
          options={WINDOW_OPTIONS}
          selected={window}
          onSelect={setWindow}
          size="compact"
          className="w-36"
        />
      </View>
      {shown.map((environment) => (
        <EnvironmentLocalCompute
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={shown.length > 1 ? environment.label : undefined}
          window={window}
        />
      ))}
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {LOCAL_COMPUTE_FOOTNOTE}
      </Text>
    </View>
  );
}

function EnvironmentLocalCompute(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | undefined;
  readonly window: InferenceUsageWindow;
}) {
  const canRead = useAtomValue(
    serverEnvironment.getInferenceUsage.permissionAtom(props.environmentId),
  );
  return (
    <SettingsSection title={props.label}>
      {canRead ? (
        <LocalComputeGroups environmentId={props.environmentId} window={props.window} />
      ) : (
        <Text className="p-4 text-sm text-foreground-muted">
          This connection cannot read local compute usage.
        </Text>
      )}
    </SettingsSection>
  );
}

function LocalComputeGroups(props: {
  readonly environmentId: EnvironmentId;
  readonly window: InferenceUsageWindow;
}) {
  const result = useAtomValue(
    inferenceAtoms.inferenceUsageAtom({
      environmentId: props.environmentId,
      window: props.window,
    }),
  );
  const servers = useAtomValue(serverEnvironment.inferenceServersValueAtom(props.environmentId));
  const summary = AsyncResult.getOrElse(result, () => null);
  const groups = summary === null ? [] : groupLocalCompute(summary.rows, servers);
  if (summary === null || groups.length === 0) {
    return (
      <Text className="p-4 text-center text-sm text-foreground-muted">
        {summary !== null
          ? `No requests through T3 in the last ${LOCAL_COMPUTE_WINDOW_LABELS[props.window]}.`
          : result._tag === "Failure"
            ? "This environment could not report local compute usage."
            : "Loading…"}
      </Text>
    );
  }
  return groups.map((group, index) => (
    <LocalComputeGroupItem key={group.key} group={group} divider={index > 0} />
  ));
}

function LocalComputeGroupItem(props: {
  readonly group: LocalComputeGroup;
  readonly divider: boolean;
}) {
  const { group } = props;
  const single = group.rows.length === 1 ? group.rows[0]! : null;
  return (
    <View className={cn("gap-1 p-4", props.divider && "border-t border-border-subtle")}>
      <Text className="text-base text-foreground" numberOfLines={2}>
        {`${group.serverName} · ${group.model}`}
        {single ? (
          <Text className="text-sm text-foreground-muted">
            {`  ${INFERENCE_PURPOSE_LABELS[single.purpose]}`}
          </Text>
        ) : null}
      </Text>
      <Counts rows={group.rows} />
      {group.rows.map((row) => (
        <Measured key={row.purpose} row={row} purpose={single === null} />
      ))}
    </View>
  );
}

function Counts(props: { readonly rows: ReadonlyArray<InferenceUsageRow> }) {
  const totals = sumLocalCompute(props.rows);
  return (
    <Text className="text-sm tabular-nums text-foreground-muted">
      {`${formatCount(totals.requests)} requests `}
      <Text
        className={cn(
          "text-sm",
          totals.failed > 0 ? "text-warning-foreground" : "text-foreground-muted",
        )}
      >
        {`(${formatCount(totals.failed)} failed)`}
      </Text>
      {` · prompt ${formatTokens(totals.promptTokens)} · cached ${formatCachedShare(
        localComputeCachedShare(totals),
      )} · output ${formatTokens(totals.completionTokens)}`}
    </Text>
  );
}

/** One purpose's percentiles; they cannot be combined across purposes. */
function Measured(props: { readonly row: InferenceUsageRow; readonly purpose: boolean }) {
  const { row } = props;
  const parts = [
    `TTFT p50/p95 ${formatLocalComputeDistribution(row.ttftMs, "seconds")} (n=${formatCount(row.ttftMs.n)})`,
    `decode p50 ${formatLocalComputeDistribution(row.decodeTokensPerSecond, "rate")} (n=${formatCount(row.decodeTokensPerSecond.n)})`,
    `queue wait p50/p95 ${formatLocalComputeDistribution(row.queueWaitMs, "seconds")} (n=${formatCount(row.queueWaitMs.n)})`,
  ].join(" · ");
  return (
    <View className={cn(props.purpose && "mt-1 gap-0.5")}>
      {props.purpose ? (
        <>
          <Text className="text-sm text-foreground">{INFERENCE_PURPOSE_LABELS[row.purpose]}</Text>
          <Counts rows={[row]} />
        </>
      ) : null}
      <Text className="text-sm tabular-nums text-foreground-muted">{parts}</Text>
    </View>
  );
}
