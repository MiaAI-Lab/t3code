import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type InferenceServerSnapshot,
  isLocalProviderInstance,
  type InferenceServerStatus,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveProviderInstanceDisplayName(
  snapshot: Pick<ServerProvider, "instanceId" | "driver" | "displayName">,
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim();
  const kindLabel = PROVIDER_DISPLAY_NAMES[snapshot.driver] ?? humanizeSlug(snapshot.driver);
  if (trimmedSnapshotName && trimmedSnapshotName !== kindLabel) return trimmedSnapshotName;
  if (snapshot.instanceId !== defaultInstanceIdForDriver(snapshot.driver)) {
    const humanized = humanizeSlug(snapshot.instanceId);
    if (humanized.length > 0) return humanized;
  }
  return trimmedSnapshotName || kindLabel;
}

export function providerInstanceInitials(label: string): string {
  // Punctuation separates words so "Codex (hub)" reads CH, not C(. An apostrophe
  // inside a word stays ("Theo's Codex" is TC); a quoting one does not
  // ("Codex 'hub'" is CH).
  const words = label
    .replace(/[^\P{P}'’]+/gu, " ")
    .split(/\s+/u)
    .map((word) => word.replace(/^['’]+|['’]+$/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

export function providerAccentForegroundColor(accentColor: string) {
  const linearChannel = (offset: number) => {
    const value = Number.parseInt(accentColor.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
}

export function shouldShowInstanceBadge(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly accentColor?: string | undefined;
    readonly acpRegistryAgentId?: string | undefined;
    readonly enabled: boolean;
  },
  entries: Iterable<{
    readonly driverKind: ProviderDriverKind;
    readonly acpRegistryAgentId?: string | undefined;
    readonly enabled: boolean;
  }>,
): boolean {
  if (normalizeProviderAccentColor(entry.accentColor)) return true;
  let sharedProviderCount = 0;
  for (const candidate of entries) {
    if (candidate.driverKind !== entry.driverKind) continue;
    // Historical threads still need to distinguish accounts that are all disabled.
    if (entry.enabled && !candidate.enabled) continue;
    if (
      entry.driverKind === "acpRegistry" &&
      candidate.acpRegistryAgentId !== entry.acpRegistryAgentId
    ) {
      continue;
    }
    if (++sharedProviderCount > 1) return true;
  }
  return false;
}

export const INFERENCE_SERVER_STATUS_LABELS: Readonly<Record<InferenceServerStatus, string>> = {
  checking: "Checking",
  ready: "Ready",
  unreachable: "Unreachable",
  error: "Error",
};

/**
 * Where an instance's models run: "Pi · rtx · Ready" for one linked to a known inference server,
 * "Pi · Local" for one marked local by hand.
 */
export function providerInstanceInferenceLabel(
  displayName: string,
  snapshot: Pick<ServerProvider, "inference" | "inferenceServerId">,
  inferenceServers: ReadonlyArray<InferenceServerSnapshot> | null | undefined,
): string {
  const server =
    snapshot.inferenceServerId === undefined
      ? undefined
      : inferenceServers?.find((candidate) => candidate.id === snapshot.inferenceServerId);
  if (server) {
    const status = server.enabled ? INFERENCE_SERVER_STATUS_LABELS[server.status] : "Disabled";
    return `${displayName} · ${server.displayName} · ${status}`;
  }
  return snapshot.inference === "local" ? `${displayName} · Local` : displayName;
}

/** Models that run on the user's own servers, and those the user priced in Usage. */
export interface LocalUsageModels {
  readonly local: ReadonlySet<string>;
  readonly customPriced: ReadonlySet<string>;
}

// Harnesses log either "model" or "provider/model", so both forms match.
function usageModelKeys(model: string): ReadonlyArray<string> {
  const key = model.trim().toLowerCase();
  const slash = key.lastIndexOf("/");
  return slash < 0 ? [key] : [key, key.slice(slash + 1)];
}

/** Served by an enabled inference server, or offered by a provider instance that is local. */
export function collectLocalUsageModels(
  environments: ReadonlyArray<{
    readonly providers: ReadonlyArray<
      Pick<ServerProvider, "inference" | "inferenceServerId" | "models">
    > | null;
    readonly inferenceServers: ReadonlyArray<
      Pick<InferenceServerSnapshot, "id" | "enabled" | "models">
    > | null;
    readonly priceOverrides: Readonly<Record<string, unknown>> | undefined;
    readonly modelAliases: Readonly<Record<string, unknown>> | undefined;
  }>,
): LocalUsageModels {
  const local = new Set<string>();
  const customPriced = new Set<string>();
  for (const environment of environments) {
    const servers = environment.inferenceServers ?? [];
    const enabled = Object.fromEntries(servers.map((server) => [server.id, server]));
    for (const server of servers) {
      if (!server.enabled) continue;
      for (const model of server.models) usageModelKeys(model.id).forEach((key) => local.add(key));
    }
    for (const provider of environment.providers ?? []) {
      if (!isLocalProviderInstance(provider, enabled)) continue;
      for (const model of provider.models) {
        usageModelKeys(model.slug).forEach((key) => local.add(key));
      }
    }
    for (const model of [
      ...Object.keys(environment.priceOverrides ?? {}),
      ...Object.keys(environment.modelAliases ?? {}),
    ]) {
      customPriced.add(model.trim());
    }
  }
  return { local, customPriced };
}

/**
 * How Usage shows a model's cost: "local" for a local model with no price the user set, "estimate"
 * for one they priced (what the same tokens would cost from an API), null for any other model.
 */
export function localUsageModelCost(
  model: string,
  models: LocalUsageModels,
): "local" | "estimate" | null {
  if (!usageModelKeys(model).some((key) => models.local.has(key))) return null;
  return models.customPriced.has(model.trim()) ? "estimate" : "local";
}

/** Local models across the environments (ids as a JSON array), for the Usage page of each client. */
export function makeLocalUsageModelsAtom(server: {
  readonly providersValueAtom: (
    id: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<ServerProvider> | null>;
  readonly inferenceServersValueAtom: (
    id: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<InferenceServerSnapshot> | null>;
  readonly settingsValueAtom: (
    id: EnvironmentId,
  ) => Atom.Atom<
    Pick<ServerSettings, "usagePriceOverrides" | "usageModelAliases"> | null | undefined
  >;
}) {
  return Atom.family((idsJson: string) =>
    Atom.make((get) =>
      collectLocalUsageModels(
        (JSON.parse(idsJson) as EnvironmentId[]).map((id) => {
          const settings = get(server.settingsValueAtom(id));
          return {
            providers: get(server.providersValueAtom(id)),
            inferenceServers: get(server.inferenceServersValueAtom(id)),
            priceOverrides: settings?.usagePriceOverrides,
            modelAliases: settings?.usageModelAliases,
          };
        }),
      ),
    ).pipe(Atom.withLabel(`local-usage-models:${idsJson}`)),
  );
}

export const ESTIMATED_API_SPEND_LABEL = "Estimated equivalent API spend";
