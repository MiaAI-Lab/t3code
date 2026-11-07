import type { EnvironmentId, InferenceServerConfig, InferenceServerId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  draftFromInferenceServer,
  EMPTY_INFERENCE_SERVER_DRAFT,
  inferenceServerFromDraft,
  type InferenceServerDraft,
} from "./InferenceSettings.logic";
import { inferenceServerDisplayName } from "@t3tools/client-runtime/state/inference-presentation";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

function FieldError({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}) {
  return message === undefined ? null : (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

/** Mounted per open, so each open starts from a fresh draft. The API key goes to server secret storage. */
export function InferenceServerDialog({
  onClose,
  environmentId,
  environmentLabel,
  existingIds,
  fallbackOptions,
  existing,
  initialDraft,
  note,
}: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly existingIds: ReadonlySet<string>;
  /** Every other registered server this one can fall back to. */
  readonly fallbackOptions: ReadonlyArray<{
    readonly id: InferenceServerId;
    readonly name: string;
  }>;
  readonly existing?: { readonly id: InferenceServerId; readonly config: InferenceServerConfig };
  /** Prefills an add, such as a server copied from another machine. */
  readonly initialDraft?: InferenceServerDraft;
  readonly note?: string;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const secretSources = useSecretSources(environmentId);
  const [draft, setDraft] = useState<InferenceServerDraft>(
    existing
      ? draftFromInferenceServer(existing.config)
      : (initialDraft ?? EMPTY_INFERENCE_SERVER_DRAFT),
  );
  const [keyValid, setKeyValid] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const result = inferenceServerFromDraft(
    draft,
    existingIds,
    existing
      ? { mode: "edit", id: existing.id, enabled: existing.config.enabled }
      : { mode: "add" },
  );
  const issues = Result.isFailure(result) ? result.failure : {};
  const shown = submitted ? issues : {};

  const update = (patch: Partial<InferenceServerDraft>) => setDraft({ ...draft, ...patch });
  const save = () => {
    setSubmitted(true);
    if (Result.isFailure(result) || !keyValid) return;
    updateSettings({ inferenceServers: { [result.success.id]: result.success.config } });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing
              ? `Edit ${inferenceServerDisplayName(existing.id, existing.config)}`
              : "Add an inference server"}
          </DialogTitle>
          <DialogDescription>
            An OpenAI-compatible model server that {environmentLabel} can reach. localhost means{" "}
            {environmentLabel} itself.
            {note === undefined ? null : ` ${note}`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="inference-server-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="inference-server-url">Base URL</Label>
              <Input
                id="inference-server-url"
                placeholder="http://localhost:11434/v1"
                value={draft.baseUrl}
                onChange={(event) => update({ baseUrl: event.target.value })}
                spellCheck={false}
                aria-invalid={shown.baseUrl !== undefined}
                aria-describedby={
                  shown.baseUrl !== undefined ? "inference-server-url-error" : undefined
                }
                autoFocus
              />
              <FieldError id="inference-server-url-error" message={shown.baseUrl} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inference-server-name">Name (optional)</Label>
              <Input
                id="inference-server-name"
                placeholder="Defaults to the host name"
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                maxLength={64}
                aria-invalid={shown.name !== undefined}
                aria-describedby={
                  shown.name !== undefined ? "inference-server-name-error" : undefined
                }
              />
              <FieldError id="inference-server-name-error" message={shown.name} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inference-server-key">API key (optional)</Label>
              <SecretSourceInput
                id="inference-server-key"
                aria-label="API key"
                value={draft.apiKey}
                sources={secretSources}
                onChange={(event) => update({ apiKey: event.target.value })}
                onSecretChange={(secret) => update({ apiKey: secret ?? "" })}
                onValidityChange={setKeyValid}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inference-server-concurrency">
                Max concurrent requests (optional)
              </Label>
              <Input
                id="inference-server-concurrency"
                inputMode="numeric"
                placeholder="Server default"
                value={draft.maxConcurrency}
                onChange={(event) => update({ maxConcurrency: event.target.value })}
                aria-invalid={shown.maxConcurrency !== undefined}
                aria-describedby={
                  shown.maxConcurrency !== undefined
                    ? "inference-server-concurrency-error"
                    : undefined
                }
              />
              <FieldError id="inference-server-concurrency-error" message={shown.maxConcurrency} />
            </div>
            {fallbackOptions.length > 0 || draft.fallbackServerId !== "" ? (
              <div className="grid gap-1.5">
                <Label id="inference-server-fallback-label">Fallback server (optional)</Label>
                <Select
                  value={draft.fallbackServerId}
                  onValueChange={(value) => update({ fallbackServerId: value ?? "" })}
                >
                  <SelectTrigger
                    aria-labelledby="inference-server-fallback-label"
                    aria-invalid={shown.fallbackServerId !== undefined}
                    aria-describedby={
                      shown.fallbackServerId !== undefined
                        ? "inference-server-fallback-error"
                        : "inference-server-fallback-hint"
                    }
                  >
                    <SelectValue>
                      {draft.fallbackServerId === ""
                        ? "None"
                        : (fallbackOptions.find((option) => option.id === draft.fallbackServerId)
                            ?.name ?? draft.fallbackServerId)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="">None</SelectItem>
                    {fallbackOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p id="inference-server-fallback-hint" className="text-xs text-muted-foreground">
                  Takes requests while this server is down or unreachable, when it serves the same
                  model.
                </p>
                <FieldError id="inference-server-fallback-error" message={shown.fallbackServerId} />
              </div>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="inference-server-form"
            disabled={!keyValid || (submitted && Result.isFailure(result))}
          >
            {existing ? "Save changes" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
