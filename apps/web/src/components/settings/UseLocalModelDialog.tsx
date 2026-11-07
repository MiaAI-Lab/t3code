import type {
  EnvironmentId,
  InferenceDiscoveredServer,
  InferenceDiscoveryResult,
  ProviderDriverKind,
  ServerProvider,
} from "@t3tools/contracts";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { describeInferenceModelContext } from "@t3tools/client-runtime/state/inference-presentation";
import * as Result from "effect/Result";
import { CheckIcon, CpuIcon, SearchIcon } from "lucide-react";
import { useContext, useEffect, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { normalizeInferenceServerBaseUrl } from "./InferenceSettings.logic";
import {
  describeBackgroundWriting,
  linkedModelSlug,
  localModelAgentChoices,
  planLocalModelSetup,
} from "./localModelSetup.logic";

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

type Search =
  | { readonly status: "searching" }
  | { readonly status: "done"; readonly result: InferenceDiscoveryResult }
  | { readonly status: "failed"; readonly message: string };

type Progress =
  | { readonly step: "choose" }
  | { readonly step: "connecting"; readonly message: string }
  | { readonly step: "done"; readonly lines: ReadonlyArray<string>; readonly note: string }
  | {
      readonly step: "incomplete";
      readonly title: string;
      readonly message: string;
      readonly canRetry: boolean;
    };

type Selection = { readonly baseUrl: string; readonly modelId: string };

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
};

const searchFromResult = (result: AtomCommandResult<InferenceDiscoveryResult, unknown>): Search =>
  result._tag === "Failure"
    ? { status: "failed", message: failureMessage(result) }
    : { status: "done", result: result.value };

/** A server already in use comes first, so reopening the dialog does not suggest a switch. */
function defaultSelection(servers: ReadonlyArray<InferenceDiscoveredServer>): Selection | null {
  const ready = servers.filter((server) => server.status === "ready");
  const pick = ready.find((server) => server.registeredServerId !== undefined) ?? ready[0];
  const model = pick?.models[0];
  return pick === undefined || model === undefined
    ? null
    : { baseUrl: pick.baseUrl, modelId: model.id };
}

/**
 * Finds model servers on one environment and makes one of its models the default for new threads:
 * register the server, link an agent to it, then pick the model the agent lists for it.
 */
export function UseLocalModelDialog({
  environmentId,
  machineLabel,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly onClose: () => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? NO_PROVIDERS;
  const discover = useAtomCommand(serverEnvironment.discoverInferenceServers, {
    reportFailure: false,
  });
  const refreshServers = useAtomCommand(serverEnvironment.refreshInferenceServers, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  const [search, setSearch] = useState<Search>({ status: "searching" });
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Selection | null>(null);
  const [driver, setDriver] = useState<ProviderDriverKind | null>(null);
  const [progress, setProgress] = useState<Progress>({ step: "choose" });

  const registry = useContext(RegistryContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- searches the environment's machine once when the dialog opens
  useEffect(() => {
    let active = true;
    void runAtomCommand(
      registry,
      serverEnvironment.discoverInferenceServers,
      { environmentId, input: {} },
      { label: "discover inference servers", reportFailure: false, reportDefect: true },
    ).then((result) => {
      if (active) setSearch(searchFromResult(result));
    });
    return () => {
      active = false;
    };
  }, [environmentId, registry]);

  const runSearch = async (baseUrl?: string) => {
    setSearch({ status: "searching" });
    const result = await discover({
      environmentId,
      input: baseUrl === undefined ? {} : { baseUrl },
    });
    setSearch(searchFromResult(result));
    const typed =
      result._tag === "Success" && baseUrl !== undefined
        ? result.value.servers.find((server) => server.baseUrl === baseUrl)
        : undefined;
    if (typed?.status === "ready" && typed.models[0] !== undefined) {
      setChosen({ baseUrl: typed.baseUrl, modelId: typed.models[0].id });
    }
  };

  const servers = search.status === "done" ? search.result.servers : [];
  const selection =
    chosen !== null &&
    servers.some(
      (server) =>
        server.baseUrl === chosen.baseUrl &&
        server.models.some((model) => model.id === chosen.modelId),
    )
      ? chosen
      : defaultSelection(servers);
  const selectedServer = servers.find((server) => server.baseUrl === selection?.baseUrl);
  const choices =
    selectedServer === undefined
      ? []
      : localModelAgentChoices(selectedServer, providers, machineLabel);
  const chosenDriver =
    choices.find((choice) => choice.driver === driver && choice.unavailableReason === undefined)
      ?.driver ?? choices.find((choice) => choice.recommended)?.driver;
  const chosenAgent = choices.find((choice) => choice.driver === chosenDriver);
  const plan =
    selectedServer === undefined || chosenAgent === undefined
      ? null
      : planLocalModelSetup({
          settings,
          server: selectedServer,
          driver: chosenAgent.driver,
          agentLabel: chosenAgent.label,
          machineLabel,
        });

  const loadModelAndFinish = async (
    { instanceId, serverId, serverName }: NonNullable<typeof plan>,
    modelId: string,
    agentLabel: string,
  ) => {
    setProgress({ step: "connecting", message: `Loading the models ${agentLabel} lists…` });
    const refreshed = await refreshProviders({
      environmentId,
      input: { instanceId, refreshModels: true },
    });
    const listed =
      refreshed._tag === "Success"
        ? refreshed.value.providers.find((provider) => provider.instanceId === instanceId)
        : undefined;
    if (listed?.installed === false) {
      setProgress({
        step: "incomplete",
        title: `${agentLabel} is not installed on ${machineLabel}`,
        message: `${serverName} is saved and linked. Install ${agentLabel}, or pick another agent and try again.`,
        canRetry: true,
      });
      return;
    }
    const slug = linkedModelSlug(listed?.models ?? [], serverId, modelId);
    if (slug === undefined) {
      setProgress({
        step: "incomplete",
        title: `${agentLabel} does not list ${modelId} yet`,
        message: `${agentLabel} is linked to ${serverName}, but its model list has not caught up. Try again in a moment.`,
        canRetry: true,
      });
      return;
    }
    const saved = await saveSettings({
      environmentId,
      input: { patch: { defaultModelSelection: { instanceId, model: slug } } },
    });
    if (saved._tag === "Failure") {
      setProgress({
        step: "incomplete",
        title: "The default model was not saved",
        message: failureMessage(saved),
        canRetry: true,
      });
      return;
    }
    setProgress({
      step: "done",
      lines: [
        `Model server: ${serverName}`,
        `Agent: ${agentLabel}`,
        `New threads on ${machineLabel} use ${modelId}`,
      ],
      note: `Background writing (titles, commit messages, pull request text) uses ${describeBackgroundWriting(settings)}.`,
    });
  };

  const connect = async () => {
    if (plan === null || chosenAgent === undefined || selection === null) return;
    setProgress({ step: "connecting", message: "Saving…" });
    const patch =
      plan.serverConfig === null
        ? {}
        : { inferenceServers: { [plan.serverId]: plan.serverConfig } };
    if (plan.instanceMutation !== null || plan.serverConfig !== null) {
      const saved = await saveSettings({
        environmentId,
        input: {
          patch,
          ...(plan.instanceMutation === null
            ? {}
            : { providerInstanceMutation: plan.instanceMutation }),
        },
      });
      if (saved._tag === "Failure") {
        setProgress({
          step: "incomplete",
          title: "Nothing was saved",
          message: failureMessage(saved),
          canRetry: false,
        });
        return;
      }
    }
    setProgress({ step: "connecting", message: `Checking ${plan.serverName}…` });
    const checked = await refreshServers({ environmentId, input: { id: plan.serverId } });
    const snapshot =
      checked._tag === "Success"
        ? checked.value.inferenceServers.find((server) => server.id === plan.serverId)
        : undefined;
    if (snapshot?.status !== "ready") {
      setProgress({
        step: "incomplete",
        title: `${plan.serverName} is saved but not ready`,
        message: snapshot?.message ?? "It did not answer the check. Start it and try again.",
        canRetry: true,
      });
      return;
    }
    await loadModelAndFinish(plan, selection.modelId, chosenAgent.label);
  };

  const checkAddress = () => {
    const normalized = normalizeInferenceServerBaseUrl(address);
    if (Result.isFailure(normalized)) {
      setAddressError(normalized.failure);
      return;
    }
    setAddressError(null);
    void runSearch(normalized.success);
  };

  const busy = progress.step === "connecting";
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Use a local model</DialogTitle>
          <DialogDescription>
            Find a model server on {machineLabel} (Ollama, LM Studio, llama.cpp, vLLM, SGLang,
            TensorFold) and run new threads on it. Nothing leaves your hardware.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {progress.step === "done" ? (
            <div className="grid gap-3">
              <ul className="grid gap-1.5 text-sm">
                {progress.lines.map((line) => (
                  <li key={line} className="flex items-center gap-2">
                    <CheckIcon className="size-4 shrink-0 text-success" aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{progress.note}</p>
            </div>
          ) : progress.step === "connecting" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner className="size-4" />
              {progress.message}
            </p>
          ) : (
            <div className="grid gap-5">
              {progress.step === "incomplete" ? (
                <Alert variant="warning">
                  <AlertTitle>{progress.title}</AlertTitle>
                  <AlertDescription>{progress.message}</AlertDescription>
                </Alert>
              ) : null}
              <section className="grid gap-2" aria-labelledby="local-model-servers">
                <div className="flex items-center justify-between gap-2">
                  <h3 id="local-model-servers" className="text-sm font-medium">
                    Model servers on {machineLabel}
                  </h3>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={search.status === "searching"}
                    onClick={() => void runSearch()}
                  >
                    <SearchIcon className="size-3" aria-hidden />
                    Search again
                  </Button>
                </div>
                {search.status === "searching" ? (
                  <p
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                    role="status"
                  >
                    <Spinner className="size-4" />
                    Looking for model servers on {machineLabel}…
                  </p>
                ) : search.status === "failed" ? (
                  <p className="text-sm text-destructive">{search.message}</p>
                ) : servers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No model server answered on {machineLabel}
                    {search.result.searchedListeningPorts ? "." : " at the usual ports."} Start one,
                    or enter its address below.
                  </p>
                ) : (
                  <RadioGroup
                    aria-labelledby="local-model-servers"
                    value={
                      selection === null
                        ? ""
                        : JSON.stringify([selection.baseUrl, selection.modelId])
                    }
                    onValueChange={(value) => {
                      const [baseUrl, modelId] = JSON.parse(String(value)) as [string, string];
                      setChosen({ baseUrl, modelId });
                    }}
                  >
                    {servers.map((server) => (
                      <DiscoveredServerOption
                        key={server.baseUrl}
                        server={server}
                        registeredName={
                          server.registeredServerId === undefined
                            ? undefined
                            : (settings.inferenceServers[server.registeredServerId]?.displayName ??
                              server.registeredServerId)
                        }
                      />
                    ))}
                  </RadioGroup>
                )}
                <div className="grid gap-1.5 pt-1">
                  <Label htmlFor="local-model-address">Or enter its address</Label>
                  <div className="flex gap-2">
                    <Input
                      id="local-model-address"
                      placeholder="http://localhost:11434/v1"
                      value={address}
                      onChange={(event) => setAddress(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") checkAddress();
                      }}
                      aria-invalid={addressError !== null}
                    />
                    <Button
                      variant="outline"
                      disabled={address.trim() === "" || search.status === "searching"}
                      onClick={checkAddress}
                    >
                      Check
                    </Button>
                  </div>
                  {addressError === null ? null : (
                    <p role="alert" className="text-xs text-destructive">
                      {addressError}
                    </p>
                  )}
                </div>
              </section>
              {selectedServer !== undefined ? (
                <section className="grid gap-2" aria-labelledby="local-model-agent">
                  <h3 id="local-model-agent" className="text-sm font-medium">
                    Agent
                  </h3>
                  <RadioGroup
                    aria-labelledby="local-model-agent"
                    value={chosenDriver ?? ""}
                    onValueChange={(value) => setDriver(value as ProviderDriverKind)}
                  >
                    {choices.map((choice) => (
                      <label
                        key={choice.driver}
                        className="flex items-start gap-2.5 rounded-lg border p-2.5 text-sm has-data-disabled:opacity-64"
                      >
                        <Radio
                          value={choice.driver}
                          disabled={choice.unavailableReason !== undefined}
                        />
                        <span className="grid gap-0.5">
                          <span className="flex items-center gap-1.5 text-sm">
                            {choice.label}
                            {choice.recommended ? (
                              <Badge variant="success">Recommended</Badge>
                            ) : null}
                            {choice.experimental ? (
                              <Badge variant="outline">Experimental</Badge>
                            ) : null}
                          </span>
                          {choice.unavailableReason !== undefined ? (
                            <span className="text-xs text-muted-foreground">
                              {choice.unavailableReason}
                            </span>
                          ) : choice.unchecked ? (
                            <span className="text-xs text-muted-foreground">
                              Not set up on {machineLabel} yet; checked when you connect.
                            </span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                </section>
              ) : null}
              {plan !== null && selection !== null && chosenAgent !== undefined ? (
                <p className="text-xs text-muted-foreground">
                  On {machineLabel}:{" "}
                  {plan.serverConfig === null
                    ? `use the model server ${plan.serverName}`
                    : `add the model server ${plan.serverName}`}
                  ,{" "}
                  {plan.instanceMutation === null
                    ? `use ${chosenAgent.label}, already linked to it`
                    : `link ${chosenAgent.label} to it`}
                  , and make {selection.modelId} the default for new threads.
                </p>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          {progress.step === "done" ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={busy || plan === null || selectedServer?.status !== "ready"}
                onClick={() => void connect()}
              >
                {busy ? <Spinner className="size-3.5" /> : <CpuIcon className="size-3.5" />}
                {progress.step === "incomplete" && progress.canRetry
                  ? "Try again"
                  : "Use this model"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DiscoveredServerOption({
  server,
  registeredName,
}: {
  readonly server: InferenceDiscoveredServer;
  readonly registeredName: string | undefined;
}) {
  const heading = [server.engine, server.baseUrl].filter(Boolean).join(" · ");
  return (
    <div className="grid gap-1.5 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-mono">{heading}</span>
        {registeredName === undefined ? null : (
          <Badge variant="outline">Added as {registeredName}</Badge>
        )}
        {server.status === "needs-key" ? <Badge variant="warning">Needs an API key</Badge> : null}
      </div>
      {server.status === "needs-key" ? (
        <p className="text-xs text-muted-foreground">
          It answered, but lists its models only with a key. Add it in Settings, Model servers, with
          its key.
        </p>
      ) : (
        server.models.map((model) => (
          <label key={model.id} className="flex items-center gap-2.5 text-sm">
            <Radio value={JSON.stringify([server.baseUrl, model.id])} />
            <span className="text-sm">{model.id}</span>
            <span className="text-xs text-muted-foreground">
              {describeInferenceModelContext(model)}
            </span>
          </label>
        ))
      )}
    </div>
  );
}
