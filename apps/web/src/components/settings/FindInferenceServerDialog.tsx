import type {
  EnvironmentId,
  InferenceDiscoveredServer,
  InferenceServerConfig,
  InferenceServerId,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useContext, useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { repairCandidates } from "./localModelSetup.logic";

type Search =
  | { readonly status: "searching" }
  | { readonly status: "done"; readonly servers: ReadonlyArray<InferenceDiscoveredServer> }
  | { readonly status: "failed"; readonly message: string };

function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Looks on a registered server's host for where it went, and moves the server there. The id stays,
 * so linked agents and their `t3-<server>/<model>` models keep working; the saved key goes along.
 */
export function FindInferenceServerDialog({
  environmentId,
  id,
  name,
  config,
  knownModelIds,
  onChangeAddress,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: InferenceServerId;
  readonly name: string;
  readonly config: InferenceServerConfig;
  /** Models it served before, to point out a candidate that serves them too. */
  readonly knownModelIds: ReadonlySet<string>;
  readonly onChangeAddress: () => void;
  readonly onClose: () => void;
}) {
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const refresh = useAtomCommand(serverEnvironment.refreshInferenceServers, {
    reportFailure: false,
  });
  const [search, setSearch] = useState<Search>({ status: "searching" });
  const [moving, setMoving] = useState<string | null>(null);
  const host = hostOf(config.baseUrl);

  const registry = useContext(RegistryContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- searches the server's host once when the dialog opens
  useEffect(() => {
    let active = true;
    void runAtomCommand(
      registry,
      serverEnvironment.discoverInferenceServers,
      { environmentId, input: host === undefined ? {} : { host } },
      { label: "find inference server", reportFailure: false, reportDefect: true },
    ).then((result) => {
      if (!active) return;
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setSearch({
          status: "failed",
          message: error instanceof Error ? error.message : "The search failed.",
        });
        return;
      }
      setSearch({ status: "done", servers: result.value.servers });
    });
    return () => {
      active = false;
    };
  }, [environmentId, registry, host]);

  const candidates =
    search.status === "done"
      ? repairCandidates(search.servers, id, config.baseUrl, knownModelIds)
      : [];

  const move = async (baseUrl: string) => {
    setMoving(baseUrl);
    const saved = await saveSettings({
      environmentId,
      input: { patch: { inferenceServers: { [id]: { ...config, baseUrl } } } },
    });
    if (saved._tag === "Failure") {
      setMoving(null);
      const error = squashAtomCommandFailure(saved);
      toastManager.add({
        type: "error",
        title: `${name} was not moved`,
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
      return;
    }
    const checked = await refresh({ environmentId, input: { id } });
    const snapshot =
      checked._tag === "Success"
        ? checked.value.inferenceServers.find((server) => server.id === id)
        : undefined;
    toastManager.add({
      type: snapshot?.status === "ready" ? "success" : "warning",
      title:
        snapshot?.status === "ready"
          ? `${name} now uses ${baseUrl}`
          : `${name} moved to ${baseUrl}, but is not ready`,
      description:
        snapshot?.status === "ready"
          ? "Threads already running keep the old address until their agent session restarts."
          : (snapshot?.message ?? "Check its address under Models & agents, Model servers."),
    });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && moving === null) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Find {name}</DialogTitle>
          <DialogDescription>
            {name} does not answer at {config.baseUrl}. Looking for model servers on{" "}
            {host ?? "its host"} that it may have moved to.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {search.status === "searching" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner className="size-4" />
              Searching {host ?? "its host"}…
            </p>
          ) : search.status === "failed" ? (
            <p className="text-sm text-destructive">{search.message}</p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing else answered on {host ?? "its host"}. If you know where it moved, change its
              address.
            </p>
          ) : (
            <ul className="grid gap-2">
              {candidates.map(({ server, sameModel }) => (
                <li
                  key={server.baseUrl}
                  className="flex items-center justify-between gap-3 rounded-lg border p-2.5"
                >
                  <div className="grid min-w-0 gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
                      {server.baseUrl}
                      {sameModel ? <Badge variant="success">Same model</Badge> : null}
                      {server.status === "needs-key" ? (
                        <Badge variant="outline">Uses {name}'s key</Badge>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {[server.engine, ...server.models.map((model) => model.id)]
                        .filter(Boolean)
                        .join(" · ") || "Lists its models only with a key"}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant={sameModel ? "default" : "outline"}
                    disabled={moving !== null}
                    onClick={() => void move(server.baseUrl)}
                  >
                    {moving === server.baseUrl ? <Spinner className="size-3.5" /> : null}
                    Use this address
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={moving !== null} onClick={onChangeAddress}>
            Change address
          </Button>
          <Button variant="ghost" disabled={moving !== null} onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
