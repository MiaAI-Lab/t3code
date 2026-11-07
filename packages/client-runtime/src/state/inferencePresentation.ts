import type {
  InferenceRequestPurpose,
  InferenceServerConfig,
  InferenceServerId,
  InferenceServerModel,
  InferenceServerSnapshot,
  InferenceThreadLastRequest,
  InferenceUsageRow,
  InferenceUsageSummary,
  InferenceUsageWindow,
  UnifiedSettings,
} from "@t3tools/contracts";
import { formatPercent, formatTokens as formatUsageTokens } from "@t3tools/shared/usageFormat";

export type InferenceServers = UnifiedSettings["inferenceServers"];

// Settings → Inference: one line per fact about a registered server.

export function inferenceServerDisplayName(
  id: string,
  config: Pick<InferenceServerConfig, "displayName"> | undefined,
): string {
  return config?.displayName?.trim() || id;
}

/** Optimistic removals hold `null` until the server echoes the patch. */
export function presentInferenceServers(
  servers: InferenceServers | undefined,
): ReadonlyArray<readonly [InferenceServerId, InferenceServerConfig]> {
  return Object.entries(servers ?? {}).flatMap(([id, config]) =>
    config ? [[id as InferenceServerId, config] as const] : [],
  );
}

export type InferenceServerLink =
  | { readonly kind: "none" }
  | { readonly kind: "enabled"; readonly name: string }
  | { readonly kind: "disabled"; readonly name: string }
  | { readonly kind: "missing"; readonly id: string };

/** What an instance's `inferenceServerId` points at in its environment's settings. */
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

export interface InferenceServerOutage {
  readonly id: InferenceServerId;
  readonly name: string;
  readonly baseUrl: string;
  readonly message: string;
}

/**
 * The server a selected agent is linked to, while it is down. Its gateway models drop out of the
 * agent's list until it answers again; checking and turned-off servers are not an outage.
 */
export function inferenceServerOutage(input: {
  readonly serverId: string | undefined;
  readonly servers: InferenceServers;
  readonly snapshots: ReadonlyArray<InferenceServerSnapshot>;
}): InferenceServerOutage | null {
  if (input.serverId === undefined) return null;
  const config = input.servers[input.serverId as InferenceServerId];
  const snapshot = input.snapshots.find((candidate) => candidate.id === input.serverId);
  if (!config?.enabled || snapshot === undefined) return null;
  if (snapshot.status !== "unreachable" && snapshot.status !== "error") return null;
  return {
    id: input.serverId as InferenceServerId,
    name: inferenceServerDisplayName(input.serverId, config),
    baseUrl: config.baseUrl,
    message: snapshot.message ?? "It did not answer its last check.",
  };
}

export interface InferenceModelNotServed {
  readonly id: InferenceServerId;
  readonly name: string;
  readonly model: string;
  /** What the server serves now, to switch to. */
  readonly served: ReadonlyArray<string>;
}

/**
 * A model a linked agent was set to run that its server, checked and ready, no longer lists. A
 * server being checked or down says nothing about its models, so that is not reported here.
 * Gateway entries are `t3-<server>/<model>`; a linked Codex lists the model ids themselves.
 */
export function inferenceModelNotServed(input: {
  readonly serverId: string | undefined;
  readonly driver: string | undefined;
  readonly modelSlug: string;
  readonly servers: InferenceServers;
  readonly snapshots: ReadonlyArray<InferenceServerSnapshot>;
}): InferenceModelNotServed | null {
  if (input.serverId === undefined) return null;
  const config = input.servers[input.serverId as InferenceServerId];
  const snapshot = input.snapshots.find((candidate) => candidate.id === input.serverId);
  if (!config?.enabled || snapshot?.status !== "ready" || snapshot.models.length === 0) return null;
  const prefix = `t3-${input.serverId}/`;
  const model = input.modelSlug.startsWith(prefix)
    ? input.modelSlug.slice(prefix.length)
    : input.driver === "codex"
      ? input.modelSlug
      : null;
  if (model === null || snapshot.models.some((served) => served.id === model)) return null;
  return {
    id: input.serverId as InferenceServerId,
    name: inferenceServerDisplayName(input.serverId, config),
    model,
    served: snapshot.models.map((served) => served.id),
  };
}

/** URL, engine, T3's concurrency cap and fallback, in the order a server's summary line shows them. */
export function inferenceServerDetails(
  config: InferenceServerConfig,
  current: Pick<InferenceServerSnapshot, "engine"> | undefined,
  fallback: string | null,
): ReadonlyArray<string> {
  return [
    config.baseUrl,
    current?.engine,
    config.maxConcurrency === undefined ? undefined : `T3 sends up to ${config.maxConcurrency}`,
    fallback ?? undefined,
  ].filter((part): part is string => part !== undefined);
}

function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** "128k context", with the trained window only when the server serves a different one. */
export function describeInferenceModelContext(model: InferenceServerModel): string | null {
  const served = model.servedContextWindow;
  const trained = model.trainedContextWindow;
  if (served === undefined) {
    return trained === undefined ? null : `trained for ${formatContextTokens(trained)}`;
  }
  const base = `${formatContextTokens(served)} context`;
  return trained !== undefined && trained !== served
    ? `${base} (trained ${formatContextTokens(trained)})`
    : base;
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

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function relativeUnitMs(elapsedMs: number): number {
  return elapsedMs < HOUR_MS ? MINUTE_MS : elapsedMs < DAY_MS ? HOUR_MS : DAY_MS;
}

function relativeAgoLabel(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / MINUTE_MS);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
  if (Number.isNaN(checkedMs)) return null;
  const elapsedMs = Math.max(0, nowMs - checkedMs);
  const unitMs = relativeUnitMs(elapsedMs);
  // Timer delays above 2^31-1 fire immediately; cap at a day and let callers reschedule.
  const labelChangeMs = Math.min(
    checkedMs + (Math.floor(elapsedMs / unitMs) + 1) * unitMs - nowMs,
    DAY_MS,
  );
  // With periodic checks off, a check only happens on refresh or a settings change.
  const staleAtMs = probeIntervalMs > 0 ? checkedMs + 2 * probeIntervalMs : Infinity;
  const stale = nowMs >= staleAtMs;
  return {
    label: `Checked ${relativeAgoLabel(elapsedMs)}`,
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

// Measurements T3's gateway records per request.

/** Shown for a measurement the gateway did not record; an en dash, as product copy avoids em dashes. */
const MISSING_MEASUREMENT = "–";

export function formatMeasuredSeconds(ms: number | null): string {
  if (ms === null) return MISSING_MEASUREMENT;
  const seconds = ms / 1000;
  const digits = seconds < 0.1 ? 2 : seconds < 10 ? 1 : 0;
  return `${seconds.toFixed(digits)} s`;
}

export function formatTokensPerSecond(rate: number | null): string {
  if (rate === null) return MISSING_MEASUREMENT;
  return `${rate.toFixed(rate < 10 ? 1 : 0)} tok/s`;
}

/** The cached part of a prompt, or null when it cannot be known. */
export function cachedPromptShare(
  promptTokens: number | null,
  cachedPromptTokens: number | null,
): number | null {
  if (promptTokens === null || cachedPromptTokens === null || promptTokens <= 0) return null;
  return Math.min(1, cachedPromptTokens / promptTokens);
}

export function formatCachedShare(share: number | null): string {
  return share === null ? MISSING_MEASUREMENT : formatPercent(share, 0);
}

/** "Last request: 12.3K prompt tokens (80% cached) · TTFT 1.2 s · 35 tok/s · waited 0.4 s" */
export function formatLastInferenceRequest(last: InferenceThreadLastRequest): string {
  return `Last request: ${formatLastInferenceRequestMeasures(last)}`;
}

/** "12.3K prompt tokens (80% cached) · TTFT 1.2 s · 35 tok/s · waited 0.4 s" */
export function formatLastInferenceRequestMeasures(last: InferenceThreadLastRequest): string {
  const prompt =
    last.promptTokens === null ? MISSING_MEASUREMENT : formatUsageTokens(last.promptTokens);
  const cached = formatCachedShare(cachedPromptShare(last.promptTokens, last.cachedPromptTokens));
  return [
    `${prompt} prompt tokens (${cached} cached)`,
    `TTFT ${formatMeasuredSeconds(last.ttftMs)}`,
    formatTokensPerSecond(last.decodeTokensPerSecond),
    `waited ${formatMeasuredSeconds(last.queueWaitMs)}`,
  ].join(" · ");
}

/** "cached 80%" for the compact row, or null when the server did not report cache use. */
export function formatLastRequestCached(last: InferenceThreadLastRequest): string | null {
  const share = cachedPromptShare(last.promptTokens, last.cachedPromptTokens);
  return share === null ? null : `cached ${formatCachedShare(share)}`;
}

/** "12.3K prompt · cached 80% · TTFT 1.2 s", the compact row's value. */
export function formatLastRequestCompact(last: InferenceThreadLastRequest): string {
  const prompt =
    last.promptTokens === null ? MISSING_MEASUREMENT : formatUsageTokens(last.promptTokens);
  const cached = formatLastRequestCached(last);
  return [
    `${prompt} prompt`,
    ...(cached === null ? [] : [cached]),
    `TTFT ${formatMeasuredSeconds(last.ttftMs)}`,
  ].join(" · ");
}

/** "Served by spark1 (fallback from rtx)" */
export function formatLastRequestServer(
  last: InferenceThreadLastRequest,
  serverName: (id: InferenceServerId) => string,
): string {
  const served = `Served by ${serverName(last.serverId)}`;
  return last.fallbackFrom === undefined
    ? served
    : `${served} (fallback from ${serverName(last.fallbackFrom)})`;
}

/** What differs from the thread's previous request. These are observations; a cache miss can have other causes. */
export function lastRequestObservations(last: InferenceThreadLastRequest): ReadonlyArray<string> {
  return [
    ...(last.staticPrefixChanged === true
      ? ["Instructions or tools changed since the previous request"]
      : []),
    ...(last.serverChanged === true ? ["Different server than the previous request"] : []),
  ];
}

/** A server's display name from the environment's snapshots, or its id once it is removed. */
export function inferenceServerSnapshotName(
  servers: ReadonlyArray<InferenceServerSnapshot> | null | undefined,
  id: InferenceServerId,
): string {
  return servers?.find((server) => server.id === id)?.displayName ?? id;
}

// Usage → Local compute.

const PURPOSE_ORDER: Readonly<Record<InferenceRequestPurpose, number>> = {
  interactive: 0,
  scheduled: 1,
  background: 2,
};

export const INFERENCE_PURPOSE_LABELS: Readonly<Record<InferenceRequestPurpose, string>> = {
  interactive: "Chat",
  scheduled: "Scheduled",
  background: "Background",
};

export const LOCAL_COMPUTE_WINDOWS: ReadonlyArray<InferenceUsageWindow> = ["24h", "7d"];

export const LOCAL_COMPUTE_WINDOW_LABELS: Readonly<Record<InferenceUsageWindow, string>> = {
  "24h": "24 hours",
  "7d": "7 days",
};

export const LOCAL_COMPUTE_FOOTNOTE =
  "Measured by T3's gateway; tools calling your server directly are not counted.";

export interface LocalComputeTotals {
  readonly requests: number;
  readonly failed: number;
  readonly promptTokens: number;
  readonly cachedPromptTokens: number;
  /** Prompt tokens of requests whose server reported cache use; older servers omit it. */
  readonly promptTokensWithCacheData: number;
  readonly completionTokens: number;
}

export interface LocalComputeGroup {
  readonly key: string;
  readonly serverName: string;
  readonly model: string;
  readonly totals: LocalComputeTotals;
  /** One row per purpose; percentiles cannot be combined across them, so each keeps its own. */
  readonly rows: ReadonlyArray<InferenceUsageRow>;
}

export function sumLocalCompute(rows: ReadonlyArray<InferenceUsageRow>): LocalComputeTotals {
  return rows.reduce(
    (totals, row) => ({
      requests: totals.requests + row.requests,
      failed: totals.failed + row.failed,
      promptTokens: totals.promptTokens + row.promptTokens,
      cachedPromptTokens: totals.cachedPromptTokens + row.cachedPromptTokens,
      promptTokensWithCacheData:
        totals.promptTokensWithCacheData + (row.promptTokensWithCacheData ?? 0),
      completionTokens: totals.completionTokens + row.completionTokens,
    }),
    {
      requests: 0,
      failed: 0,
      promptTokens: 0,
      cachedPromptTokens: 0,
      promptTokensWithCacheData: 0,
      completionTokens: 0,
    },
  );
}

/** Cached over prompt tokens of requests that reported cache use; null when none did. */
export function localComputeCachedShare(
  totals: Pick<LocalComputeTotals, "cachedPromptTokens" | "promptTokensWithCacheData">,
): number | null {
  if (totals.promptTokensWithCacheData <= 0) return null;
  return Math.min(1, totals.cachedPromptTokens / totals.promptTokensWithCacheData);
}

/** Rows grouped by server and model, busiest first; a removed server keeps its id as its name. */
export function groupLocalCompute(
  rows: ReadonlyArray<InferenceUsageRow>,
  servers: ReadonlyArray<InferenceServerSnapshot> | null,
): ReadonlyArray<LocalComputeGroup> {
  const groups = new Map<string, InferenceUsageRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.serverId, row.model]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  // Hermes lacks toSorted, so mobile sorts copies.
  return [...groups.entries()]
    .map(([key, groupRows]) => {
      const first = groupRows[0]!;
      return {
        key,
        serverName: inferenceServerSnapshotName(servers, first.serverId),
        model: first.model,
        totals: sumLocalCompute(groupRows),
        rows: [...groupRows].sort((a, b) => PURPOSE_ORDER[a.purpose] - PURPOSE_ORDER[b.purpose]),
      };
    })
    .sort(
      (a, b) =>
        b.totals.requests - a.totals.requests ||
        a.serverName.localeCompare(b.serverName) ||
        a.model.localeCompare(b.model),
    );
}

/** A distribution cell's value, or the missing mark when nothing was measured. */
export function formatLocalComputeDistribution(
  distribution: { readonly n: number; readonly p50: number | null; readonly p95: number | null },
  kind: "seconds" | "rate",
): string {
  if (distribution.n === 0) return MISSING_MEASUREMENT;
  return kind === "rate"
    ? formatTokensPerSecond(distribution.p50)
    : `${formatMeasuredSeconds(distribution.p50)} / ${formatMeasuredSeconds(distribution.p95)}`;
}
