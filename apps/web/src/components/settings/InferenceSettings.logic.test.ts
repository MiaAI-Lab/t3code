import { InferenceServerId, type InferenceUsageRow } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  describeInferenceModelContext,
  describeInferenceServerFallback,
  describeInferenceServerProbeFreshness,
  EMPTY_INFERENCE_SERVER_DRAFT,
  inferenceServerFromDraft,
  inferenceServerIdFromName,
  inferenceServerRemovalPatch,
  inferenceServerRequestHealth,
  normalizeInferenceServerBaseUrl,
  presentInferenceServers,
  resolveInferenceServerLink,
} from "./InferenceSettings.logic";

describe("normalizeInferenceServerBaseUrl", () => {
  it.each([
    ["http://localhost:11434", "http://localhost:11434/v1"],
    [" http://localhost:11434/ ", "http://localhost:11434/v1"],
    ["https://spark1:8888/v1/", "https://spark1:8888/v1"],
    ["http://10.0.0.2:8000/openai/v1", "http://10.0.0.2:8000/openai/v1"],
  ])("accepts %s", (raw, expected) => {
    expect(normalizeInferenceServerBaseUrl(raw)).toEqual(Result.succeed(expected));
  });

  it.each([
    ["", "Enter the server URL."],
    ["localhost:11434", "Use an http:// or https:// URL."],
    ["not a url", "Enter a full URL, such as http://localhost:11434/v1."],
    ["ftp://host/v1", "Use an http:// or https:// URL."],
    ["http://user:pass@host/v1", "Remove the credentials from the URL and put the key in API key."],
    ["http://host/v1?api_key=abc", "Remove the query string; put any key in API key."],
    ["http://host/v1?", "Remove the query string; put any key in API key."],
    ["http://host/v1#x", "Remove the #fragment from the URL."],
  ])("rejects %j", (raw, message) => {
    expect(normalizeInferenceServerBaseUrl(raw)).toEqual(Result.fail(message));
  });
});

describe("inferenceServerIdFromName", () => {
  it.each([
    ["RTX 5090", "rtx-5090"],
    ["  Spark #1 ", "spark-1"],
    ["4090 box", "server-4090-box"],
    ["!!!", null],
  ])("%j -> %j", (name, id) => {
    expect(inferenceServerIdFromName(name)).toBe(id);
  });
});

describe("inferenceServerFromDraft", () => {
  const draft = { ...EMPTY_INFERENCE_SERVER_DRAFT, baseUrl: "http://spark1:8888" };

  it("slugs the name, falls back to the host, and refuses an existing id on add", () => {
    expect(inferenceServerFromDraft({ ...draft, name: "RTX" }, new Set(), { mode: "add" })).toEqual(
      Result.succeed({
        id: "rtx",
        config: {
          displayName: "RTX",
          baseUrl: "http://spark1:8888/v1",
          apiKey: "",
          enabled: true,
        },
      }),
    );
    const byHost = inferenceServerFromDraft(draft, new Set(), { mode: "add" });
    expect(Result.isSuccess(byHost) && byHost.success.id).toBe("spark1");
    expect(inferenceServerFromDraft(draft, new Set(["spark1"]), { mode: "add" })).toEqual(
      Result.fail({ name: "A server with this name exists." }),
    );
  });

  it("keeps the id and enabled flag on edit and validates max concurrency", () => {
    const target = { mode: "edit", id: InferenceServerId.make("rtx"), enabled: false } as const;
    const edited = inferenceServerFromDraft(
      { ...draft, name: "Renamed", maxConcurrency: "4", apiKey: " key " },
      new Set(["rtx"]),
      target,
    );
    expect(edited).toEqual(
      Result.succeed({
        id: "rtx",
        config: {
          displayName: "Renamed",
          baseUrl: "http://spark1:8888/v1",
          apiKey: "key",
          enabled: false,
          maxConcurrency: 4,
        },
      }),
    );
    for (const maxConcurrency of ["0", "1.5", "two"]) {
      expect(inferenceServerFromDraft({ ...draft, maxConcurrency }, new Set(), target)).toEqual(
        Result.fail({ maxConcurrency: "Enter a whole number of 1 or more, or leave it empty." }),
      );
    }
  });

  it("keeps a fallback only when it names another registered server", () => {
    const target = { mode: "edit", id: InferenceServerId.make("rtx"), enabled: true } as const;
    const withFallback = inferenceServerFromDraft(
      { ...draft, fallbackServerId: "spark1" },
      new Set(["rtx", "spark1"]),
      target,
    );
    expect(Result.isSuccess(withFallback) && withFallback.success.config.fallbackServerId).toBe(
      "spark1",
    );
    for (const fallbackServerId of ["rtx", "gone"]) {
      expect(
        inferenceServerFromDraft({ ...draft, fallbackServerId }, new Set(["rtx"]), target),
      ).toEqual(Result.fail({ fallbackServerId: "Choose another registered server, or none." }));
    }
  });
});

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

  it("removes a server and clears it as others' fallback in one patch", () => {
    const withFallbacks = {
      ...servers,
      [InferenceServerId.make("old")]: { ...servers.old, fallbackServerId: "rtx" },
      [InferenceServerId.make("spark1")]: {
        baseUrl: "http://spark1/v1",
        apiKey: "",
        enabled: true,
        fallbackServerId: "old",
      },
    } as unknown as typeof servers;
    expect(inferenceServerRemovalPatch(withFallbacks, InferenceServerId.make("rtx"))).toEqual({
      rtx: null,
      old: { baseUrl: "http://old/v1", apiKey: "", enabled: false },
    });
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
