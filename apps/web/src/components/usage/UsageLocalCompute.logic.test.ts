import {
  InferenceServerId,
  type InferenceServerSnapshot,
  type InferenceUsageRow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupLocalCompute,
  localComputeCachedShare,
  sumLocalCompute,
} from "./UsageLocalCompute.logic";

const none = { n: 0, p50: null, p95: null };

function row(
  serverId: string,
  model: string,
  purpose: InferenceUsageRow["purpose"],
  requests: number,
  promptTokensWithCacheData?: number,
): InferenceUsageRow {
  return {
    serverId: InferenceServerId.make(serverId),
    model,
    purpose,
    requests,
    failed: 1,
    promptTokens: requests * 100,
    cachedPromptTokens: requests * 50,
    ...(promptTokensWithCacheData === undefined ? {} : { promptTokensWithCacheData }),
    completionTokens: requests * 10,
    queueWaitMs: none,
    ttftMs: none,
    decodeTokensPerSecond: none,
  };
}

const rtx = {
  id: InferenceServerId.make("rtx"),
  displayName: "RTX box",
} as InferenceServerSnapshot;

describe("groupLocalCompute", () => {
  it("groups purposes under their server and model, busiest first, keeping removed servers", () => {
    const groups = groupLocalCompute(
      [
        row("rtx", "glm", "background", 2, 200),
        row("gone", "qwen", "interactive", 9),
        row("rtx", "glm", "interactive", 4, 250),
        row("rtx", "glm", "scheduled", 1),
      ],
      [rtx],
    );
    expect(groups.map((group) => [group.serverName, group.model])).toEqual([
      ["gone", "qwen"],
      ["RTX box", "glm"],
    ]);
    expect(groups[1]!.rows.map((entry) => entry.purpose)).toEqual([
      "interactive",
      "scheduled",
      "background",
    ]);
    expect(groups[1]!.totals).toEqual({
      requests: 7,
      failed: 3,
      promptTokens: 700,
      cachedPromptTokens: 350,
      promptTokensWithCacheData: 450,
      completionTokens: 70,
    });
  });

  it("sums nothing to zero", () => {
    expect(groupLocalCompute([], null)).toEqual([]);
    expect(sumLocalCompute([]).requests).toBe(0);
  });

  it("shares cached tokens only over requests that reported cache use", () => {
    expect(localComputeCachedShare(sumLocalCompute([row("rtx", "glm", "interactive", 2)]))).toBe(
      null,
    );
    expect(
      localComputeCachedShare({ cachedPromptTokens: 150, promptTokensWithCacheData: 300 }),
    ).toBe(0.5);
    expect(localComputeCachedShare({ cachedPromptTokens: 0, promptTokensWithCacheData: 0 })).toBe(
      null,
    );
  });
});
