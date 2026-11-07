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
import {
  draftFromInferenceServer,
  EMPTY_INFERENCE_SERVER_DRAFT,
  inferenceServerDisplayName,
  inferenceServerFromDraft,
  type InferenceServerDraft,
} from "./InferenceSettings.logic";
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
  existing,
}: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly existingIds: ReadonlySet<string>;
  readonly existing?: { readonly id: InferenceServerId; readonly config: InferenceServerConfig };
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const secretSources = useSecretSources(environmentId);
  const [draft, setDraft] = useState<InferenceServerDraft>(
    existing ? draftFromInferenceServer(existing.config) : EMPTY_INFERENCE_SERVER_DRAFT,
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
