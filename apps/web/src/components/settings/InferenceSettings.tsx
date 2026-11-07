import type {
  EnvironmentId,
  InferenceServerConfig,
  InferenceServerId,
  InferenceServerModel,
  InferenceServerSnapshot,
  InferenceServerStatus,
} from "@t3tools/contracts";
import { INFERENCE_SERVER_STATUS_LABELS } from "@t3tools/client-runtime/state/provider-instance-display";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { EnvironmentPresentation } from "../../state/environments";
import { inferenceUsageAtom } from "../../state/inference";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatShortTimestamp } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Switch } from "../ui/switch";
import { InferenceServerDialog } from "./InferenceServerDialog";
import { FindInferenceServerDialog } from "./FindInferenceServerDialog";
import { knownServerModelIds } from "./localModelSetup.logic";
import { UseLocalModelDialog } from "./UseLocalModelDialog";
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
import { inferenceServerRemovalPatch } from "./InferenceSettings.logic";
import {
  classifyProviderEnvironmentAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const EMPTY_STATE =
  "Register the model servers on this machine or your network (Ollama, LM Studio, llama.cpp, vLLM, SGLang). localhost means the machine running this environment.";

const STATUS_BADGE_VARIANTS = {
  checking: "outline",
  ready: "success",
  unreachable: "warning",
  error: "error",
} as const satisfies Record<InferenceServerStatus, string>;

const NO_SNAPSHOTS: ReadonlyArray<InferenceServerSnapshot> = [];
const USAGE_WINDOW = "24h";

export function InferenceSettingsPanel({
  openLocalSetup = false,
  repairServerId,
  onLinkHandled,
}: {
  /** Opens "Use a local model", as links from elsewhere ask. */
  readonly openLocalSetup?: boolean;
  /** Opens "Find" for this server, as the composer's outage notice asks. */
  readonly repairServerId?: string | undefined;
  /** Clears the link's request once its dialog closes, so the same link works again. */
  readonly onLinkHandled?: () => void;
}) {
  const { scope, environment } = useSettingsScope();
  // Servers without inference support (such as upstream's release) omit the snapshot field.
  const lacksInference =
    environment?.serverConfig != null && environment.serverConfig.inferenceServers === undefined;
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" && lacksInference ? (
        <SettingsSection {...searchableSetting("inference-servers")}>
          <SettingsRow
            title={`${environment.label} runs a T3 Code server without inference servers.`}
            description={
              environment.entry.target._tag === "SshConnectionTarget"
                ? "Restart this app to install its own server there. It updates SSH machines each time it connects."
                : "Install this app's server on that machine to use model servers there."
            }
          />
        </SettingsSection>
      ) : environment?.connection.phase === "connected" ? (
        <EnvironmentInferenceServers
          key={environment.environmentId}
          environment={environment}
          projectScoped={scope.kind === "project" || scope.kind === "checkout"}
          openLocalSetup={openLocalSetup}
          repairServerId={repairServerId}
          onLinkHandled={onLinkHandled}
        />
      ) : (
        <SettingsSection {...searchableSetting("inference-servers")}>
          <SettingsRow
            title="No environment connected."
            description="Connect an environment to register the model servers it can reach."
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentInferenceServers({
  environment,
  projectScoped,
  openLocalSetup,
  repairServerId,
  onLinkHandled,
}: {
  readonly environment: EnvironmentPresentation;
  readonly projectScoped: boolean;
  readonly openLocalSetup: boolean;
  readonly repairServerId: string | undefined;
  readonly onLinkHandled: (() => void) | undefined;
}) {
  const environmentId = environment.environmentId;
  const sessionState = useEnvironmentSessionState(environmentId);
  // The server requires the provider-management grant for inference servers.
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess: resolveRemoteOperateAccess({
      session: sessionState.data,
      isPending: sessionState.isPending,
      hasError: sessionState.hasError,
    }),
  });
  const readOnly = access.kind !== "editable" || projectScoped;
  const servers = useEnvironmentSettings(environmentId, (settings) => settings.inferenceServers);
  const snapshots =
    useAtomValue(serverEnvironment.inferenceServersValueAtom(environmentId)) ?? NO_SNAPSHOTS;
  const probeIntervalMs = useEnvironmentSettings(environmentId, (settings) =>
    Duration.toMillis(
      resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
  );
  const canReadUsage = useAtomValue(
    serverEnvironment.getInferenceUsage.permissionAtom(environmentId),
  );
  const refreshUsage = useAtomRefresh(inferenceUsageAtom({ environmentId, window: USAGE_WINDOW }));
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canRefresh = useAtomValue(
    serverEnvironment.refreshInferenceServers.permissionAtom(environmentId),
  );
  const refresh = useAtomCommand(serverEnvironment.refreshInferenceServers, {
    label: "refresh inference servers",
  });
  const [refreshing, setRefreshing] = useState(false);
  const canDiscover = useAtomValue(
    serverEnvironment.discoverInferenceServers.permissionAtom(environmentId),
  );
  const [localSetupRequested, setLocalSetupRequested] = useState(false);
  const localSetupOpen = localSetupRequested || openLocalSetup;
  const closeLocalSetup = () => {
    setLocalSetupRequested(false);
    if (openLocalSetup) onLinkHandled?.();
  };
  const [findingRequested, setFinding] = useState<InferenceServerId | null>(null);
  const finding = findingRequested ?? (repairServerId as InferenceServerId | undefined) ?? null;
  const closeFinding = () => {
    setFinding(null);
    if (repairServerId !== undefined) onLinkHandled?.();
  };
  const selections = useEnvironmentSettings(environmentId, (settings) => [
    settings.defaultModelSelection,
    settings.textGenerationModelSelection,
  ]);
  const [dialog, setDialog] = useState<
    null | { readonly mode: "add" } | { readonly mode: "edit"; readonly id: InferenceServerId }
  >(null);
  const entries = presentInferenceServers(servers);
  const editingConfig = dialog?.mode === "edit" ? (servers?.[dialog.id] ?? undefined) : undefined;
  const editing =
    dialog?.mode === "edit" && editingConfig !== undefined
      ? { id: dialog.id, config: editingConfig }
      : undefined;

  const refreshAll = async () => {
    setRefreshing(true);
    await refresh({ environmentId, input: {} });
    if (canReadUsage) refreshUsage();
    setRefreshing(false);
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("inference-servers")}
        headerAction={
          <div className="flex items-center gap-1">
            {entries.length > 0 ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={refreshing || !canRefresh}
                aria-busy={refreshing}
                onClick={() => void refreshAll()}
              >
                <RefreshIcon refreshing={refreshing} />
                {refreshing ? "Checking" : "Refresh"}
              </Button>
            ) : null}
            {!readOnly && canDiscover ? (
              <Button size="xs" variant="outline" onClick={() => setLocalSetupRequested(true)}>
                <SearchIcon className="size-3" aria-hidden />
                Find servers
              </Button>
            ) : null}
            {!readOnly ? (
              <Button size="xs" variant="outline" onClick={() => setDialog({ mode: "add" })}>
                <PlusIcon className="size-3" aria-hidden />
                Add server
              </Button>
            ) : null}
          </div>
        }
      >
        {projectScoped ? (
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            Environment-wide setting. Select an environment to change it.
          </p>
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow
            title="No model servers yet."
            description={EMPTY_STATE}
            control={
              !readOnly && canDiscover ? (
                <Button size="sm" onClick={() => setLocalSetupRequested(true)}>
                  Find local models
                </Button>
              ) : null
            }
          />
        ) : (
          entries.map(([id, config]) => (
            <InferenceServerRow
              key={id}
              id={id}
              environmentId={environmentId}
              config={config}
              probeIntervalMs={probeIntervalMs}
              canReadUsage={canReadUsage}
              fallback={describeInferenceServerFallback(config, servers)}
              snapshot={snapshots.find((candidate) => candidate.id === id)}
              readOnly={readOnly}
              onEdit={() => setDialog({ mode: "edit", id })}
              onCheckAgain={() => void refresh({ environmentId, input: { id } })}
              onFind={canDiscover ? () => setFinding(id) : undefined}
              onEnabledChange={(enabled) =>
                updateSettings({ inferenceServers: { [id]: { ...config, enabled } } })
              }
              onRemove={() =>
                updateSettings({ inferenceServers: inferenceServerRemovalPatch(servers, id) })
              }
            />
          ))
        )}
      </SettingsSection>
      {finding !== null && !readOnly && servers?.[finding] ? (
        <FindInferenceServerDialog
          environmentId={environmentId}
          id={finding}
          name={inferenceServerDisplayName(finding, servers[finding])}
          config={servers[finding]}
          knownModelIds={knownServerModelIds(
            finding,
            snapshots.find((snapshot) => snapshot.id === finding)?.models ?? [],
            selections,
          )}
          onChangeAddress={() => {
            closeFinding();
            setDialog({ mode: "edit", id: finding });
          }}
          onClose={closeFinding}
        />
      ) : null}
      {localSetupOpen && !readOnly ? (
        <UseLocalModelDialog
          environmentId={environmentId}
          machineLabel={environment.label}
          onClose={closeLocalSetup}
        />
      ) : null}
      {dialog !== null && !readOnly && (dialog.mode === "add" || editing !== undefined) ? (
        <InferenceServerDialog
          onClose={() => setDialog(null)}
          environmentId={environmentId}
          environmentLabel={environment.label}
          existingIds={new Set(Object.keys(servers))}
          fallbackOptions={entries
            .filter(([id]) => dialog.mode === "add" || id !== dialog.id)
            .map(([id, config]) => ({ id, name: inferenceServerDisplayName(id, config) }))}
          {...(editing === undefined ? {} : { existing: editing })}
        />
      ) : null}
    </>
  );
}

function InferenceServerRow({
  id,
  environmentId,
  config,
  probeIntervalMs,
  canReadUsage,
  fallback,
  snapshot,
  readOnly,
  onEdit,
  onCheckAgain,
  onFind,
  onEnabledChange,
  onRemove,
}: {
  readonly id: InferenceServerId;
  readonly environmentId: EnvironmentId;
  readonly config: InferenceServerConfig;
  readonly probeIntervalMs: number;
  readonly canReadUsage: boolean;
  readonly fallback: string | null;
  readonly snapshot: InferenceServerSnapshot | undefined;
  readonly readOnly: boolean;
  readonly onEdit: () => void;
  readonly onCheckAgain: () => void;
  readonly onFind: (() => void) | undefined;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onRemove: () => void;
}) {
  const name = inferenceServerDisplayName(id, config);
  const current = config.enabled && snapshot?.enabled ? snapshot : undefined;
  const down = current?.status === "unreachable" || current?.status === "error";
  const load = current ? describeInferenceServerLoad(current) : null;
  const promptCache = current ? describeInferencePromptCache(current) : null;
  const details = inferenceServerDetails(config, current, fallback);
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 wrap-anywhere">{name}</span>
          {!config.enabled ? (
            <Badge variant="outline" size="sm">
              Disabled
            </Badge>
          ) : current ? (
            <Badge variant={STATUS_BADGE_VARIANTS[current.status]} size="sm">
              {INFERENCE_SERVER_STATUS_LABELS[current.status]}
            </Badge>
          ) : null}
        </span>
      }
      description={<span className="break-all">{details.join(" · ")}</span>}
      status={
        config.enabled ? (
          current ? (
            <div className="grid gap-1">
              {current.message ? <p className="wrap-anywhere">{current.message}</p> : null}
              {down && !readOnly ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button size="xs" variant="outline" onClick={onCheckAgain}>
                    Check again
                  </Button>
                  {onFind ? (
                    <Button size="xs" variant="outline" onClick={onFind}>
                      <SearchIcon className="size-3" aria-hidden />
                      Find server
                    </Button>
                  ) : null}
                  <Button size="xs" variant="outline" onClick={onEdit}>
                    Change address
                  </Button>
                </div>
              ) : null}
              {current.checkedAt ? (
                <InferenceServerProbeFreshness
                  checkedAt={current.checkedAt}
                  probeIntervalMs={probeIntervalMs}
                />
              ) : null}
              {canReadUsage ? (
                <InferenceServerRequestHealth environmentId={environmentId} serverId={id} />
              ) : null}
              {load ? <p>{load}</p> : null}
              {promptCache ? <p>{promptCache.summary}</p> : null}
              {promptCache?.warning ? (
                <p className="text-warning">
                  {promptCache.warning} {promptCache.advice}
                </p>
              ) : promptCache?.advice ? (
                <p>{promptCache.advice}</p>
              ) : null}
              {current.models.length > 0 ? (
                <ul className="grid gap-0.5">
                  {current.models.map((model) => {
                    const context = describeInferenceModelContext(model);
                    return (
                      <li key={model.id} className="wrap-anywhere">
                        <span className="font-mono text-foreground">{model.id}</span>
                        {context ? ` · ${context}` : null}
                        <InferenceModelImages
                          environmentId={environmentId}
                          serverId={id}
                          model={model}
                          canCheck={!readOnly && current.status === "ready"}
                        />
                      </li>
                    );
                  })}
                </ul>
              ) : current.status === "ready" ? (
                <p>No models reported.</p>
              ) : null}
            </div>
          ) : (
            "Not checked yet."
          )
        ) : null
      }
      control={
        !readOnly ? (
          <div className="flex items-center gap-1">
            <Switch
              checked={config.enabled}
              onCheckedChange={(checked) => onEnabledChange(Boolean(checked))}
              aria-label={`Use ${name}`}
            />
            <Button size="xs" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
            <RemoveInferenceServerButton label={name} onConfirm={onRemove} />
          </div>
        ) : null
      }
    />
  );
}

// A server can swap the weights behind a model id, so a day-old check is offered again.
const IMAGE_CHECK_STALE_MS = 24 * 60 * 60_000;

/** Whether a model reads images, and a way to check by sending it test images. */
function InferenceModelImages({
  environmentId,
  serverId,
  model,
  canCheck,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverId: InferenceServerId;
  readonly model: InferenceServerModel;
  readonly canCheck: boolean;
}) {
  const check = useAtomCommand(serverEnvironment.checkInferenceModelImages, {
    label: "check images",
  });
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const nowMinute = useNowMinute();
  const image = model.capabilities?.image;
  const stale =
    image?.checkedAt !== undefined &&
    Date.parse(`${nowMinute}Z`) - Date.parse(image.checkedAt) > IMAGE_CHECK_STALE_MS;
  const runCheck = async () => {
    setChecking(true);
    setNote(null);
    const result = await check({ environmentId, input: { serverId, model: model.id } });
    setChecking(false);
    // A verdict arrives with the server's next snapshot; only an inconclusive check needs words.
    if (result._tag === "Success" && result.value.outcome === "unknown") {
      setNote(result.value.detail);
    }
  };
  return (
    <>
      {image ? ` · ${image.supported ? "Reads images" : "Text only"}` : null}
      {canCheck && (image === undefined || stale) ? (
        <>
          {" "}
          <Button size="xs" variant="ghost" disabled={checking} onClick={() => void runCheck()}>
            {checking ? "Checking images" : image ? "Check images again" : "Check images"}
          </Button>
        </>
      ) : null}
      {note ? <span className="block text-warning">{note}</span> : null}
    </>
  );
}

/** Re-renders only when the label or staleness changes, at most once a minute. */
function InferenceServerProbeFreshness({
  checkedAt,
  probeIntervalMs,
}: {
  readonly checkedAt: string;
  readonly probeIntervalMs: number;
}) {
  const subscribe = (onChange: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delayMs = describeInferenceServerProbeFreshness(
        checkedAt,
        probeIntervalMs,
        Date.now(),
      )?.msUntilChange;
      if (delayMs === undefined || delayMs === null) return;
      timer = setTimeout(() => {
        onChange();
        schedule();
      }, delayMs);
    };
    schedule();
    return () => clearTimeout(timer);
  };
  const read = () => describeInferenceServerProbeFreshness(checkedAt, probeIntervalMs, Date.now());
  const readLabel = () => read()?.label ?? null;
  const readStale = () => read()?.stale ?? false;
  const label = useSyncExternalStore(subscribe, readLabel, readLabel);
  const stale = useSyncExternalStore(subscribe, readStale, readStale);
  if (label === null) return null;
  return stale ? <p className="text-warning">{label}, overdue</p> : <p>{label}</p>;
}

function InferenceServerRequestHealth({
  environmentId,
  serverId,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverId: InferenceServerId;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const summary = AsyncResult.getOrElse(
    useAtomValue(inferenceUsageAtom({ environmentId, window: USAGE_WINDOW })),
    () => null,
  );
  if (summary === null) return null;
  const health = inferenceServerRequestHealth(summary, serverId);
  return (
    <>
      <p>Reports cached tokens: {health.reportsCachedTokens ? "yes" : "unknown"}</p>
      {health.recentFailure ? (
        <p>
          Last request {health.recentFailure.status} at{" "}
          {formatShortTimestamp(health.recentFailure.at, timestampFormat)}
        </p>
      ) : null}
    </>
  );
}

function RemoveInferenceServerButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its API key is deleted from this environment. Provider instances linked to it show a
              warning until you link them elsewhere, and servers that fall back to it stop doing so.
              The server itself is untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove server
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
