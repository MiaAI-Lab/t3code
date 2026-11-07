import {
  InferenceServerId,
  type InferenceServerSnapshot,
  type InferenceUsageRow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cachedPromptShare,
  describeInferenceModelContext,
  describeInferencePromptCache,
  describeInferenceServerFallback,
  describeInferenceServerProbeFreshness,
  formatLastInferenceRequest,
  formatLastRequestCached,
  formatLastRequestServer,
  formatMeasuredSeconds,
  formatTokensPerSecond,
  groupLocalCompute,
  inferenceServerOutage,
  inferenceServerRequestHealth,
  lastRequestObservations,
  localComputeCachedShare,
  presentInferenceServers,
  resolveInferenceServerLink,
  sumLocalCompute,
} from "./inferencePresentation.ts";

describe("describeInferenceModelContext", () => {
  it("shows the served window and the trained one only when it differs", () => {
    expect(describeInferenceModelContext({ id: "m", servedContextWindow: 131072 })).toBe(
      "131k context",
    );
    expect(
      describeInferenceModelContext({
        id: "m",
        servedContextWindow: 32768,
        trainedContextWindow: 1_048_576,
      }),
    ).toBe("33k context (trained 1M)");
    expect(describeInferenceModelContext({ id: "m", trainedContextWindow: 8192 })).toBe(
      "trained for 8k",
    );
    expect(describeInferenceModelContext({ id: "m" })).toBeNull();
  });
});

describe("resolveInferenceServerLink", () => {
  const servers = {
    [InferenceServerId.make("rtx")]: {
      displayName: "RTX",
      baseUrl: "http://localhost:8888/v1",
      apiKey: "",
      enabled: true,
    },
    [InferenceServerId.make("old")]: {
      baseUrl: "http://old/v1",
      apiKey: "",
      enabled: false,
    },
  };

  it("classifies the link", () => {
    expect(resolveInferenceServerLink(undefined, servers)).toEqual({ kind: "none" });
    expect(resolveInferenceServerLink("rtx", servers)).toEqual({ kind: "enabled", name: "RTX" });
    expect(resolveInferenceServerLink("old", servers)).toEqual({ kind: "disabled", name: "old" });
    expect(resolveInferenceServerLink("gone", servers)).toEqual({ kind: "missing", id: "gone" });
  });

  it("describes the fallback", () => {
    expect(describeInferenceServerFallback({ fallbackServerId: undefined }, servers)).toBeNull();
    expect(
      describeInferenceServerFallback(
        { fallbackServerId: InferenceServerId.make("gone") },
        servers,
      ),
    ).toBe("falls back to gone (not registered)");
  });

  it("treats a removal the server has not confirmed as gone", () => {
    const removing = {
      ...servers,
      [InferenceServerId.make("old")]: null,
    } as unknown as typeof servers;
    expect(resolveInferenceServerLink("old", removing)).toEqual({ kind: "missing", id: "old" });
    expect(presentInferenceServers(removing).map(([id]) => id)).toEqual(["rtx"]);
  });
});

describe("describeInferenceServerProbeFreshness", () => {
  const checkedAt = "2026-11-07T12:00:00.000Z";
  const checkedMs = Date.parse(checkedAt);
  const MINUTE = 60_000;

  it("is fresh until two probe intervals pass, and wakes for that change", () => {
    expect(
      describeInferenceServerProbeFreshness(checkedAt, 5 * MINUTE, checkedMs + 10_000),
    ).toEqual({ label: "Checked just now", stale: false, msUntilChange: 50_000 });
    expect(
      describeInferenceServerProbeFreshness(checkedAt, 45 * MINUTE, checkedMs + 80 * MINUTE),
    ).toEqual({ label: "Checked 1h ago", stale: false, msUntilChange: 10 * MINUTE });
    expect(
      describeInferenceServerProbeFreshness(checkedAt, 5 * MINUTE, checkedMs + 10 * MINUTE),
    ).toMatchObject({ label: "Checked 10m ago", stale: true, msUntilChange: MINUTE });
  });

  it("never goes stale with periodic checks off", () => {
    expect(
      describeInferenceServerProbeFreshness(checkedAt, 0, checkedMs + 3 * 60 * MINUTE),
    ).toMatchObject({ stale: false });
  });
});

describe("inferenceServerRequestHealth", () => {
  const rtx = InferenceServerId.make("rtx");
  const spark = InferenceServerId.make("spark1");
  const distribution = { n: 0, p50: null, p95: null };
  const usageRow = (overrides: Partial<InferenceUsageRow>): InferenceUsageRow => ({
    serverId: rtx,
    model: "m",
    purpose: "interactive",
    requests: 1,
    failed: 0,
    promptTokens: 10,
    cachedPromptTokens: 0,
    completionTokens: 1,
    queueWaitMs: distribution,
    ttftMs: distribution,
    decodeTokensPerSecond: distribution,
    ...overrides,
  });
  const summary = (rows: ReadonlyArray<InferenceUsageRow>) => ({
    window: "24h" as const,
    generatedAt: "2026-11-07T12:00:00.000Z",
    rows,
  });

  it("says a server reports cached tokens only when one of its requests did", () => {
    const rows = [
      usageRow({ promptTokensWithCacheData: 10 }),
      usageRow({ serverId: spark, promptTokensWithCacheData: 0 }),
    ];
    expect(inferenceServerRequestHealth(summary(rows), rtx).reportsCachedTokens).toBe(true);
    expect(inferenceServerRequestHealth(summary(rows), spark).reportsCachedTokens).toBe(false);
    expect(inferenceServerRequestHealth(summary([usageRow({})]), rtx).reportsCachedTokens).toBe(
      false,
    );
  });

  it("keeps the server's latest failure from the last hour", () => {
    const rows = [
      usageRow({ lastFailure: { status: "failed", at: "2026-11-07T11:20:00.000Z" } }),
      usageRow({
        purpose: "background",
        lastFailure: { status: "rejected", at: "2026-11-07T11:40:00.000Z" },
      }),
      usageRow({
        serverId: spark,
        lastFailure: { status: "failed", at: "2026-11-07T11:50:00.000Z" },
      }),
    ];
    expect(inferenceServerRequestHealth(summary(rows), rtx).recentFailure).toEqual({
      status: "rejected",
      at: "2026-11-07T11:40:00.000Z",
    });
    expect(
      inferenceServerRequestHealth(
        summary([usageRow({ lastFailure: { status: "failed", at: "2026-11-07T10:59:00.000Z" } })]),
        rtx,
      ).recentFailure,
    ).toBeNull();
  });
});

describe("describeInferencePromptCache", () => {
  const full = {
    budgetBytes: 9_122_911_181,
    retainedBytes: 9_122_611_200,
    states: 25,
    recentCachedShare: 0.853,
  };

  it("summarizes a healthy cache without a warning", () => {
    expect(
      describeInferencePromptCache({
        engine: "TensorFold",
        promptCache: { ...full, status: "ok" },
      }),
    ).toEqual({
      summary:
        "Prompt cache 8.5 / 8.5 GiB · 25 saved prompts · 85% of prompt tokens cached recently",
      warning: null,
      advice: null,
    });
  });

  it.each([
    ["TensorFold", "none", true],
    ["vLLM", "none", false],
    ["TensorFold", "saturated-falling", true],
    ["llama.cpp", "saturated-falling", false],
  ] as const)("names --prompt-cache-gib for %s only (%s)", (engine, status, named) => {
    const health = describeInferencePromptCache({
      engine,
      promptCache: status === "none" ? { budgetBytes: 0, status } : { ...full, status },
    });
    expect(health?.warning === null).toBe(status === "none");
    expect(health?.advice?.includes("--prompt-cache-gib")).toBe(named);
  });

  it("leaves out what the server did not report", () => {
    expect(
      describeInferencePromptCache({ promptCache: { budgetBytes: 4 * 1024 ** 3, status: "ok" } })
        ?.summary,
    ).toBe("Prompt cache 4.0 GiB");
    expect(describeInferencePromptCache({ engine: "TensorFold" })).toBeNull();
  });
});

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
    ).toEqual(["Instructions or tools changed since the previous request"]);
    expect(formatLastRequestCached(measured)).toBe("cached 25%");
    expect(formatLastRequestCached({ ...measured, cachedPromptTokens: null })).toBeNull();
  });
});

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

describe("inferenceServerOutage", () => {
  const rtx = InferenceServerId.make("rtx");
  const snapshot = (status: InferenceServerSnapshot["status"]): InferenceServerSnapshot => ({
    id: rtx,
    displayName: "rtx",
    baseUrl: "http://localhost:8888/v1",
    enabled: true,
    status,
    checkedAt: null,
    message: "Could not connect to the server.",
    models: [],
  });
  const outage = (status: InferenceServerSnapshot["status"], enabled = true) =>
    inferenceServerOutage({
      serverId: rtx,
      servers: { [rtx]: { baseUrl: "http://localhost:8888/v1", apiKey: "", enabled } },
      snapshots: [snapshot(status)],
    });

  it("reports an enabled linked server that is down, not one being checked or turned off", () => {
    expect(outage("unreachable")).toEqual({
      id: rtx,
      name: "rtx",
      baseUrl: "http://localhost:8888/v1",
      message: "Could not connect to the server.",
    });
    expect(outage("checking")).toBeNull();
    expect(outage("unreachable", false)).toBeNull();
  });
});
