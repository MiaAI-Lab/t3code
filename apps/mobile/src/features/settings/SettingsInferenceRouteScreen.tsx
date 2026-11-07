import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  InferenceServerConfig,
  InferenceServerId,
  InferenceServerSnapshot,
} from "@t3tools/contracts";
import {
  describeInferenceModelContext,
  describeInferencePromptCache,
  describeInferenceServerFallback,
  describeInferenceServerLoad,
  describeInferenceServerProbeFreshness,
  inferenceServerDetails,
  inferenceServerDisplayName,
  inferenceServerRequestHealth,
  presentInferenceServers,
} from "@t3tools/client-runtime/state/inference-presentation";
import { INFERENCE_SERVER_STATUS_LABELS } from "@t3tools/client-runtime/state/provider-instance-display";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { type ReactNode, use, useState, useSyncExternalStore } from "react";
import { RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { inferenceAtoms, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

const USAGE_WINDOW = "24h";
const NO_SNAPSHOTS: ReadonlyArray<InferenceServerSnapshot> = [];

/** Read-only: servers are added, edited and linked in web or desktop Settings. */
export function SettingsInferenceRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  const registry = use(RegistryContext);
  const refresh = useAtomCommand(serverEnvironment.refreshInferenceServers, {
    label: "refresh inference servers",
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all(
      selectedTargets.map(async ({ environmentId }) => {
        if (!registry.get(serverEnvironment.refreshInferenceServers.permissionAtom(environmentId)))
          return;
        await refresh({ environmentId, input: {} });
        if (registry.get(serverEnvironment.getInferenceUsage.permissionAtom(environmentId))) {
          registry.refresh(
            inferenceAtoms.inferenceUsageAtom({ environmentId, window: USAGE_WINDOW }),
          );
        }
      }),
    );
    setRefreshing(false);
  };
  return (
    <SettingsScreen title="Inference" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          selectedTargets.length > 0 ? (
            <RefreshControl refreshing={refreshing} onRefresh={() => void refreshAll()} />
          ) : undefined
        }
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Select a connected environment.</Text>
        ) : (
          selectedTargets.map((target) => (
            <EnvironmentInferenceServers key={target.environmentId} target={target} />
          ))
        )}
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          Add, edit and link inference servers in web or desktop Settings → Inference.
        </Text>
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentInferenceServers({ target }: { readonly target: SettingsTarget }) {
  const environmentId = target.environmentId;
  const settings = target.serverConfig.settings;
  const servers = settings.inferenceServers;
  const entries = presentInferenceServers(servers);
  const snapshots =
    useAtomValue(serverEnvironment.inferenceServersValueAtom(environmentId)) ?? NO_SNAPSHOTS;
  const canReadUsage = useAtomValue(
    serverEnvironment.getInferenceUsage.permissionAtom(environmentId),
  );
  const probeIntervalMs = Duration.toMillis(
    resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
  );
  return (
    <SettingsSection title={target.label}>
      {entries.length === 0 ? (
        <Text className="p-4 text-foreground-muted">No inference servers registered.</Text>
      ) : (
        entries.map(([id, config], index) => (
          <InferenceServerItem
            key={id}
            id={id}
            environmentId={environmentId}
            config={config}
            fallback={describeInferenceServerFallback(config, servers)}
            snapshot={snapshots.find((candidate) => candidate.id === id)}
            probeIntervalMs={probeIntervalMs}
            canReadUsage={canReadUsage}
            divider={index > 0}
          />
        ))
      )}
    </SettingsSection>
  );
}

function InferenceServerItem(props: {
  readonly id: InferenceServerId;
  readonly environmentId: EnvironmentId;
  readonly config: InferenceServerConfig;
  readonly fallback: string | null;
  readonly snapshot: InferenceServerSnapshot | undefined;
  readonly probeIntervalMs: number;
  readonly canReadUsage: boolean;
  readonly divider: boolean;
}) {
  const { config } = props;
  const current = config.enabled && props.snapshot?.enabled ? props.snapshot : undefined;
  const load = current ? describeInferenceServerLoad(current) : null;
  const promptCache = current ? describeInferencePromptCache(current) : null;
  const status = !config.enabled
    ? "Disabled"
    : current
      ? INFERENCE_SERVER_STATUS_LABELS[current.status]
      : null;
  return (
    <View className={cn("gap-1 p-4", props.divider && "border-t border-border-subtle")}>
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 shrink text-base text-foreground" numberOfLines={1}>
          {inferenceServerDisplayName(props.id, config)}
        </Text>
        {status ? (
          <Text
            className={cn(
              "text-sm",
              current?.status === "unreachable" || current?.status === "error"
                ? "text-warning-foreground"
                : "text-foreground-muted",
            )}
          >
            {status}
          </Text>
        ) : null}
      </View>
      <Detail selectable>
        {inferenceServerDetails(config, current, props.fallback).join(" · ")}
      </Detail>
      {!config.enabled ? null : current ? (
        <>
          {current.message ? <Detail>{current.message}</Detail> : null}
          {current.checkedAt ? (
            <ProbeFreshness checkedAt={current.checkedAt} probeIntervalMs={props.probeIntervalMs} />
          ) : null}
          {props.canReadUsage ? (
            <RequestHealth environmentId={props.environmentId} serverId={props.id} />
          ) : null}
          {load ? <Detail>{load}</Detail> : null}
          {promptCache ? <Detail>{promptCache.summary}</Detail> : null}
          {promptCache?.warning ? (
            <Detail warning>
              {promptCache.warning} {promptCache.advice}
            </Detail>
          ) : promptCache?.advice ? (
            <Detail>{promptCache.advice}</Detail>
          ) : null}
          {current.models.map((model) => {
            const context = describeInferenceModelContext(model);
            return (
              <Detail key={model.id}>
                <Text className="font-mono text-sm text-foreground">{model.id}</Text>
                {context ? ` · ${context}` : null}
              </Detail>
            );
          })}
          {current.models.length === 0 && current.status === "ready" ? (
            <Detail>No models reported.</Detail>
          ) : null}
        </>
      ) : (
        <Detail>Not checked yet.</Detail>
      )}
    </View>
  );
}

function Detail(props: {
  readonly children: ReactNode;
  readonly warning?: boolean;
  readonly selectable?: boolean;
}) {
  return (
    <Text
      selectable={props.selectable}
      className={cn("text-sm", props.warning ? "text-warning-foreground" : "text-foreground-muted")}
    >
      {props.children}
    </Text>
  );
}

/** Re-renders only when the label or staleness changes, at most once a minute. */
function ProbeFreshness(props: { readonly checkedAt: string; readonly probeIntervalMs: number }) {
  const read = () =>
    describeInferenceServerProbeFreshness(props.checkedAt, props.probeIntervalMs, Date.now());
  const subscribe = (onChange: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delayMs = read()?.msUntilChange;
      if (delayMs === undefined || delayMs === null) return;
      timer = setTimeout(() => {
        onChange();
        schedule();
      }, delayMs);
    };
    schedule();
    return () => clearTimeout(timer);
  };
  const readLabel = () => read()?.label ?? null;
  const readStale = () => read()?.stale ?? false;
  const label = useSyncExternalStore(subscribe, readLabel, readLabel);
  const stale = useSyncExternalStore(subscribe, readStale, readStale);
  if (label === null) return null;
  return stale ? <Detail warning>{`${label}, overdue`}</Detail> : <Detail>{label}</Detail>;
}

function RequestHealth(props: {
  readonly environmentId: EnvironmentId;
  readonly serverId: InferenceServerId;
}) {
  const summary = AsyncResult.getOrElse(
    useAtomValue(
      inferenceAtoms.inferenceUsageAtom({
        environmentId: props.environmentId,
        window: USAGE_WINDOW,
      }),
    ),
    () => null,
  );
  if (summary === null) return null;
  const health = inferenceServerRequestHealth(summary, props.serverId);
  return (
    <>
      <Detail>Reports cached tokens: {health.reportsCachedTokens ? "yes" : "unknown"}</Detail>
      {health.recentFailure ? (
        <Detail>
          {`Last request ${health.recentFailure.status} at ${new Date(
            health.recentFailure.at,
          ).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
        </Detail>
      ) : null}
    </>
  );
}
