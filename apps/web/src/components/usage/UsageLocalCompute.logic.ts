import type {
  InferenceRequestPurpose,
  InferenceServerSnapshot,
  InferenceUsageRow,
  InferenceUsageWindow,
} from "@t3tools/contracts";

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

export const LOCAL_COMPUTE_WINDOW_LABELS: Readonly<Record<InferenceUsageWindow, string>> = {
  "24h": "24 hours",
  "7d": "7 days",
};

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
  return [...groups.entries()]
    .map(([key, groupRows]) => {
      const first = groupRows[0]!;
      return {
        key,
        serverName:
          servers?.find((server) => server.id === first.serverId)?.displayName ?? first.serverId,
        model: first.model,
        totals: sumLocalCompute(groupRows),
        rows: groupRows.toSorted((a, b) => PURPOSE_ORDER[a.purpose] - PURPOSE_ORDER[b.purpose]),
      };
    })
    .toSorted(
      (a, b) =>
        b.totals.requests - a.totals.requests ||
        a.serverName.localeCompare(b.serverName) ||
        a.model.localeCompare(b.model),
    );
}
