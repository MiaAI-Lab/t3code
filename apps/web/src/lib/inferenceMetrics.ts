import type { InferenceServerId, InferenceThreadLastRequest } from "@t3tools/contracts";
import { formatPercent, formatTokens } from "@t3tools/shared/usageFormat";

/** Shown for a measurement the gateway did not record; an en dash, as product copy avoids em dashes. */
export const MISSING_MEASUREMENT = "–";

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
  const prompt = last.promptTokens === null ? MISSING_MEASUREMENT : formatTokens(last.promptTokens);
  const cached = formatCachedShare(cachedPromptShare(last.promptTokens, last.cachedPromptTokens));
  return [
    `Last request: ${prompt} prompt tokens (${cached} cached)`,
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
