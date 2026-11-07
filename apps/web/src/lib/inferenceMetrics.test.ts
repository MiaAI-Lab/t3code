import { InferenceServerId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cachedPromptShare,
  formatLastInferenceRequest,
  formatMeasuredSeconds,
  formatTokensPerSecond,
} from "./inferenceMetrics";

describe("inference metrics", () => {
  it("shows a dash for anything the gateway did not measure", () => {
    expect(
      formatLastInferenceRequest({
        serverId: InferenceServerId.make("rtx"),
        model: "glm",
        completedAt: "2026-11-07T00:00:00.000Z",
        promptTokens: null,
        cachedPromptTokens: null,
        completionTokens: null,
        queueWaitMs: null,
        ttftMs: null,
        decodeTokensPerSecond: null,
      }),
    ).toBe("Last request: – prompt tokens (– cached) · TTFT – · – · waited –");
  });

  it("formats measured values", () => {
    expect(
      formatLastInferenceRequest({
        serverId: InferenceServerId.make("rtx"),
        model: "glm",
        completedAt: "2026-11-07T00:00:00.000Z",
        promptTokens: 12_345,
        cachedPromptTokens: 9_876,
        completionTokens: 200,
        queueWaitMs: 420,
        ttftMs: 1_234,
        decodeTokensPerSecond: 35.4,
      }),
    ).toBe("Last request: 12.3K prompt tokens (80% cached) · TTFT 1.2 s · 35 tok/s · waited 0.4 s");
    expect(formatMeasuredSeconds(46)).toBe("0.05 s");
    expect(formatMeasuredSeconds(12_600)).toBe("13 s");
    expect(formatTokensPerSecond(7.26)).toBe("7.3 tok/s");
  });

  it("has no cached share for an empty or unknown prompt", () => {
    expect(cachedPromptShare(0, 0)).toBeNull();
    expect(cachedPromptShare(100, null)).toBeNull();
    expect(cachedPromptShare(100, 120)).toBe(1);
  });
});
