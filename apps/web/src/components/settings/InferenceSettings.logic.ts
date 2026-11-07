import {
  InferenceServerId,
  type InferenceServerConfig,
  type InferenceServerModel,
  type InferenceServerSnapshot,
  type InferenceUsageRow,
  type InferenceUsageSummary,
  type SecretReference,
  type UnifiedSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { formatRelativeTimeLabel, msUntilRelativeTimeChange } from "../../timestampFormat";

const decodeInferenceServerId = Schema.decodeOption(InferenceServerId);

export type InferenceServers = UnifiedSettings["inferenceServers"];

/**
 * An OpenAI-compatible root the server can probe. A bare host gets `/v1`, the root every supported
 * engine serves. Credentials and query strings are refused: they would be stored and shown in plain
 * text, while the API key field is kept as a secret.
 */
export function normalizeInferenceServerBaseUrl(raw: string): Result.Result<string, string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return Result.fail("Enter the server URL.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return Result.fail("Enter a full URL, such as http://localhost:11434/v1.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Result.fail("Use an http:// or https:// URL.");
  }
  if (url.username !== "" || url.password !== "") {
    return Result.fail("Remove the credentials from the URL and put the key in API key.");
  }
  if (url.search !== "" || trimmed.includes("?")) {
    return Result.fail("Remove the query string; put any key in API key.");
  }
  if (url.hash !== "" || trimmed.includes("#")) {
    return Result.fail("Remove the #fragment from the URL.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return Result.succeed(`${url.origin}${path === "" ? "/v1" : path}`);
}

/** Stable and readable in settings.json, so re-adding a server under the same name keeps its links. */
export function inferenceServerIdFromName(name: string): InferenceServerId | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return null;
  const id = (/^[a-z]/.test(slug) ? slug : `server-${slug}`).slice(0, 64).replace(/-+$/, "");
  return Option.getOrNull(decodeInferenceServerId(id));
}

export interface InferenceServerDraft {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string | SecretReference;
  readonly maxConcurrency: string;
  /** Another registered server's id, or "" for none. */
  readonly fallbackServerId: string;
}

export const EMPTY_INFERENCE_SERVER_DRAFT: InferenceServerDraft = {
  name: "",
  baseUrl: "",
  apiKey: "",
  maxConcurrency: "",
  fallbackServerId: "",
};

export function draftFromInferenceServer(config: InferenceServerConfig): InferenceServerDraft {
  return {
    name: config.displayName ?? "",
    baseUrl: config.baseUrl,
    // A saved key arrives redacted; sending it back unchanged keeps it.
    apiKey: config.apiKey,
    maxConcurrency: config.maxConcurrency === undefined ? "" : String(config.maxConcurrency),
    fallbackServerId: config.fallbackServerId ?? "",
  };
}

export type InferenceServerTarget =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly id: InferenceServerId; readonly enabled: boolean };

export type InferenceServerDraftIssues = {
  readonly [Field in keyof InferenceServerDraft]?: string;
};

/** The settings entry a draft adds or replaces, or every field that blocks it, one message each. */
export function inferenceServerFromDraft(
  draft: InferenceServerDraft,
  existingIds: ReadonlySet<string>,
  target: InferenceServerTarget,
): Result.Result<
  { readonly id: InferenceServerId; readonly config: InferenceServerConfig },
  InferenceServerDraftIssues
> {
  const issues: { -readonly [Field in keyof InferenceServerDraft]?: string } = {};
  const baseUrl = normalizeInferenceServerBaseUrl(draft.baseUrl);
  if (Result.isFailure(baseUrl)) issues.baseUrl = baseUrl.failure;

  const name = draft.name.trim();
  let id: InferenceServerId | null = null;
  if (target.mode === "edit") {
    id = target.id;
  } else {
    let host = "";
    if (Result.isSuccess(baseUrl)) host = new URL(baseUrl.success).hostname;
    id = inferenceServerIdFromName(name || host);
    if (id === null && name !== "") issues.name = "The name needs at least one letter or digit.";
    else if (id !== null && existingIds.has(id)) issues.name = "A server with this name exists.";
  }

  const concurrencyText = draft.maxConcurrency.trim();
  const maxConcurrency = concurrencyText === "" ? undefined : Number(concurrencyText);
  if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)) {
    issues.maxConcurrency = "Enter a whole number of 1 or more, or leave it empty.";
  }

  const fallbackServerId =
    draft.fallbackServerId === "" ? undefined : (draft.fallbackServerId as InferenceServerId);
  if (
    fallbackServerId !== undefined &&
    (fallbackServerId === id || !existingIds.has(fallbackServerId))
  ) {
    issues.fallbackServerId = "Choose another registered server, or none.";
  }

  const apiKey = typeof draft.apiKey === "string" ? draft.apiKey.trim() : draft.apiKey;
  if (id === null || Result.isFailure(baseUrl) || Object.keys(issues).length > 0) {
    return Result.fail(issues);
  }
  return Result.succeed({
    id,
    config: {
      ...(name === "" ? {} : { displayName: name }),
      baseUrl: baseUrl.success,
      apiKey,
      enabled: target.mode === "edit" ? target.enabled : true,
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
      ...(fallbackServerId === undefined ? {} : { fallbackServerId }),
    },
  });
}

export function inferenceServerDisplayName(
  id: string,
  config: Pick<InferenceServerConfig, "displayName"> | undefined,
): string {
  return config?.displayName?.trim() || id;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** "128k context", with the trained window only when the server serves a different one. */
export function describeInferenceModelContext(model: InferenceServerModel): string | null {
  const served = model.servedContextWindow;
  const trained = model.trainedContextWindow;
  if (served === undefined) {
    return trained === undefined ? null : `trained for ${formatTokens(trained)}`;
  }
  const base = `${formatTokens(served)} context`;
  return trained !== undefined && trained !== served
    ? `${base} (trained ${formatTokens(trained)})`
    : base;
}

/** The summary-line note for a server's fallback, or null when it has none. */
export function describeInferenceServerFallback(
  config: Pick<InferenceServerConfig, "fallbackServerId">,
  servers: InferenceServers,
): string | null {
  const link = resolveInferenceServerLink(config.fallbackServerId, servers);
  switch (link.kind) {
    case "none":
      return null;
    case "enabled":
      return `falls back to ${link.name}`;
    case "disabled":
      return `falls back to ${link.name} (disabled)`;
    case "missing":
      return `falls back to ${link.id} (not registered)`;
  }
}

/** Removes a server and, in the same patch, clears it as the fallback of the others. */
export function inferenceServerRemovalPatch(
  servers: InferenceServers | undefined,
  id: InferenceServerId,
): Record<InferenceServerId, InferenceServerConfig | null> {
  const patch: Record<InferenceServerId, InferenceServerConfig | null> = { [id]: null };
  for (const [otherId, config] of presentInferenceServers(servers)) {
    if (otherId === id || config.fallbackServerId !== id) continue;
    const { fallbackServerId: _removed, ...rest } = config;
    patch[otherId] = rest;
  }
  return patch;
}

export function describeInferenceServerLoad(
  snapshot: Pick<InferenceServerSnapshot, "load" | "maxConcurrentRequests">,
): string | null {
  const parts: string[] = [];
  if (snapshot.load) {
    parts.push(`${snapshot.load.running} running`, `${snapshot.load.waiting} waiting`);
  }
  if (snapshot.maxConcurrentRequests !== undefined) {
    parts.push(`up to ${snapshot.maxConcurrentRequests} at once`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

const GIB = 1024 ** 3;
const formatGib = (bytes: number) => (bytes / GIB).toFixed(1);

export interface InferencePromptCacheHealth {
  readonly summary: string;
  /** Set only when the cache is full and its cached share is falling. */
  readonly warning: string | null;
  readonly advice: string | null;
}

export function describeInferencePromptCache(
  snapshot: Pick<InferenceServerSnapshot, "engine" | "promptCache">,
): InferencePromptCacheHealth | null {
  const cache = snapshot.promptCache;
  if (cache === undefined) return null;
  const tensorFold = snapshot.engine === "TensorFold";
  if (cache.status === "none") {
    return {
      summary: "No prompt cache: every request reads its whole prompt",
      warning: null,
      advice: tensorFold
        ? "Start TensorFold with --prompt-cache-gib to keep threads warm, if memory allows."
        : "Turn on the server's prompt cache to keep threads warm, if memory allows.",
    };
  }
  const size =
    cache.retainedBytes === undefined
      ? formatGib(cache.budgetBytes)
      : `${formatGib(cache.retainedBytes)} / ${formatGib(cache.budgetBytes)}`;
  const parts = [`Prompt cache ${size} GiB`];
  if (cache.states !== undefined) {
    parts.push(`${cache.states} saved ${cache.states === 1 ? "prompt" : "prompts"}`);
  }
  if (cache.recentCachedShare !== undefined) {
    parts.push(`${Math.round(cache.recentCachedShare * 100)}% of prompt tokens cached recently`);
  }
  const falling = cache.status === "saturated-falling";
  return {
    summary: parts.join(" · "),
    warning: falling
      ? "The prompt cache is full and less of each prompt is cached than before, so threads are being pushed out."
      : null,
    advice: !falling
      ? null
      : tensorFold
        ? "Restart TensorFold with a larger --prompt-cache-gib, if memory allows."
        : "Give the server a larger prompt cache, if memory allows.",
  };
}

export type InferenceServerLink =
  | { readonly kind: "none" }
  | { readonly kind: "enabled"; readonly name: string }
  | { readonly kind: "disabled"; readonly name: string }
  | { readonly kind: "missing"; readonly id: string };

/** What an instance's `inferenceServerId` points at in its environment's settings. */
/** Optimistic removals hold `null` until the server echoes the patch. */
export function presentInferenceServers(
  servers: InferenceServers | undefined,
): ReadonlyArray<readonly [InferenceServerId, InferenceServerConfig]> {
  return Object.entries(servers ?? {}).flatMap(([id, config]) =>
    config ? [[id as InferenceServerId, config] as const] : [],
  );
}

export function resolveInferenceServerLink(
  inferenceServerId: string | undefined,
  servers: InferenceServers,
): InferenceServerLink {
  if (inferenceServerId === undefined) return { kind: "none" };
  const config = servers[inferenceServerId as InferenceServerId];
  if (!config) return { kind: "missing", id: inferenceServerId };
  const name = inferenceServerDisplayName(inferenceServerId, config);
  return config.enabled ? { kind: "enabled", name } : { kind: "disabled", name };
}

export interface InferenceServerProbeFreshness {
  readonly label: string;
  readonly stale: boolean;
  /** When the label or staleness next changes, or null when neither will. */
  readonly msUntilChange: number | null;
}

/** "Checked 3m ago", stale once two probe intervals pass without a check. */
export function describeInferenceServerProbeFreshness(
  checkedAt: string,
  probeIntervalMs: number,
  nowMs: number,
): InferenceServerProbeFreshness | null {
  const checkedMs = Date.parse(checkedAt);
  const labelChangeMs = msUntilRelativeTimeChange(checkedAt, nowMs);
  if (Number.isNaN(checkedMs) || labelChangeMs === null) return null;
  // With periodic checks off, a check only happens on refresh or a settings change.
  const staleAtMs = probeIntervalMs > 0 ? checkedMs + 2 * probeIntervalMs : Infinity;
  const stale = nowMs >= staleAtMs;
  return {
    label: `Checked ${formatRelativeTimeLabel(checkedAt, nowMs)}`,
    stale,
    msUntilChange: stale ? labelChangeMs : Math.min(labelChangeMs, staleAtMs - nowMs),
  };
}

const RECENT_FAILURE_MS = 60 * 60 * 1_000;

export interface InferenceServerRequestHealth {
  /** Whether any request in the window got a cached prompt count back; false means unknown. */
  readonly reportsCachedTokens: boolean;
  /** The latest failed or rejected request within the hour before the summary. */
  readonly recentFailure: NonNullable<InferenceUsageRow["lastFailure"]> | null;
}

export function inferenceServerRequestHealth(
  summary: InferenceUsageSummary,
  serverId: InferenceServerId,
): InferenceServerRequestHealth {
  const rows = summary.rows.filter((row) => row.serverId === serverId);
  const cutoffMs = Date.parse(summary.generatedAt) - RECENT_FAILURE_MS;
  const recentFailure = rows
    .flatMap((row) => (row.lastFailure ? [row.lastFailure] : []))
    .filter((failure) => Date.parse(failure.at) >= cutoffMs)
    .reduce<InferenceServerRequestHealth["recentFailure"]>(
      (latest, failure) =>
        latest === null || Date.parse(failure.at) > Date.parse(latest.at) ? failure : latest,
      null,
    );
  return {
    reportsCachedTokens: rows.some((row) => (row.promptTokensWithCacheData ?? 0) > 0),
    recentFailure,
  };
}
