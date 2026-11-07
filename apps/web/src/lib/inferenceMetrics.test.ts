import { InferenceServerId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cachedPromptShare,
  formatLastInferenceRequest,
  formatLastRequestCached,
  formatLastRequestServer,
  formatMeasuredSeconds,
  formatTokensPerSecond,
  lastRequestObservations,
} from "./inferenceMetrics";

const measured = {
  serverId: InferenceServerId.make("spark1"),
  model: "glm",
  completedAt: "2026-11-07T00:00:00.000Z",
  promptTokens: 1_000,
  cachedPromptTokens: 250,
  completionTokens: 10,
  queueWaitMs: null,
  ttftMs: null,
  decodeTokensPerSecond: null,
};

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

  it("names the fallback and lists only observed changes", () => {
    const name = (id: string) => (id === "rtx" ? "RTX box" : id);
    expect(formatLastRequestServer(measured, name)).toBe("Served by spark1");
    expect(
      formatLastRequestServer({ ...measured, fallbackFrom: InferenceServerId.make("rtx") }, name),
    ).toBe("Served by spark1 (fallback from RTX box)");
    expect(lastRequestObservations(measured)).toEqual([]);
    expect(
      lastRequestObservations({ ...measured, staticPrefixChanged: true, serverChanged: false }),
    ).toEqual(["Tool prefix changed since the previous request"]);
    expect(formatLastRequestCached(measured)).toBe("cached 25%");
    expect(formatLastRequestCached({ ...measured, cachedPromptTokens: null })).toBeNull();
  });
});
