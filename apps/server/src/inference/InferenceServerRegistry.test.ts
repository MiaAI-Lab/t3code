import { describe, expect, it } from "@effect/vitest";
import {
  InferenceServerId,
  SecretProviderId,
  type InferenceServerConfig,
  type InferenceServerSnapshot,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

// A string is a 200 text body, `{ statusCode }` an empty error, anything else a JSON body.
type Route = unknown;
type Routes = Readonly<Record<string, Route>>;

const rtx = InferenceServerId.make("rtx");
const HOST = "http://rtx.test:8888";

const layerFakeHttp = (routes: Routes, seen: Array<{ url: string; auth: string | undefined }>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        seen.push({ url: request.url, auth: request.headers["authorization"] });
        const route = routes[request.url];
        if (route === "unreachable" || route === "hang") {
          return route === "hang"
            ? Effect.never
            : Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause: new TypeError("fetch failed"),
                  }),
                }),
              );
        }
        const response =
          route === undefined
            ? new Response("Not Found", { status: 404 })
            : typeof route === "string"
              ? new Response(route, { status: 200 })
              : typeof route === "object" && route !== null && "statusCode" in route
                ? new Response("", { status: (route as { statusCode: number }).statusCode })
                : Response.json(route);
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
    ),
  );

/** Probes again for each entry of `later`, with that entry's routes changed. */
const probe = (
  routes: Routes,
  config: Partial<InferenceServerConfig> = {},
  seen: Array<{ url: string; auth: string | undefined }> = [],
  later: ReadonlyArray<Routes> = [],
) => {
  const live: Record<string, Route> = { ...routes };
  return Effect.gen(function* () {
    const registry = yield* InferenceServerRegistry.make;
    let snapshots = yield* registry.refresh();
    for (const changed of later) {
      Object.assign(live, changed);
      snapshots = yield* registry.refresh();
    }
    return snapshots.find((snapshot) => snapshot.id === rtx);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        inferenceServers: {
          [rtx]: { baseUrl: `${HOST}/v1`, apiKey: "", enabled: true, ...config },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) =>
          Effect.succeed(
            references.map((reference) =>
              reference.reference === "rtx#key" ? "resolved-key" : undefined,
            ),
          ),
        invalidate: () => Effect.void,
      }),
      layerFakeHttp(live, seen),
    ]),
    Effect.scoped,
  );
};

const tensorFoldModels = {
  object: "list",
  data: [
    {
      id: "GLM-5.3-Flash",
      object: "model",
      owned_by: "tensorfold",
      context_length: 813056,
      max_model_len: 813056,
      reasoning: {
        default_enabled: false,
        default_effort: "xhigh",
        supported_efforts: ["max", "high", "low"],
      },
    },
  ],
};

// Trimmed from real TensorFold /metrics captures: rtx with a full 9.1 GB cache, spark1 with none.
const rtxMetrics = (hits: number, queries: number) =>
  [
    "tensorfold:requests_running 0",
    "tensorfold:requests_waiting 0",
    "# TYPE tensorfold:prompt_cache_budget_bytes gauge",
    "tensorfold:prompt_cache_budget_bytes 9122911181",
    "tensorfold:prompt_cache_minimum_state_bytes 249561088",
    "tensorfold:prompt_cache_states 18",
    "tensorfold:prompt_cache_bytes 9122611200",
    "# TYPE tensorfold:prefix_cache_queries_total counter",
    `tensorfold:prefix_cache_queries_total ${queries}`,
    `tensorfold:prefix_cache_hits_total ${hits}`,
  ].join("\n");
const spark1Metrics = [
  "tensorfold:requests_running 1",
  "tensorfold:requests_waiting 0",
  "tensorfold:prompt_cache_budget_bytes 0",
  "tensorfold:prompt_cache_minimum_state_bytes 272629760",
  "tensorfold:prompt_cache_can_keep_state 0",
].join("\n");

describe("InferenceServerRegistry probes", () => {
  it.effect("reads TensorFold models, batch size, and load", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const snapshot = yield* probe(
        {
          [`${HOST}/v1/models`]: tensorFoldModels,
          [`${HOST}/health`]: {
            status: "ok",
            model: "GLM-5.3-Flash",
            max_batch_size: 4,
            warming: false,
          },
          [`${HOST}/metrics`]:
            "# HELP tensorfold:requests_running Running\ntensorfold:requests_running 1\ntensorfold:requests_waiting 0\n",
          // Routes that exist reject an empty body; missing ones answer 404.
          [`${HOST}/v1/chat/completions`]: { statusCode: 400 },
          [`${HOST}/v1/responses`]: { statusCode: 422 },
          [`${HOST}/v1/messages`]: { statusCode: 400 },
          [`${HOST}/v1/completions`]: { statusCode: 500 },
        },
        { apiKey: "secret-key", displayName: "rtx" },
        seen,
      );
      expect(snapshot).toMatchObject({
        id: rtx,
        displayName: "rtx",
        baseUrl: `${HOST}/v1`,
        enabled: true,
        status: "ready",
        engine: "TensorFold",
        models: [
          {
            id: "GLM-5.3-Flash",
            servedContextWindow: 813056,
            reasoningEfforts: ["max", "high", "low"],
          },
        ],
        load: { running: 1, waiting: 0 },
        maxConcurrentRequests: 4,
        apiProtocols: ["chat-completions", "responses", "messages"],
      });
      expect(snapshot?.checkedAt).toBeTypeOf("string");
      expect(seen.every(({ auth }) => auth === "Bearer secret-key")).toBe(true);
    }),
  );

  it.effect("reads the prompt cache and its cached share between probes", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe(
        {
          [`${HOST}/v1/models`]: tensorFoldModels,
          [`${HOST}/metrics`]: rtxMetrics(35_252_224, 44_188_980),
        },
        {},
        [],
        [{ [`${HOST}/metrics`]: rtxMetrics(35_252_224 + 850, 44_188_980 + 1_000) }],
      );
      expect(snapshot?.promptCache).toEqual({
        budgetBytes: 9_122_911_181,
        retainedBytes: 9_122_611_200,
        states: 18,
        recentCachedShare: 0.85,
        status: "ok",
      });
    }),
  );

  it.effect("reports a zero budget as no prompt cache, and no metrics as unknown", () =>
    Effect.gen(function* () {
      const none = yield* probe({
        [`${HOST}/v1/models`]: tensorFoldModels,
        [`${HOST}/metrics`]: spark1Metrics,
      });
      expect(none?.promptCache).toEqual({ budgetBytes: 0, status: "none" });
      const unknown = yield* probe({
        [`${HOST}/v1/models`]: tensorFoldModels,
        [`${HOST}/metrics`]: "tensorfold:requests_running 0\ntensorfold:requests_waiting 0\n",
      });
      expect(unknown?.promptCache).toBeUndefined();
    }),
  );

  it.effect("reads vLLM's served window and labeled load, without trusting its batch size", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe(
        {
          [`${HOST}/v1/models`]: {
            object: "list",
            data: [
              {
                id: "Qwen/Qwen3-32B",
                object: "model",
                owned_by: "vllm",
                root: "Qwen/Qwen3-32B",
                max_model_len: 32768,
              },
            ],
          },
          [`${HOST}/health`]: { max_batch_size: 256 },
          [`${HOST}/metrics`]: [
            'vllm:num_requests_running{model_name="Qwen/Qwen3-32B"} 2.0',
            'vllm:num_requests_waiting{model_name="Qwen/Qwen3-32B"} 3.0',
          ].join("\n"),
        },
        {},
      );
      expect(snapshot).toMatchObject({
        status: "ready",
        engine: "vLLM",
        models: [{ id: "Qwen/Qwen3-32B", servedContextWindow: 32768 }],
        load: { running: 2, waiting: 3 },
      });
      expect(snapshot?.maxConcurrentRequests).toBeUndefined();
      expect(snapshot?.apiProtocols).toBeUndefined();
    }),
  );

  it.effect("keeps llama.cpp's trained window apart from the served one and counts its slots", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe({
        [`${HOST}/v1/models`]: {
          object: "list",
          data: [
            {
              id: "gemma-3-27b.gguf",
              object: "model",
              created: 1,
              owned_by: "llamacpp",
              meta: { n_vocab: 262144, n_ctx_train: 131072, n_params: 27_000_000_000 },
            },
          ],
        },
        [`${HOST}/slots`]: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }],
        [`${HOST}/metrics`]: "llamacpp:requests_processing 1\nllamacpp:requests_deferred 2\n",
      });
      expect(snapshot).toMatchObject({
        status: "ready",
        engine: "llama.cpp",
        models: [{ id: "gemma-3-27b.gguf", trainedContextWindow: 131072 }],
        load: { running: 1, waiting: 2 },
        maxConcurrentRequests: 4,
      });
      expect(snapshot?.models[0]?.servedContextWindow).toBeUndefined();
    }),
  );

  it.effect.each([
    ["Ollama", { id: "qwen3:8b", object: "model", created: 1, owned_by: "library" }],
    ["LM Studio", { id: "qwen/qwen3-8b", object: "model", owned_by: "organization_owner" }],
  ] as const)("lists %s models without metadata or enrichments", ([, model]) =>
    Effect.gen(function* () {
      const snapshot = yield* probe({
        [`${HOST}/v1/models`]: { object: "list", data: [model] },
      });
      expect(snapshot).toMatchObject({ status: "ready", models: [{ id: model.id }] });
      expect(snapshot?.engine).toBeUndefined();
      expect(snapshot?.load).toBeUndefined();
      expect(snapshot?.maxConcurrentRequests).toBeUndefined();
    }),
  );

  it.effect("skips entries without an id and ignores metadata of the wrong type", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe({
        [`${HOST}/v1/models`]: {
          data: [
            { object: "model" },
            "not a model",
            { id: "kept", context_length: "huge", reasoning: { supported_efforts: [1, "low"] } },
          ],
        },
      });
      expect(snapshot?.status).toBe("ready");
      expect(snapshot?.models).toEqual([{ id: "kept", reasoningEfforts: ["low"] }]);
    }),
  );

  it.effect("keeps a successful model list when every enrichment fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe({
        [`${HOST}/v1/models`]: tensorFoldModels,
        [`${HOST}/health`]: { statusCode: 500 },
        [`${HOST}/metrics`]: "unreachable",
      });
      expect(snapshot).toMatchObject({
        status: "ready",
        engine: "TensorFold",
        models: [{ id: "GLM-5.3-Flash" }],
      });
      expect(snapshot?.load).toBeUndefined();
      expect(snapshot?.maxConcurrentRequests).toBeUndefined();
    }),
  );

  it.effect.each([
    ["malformed JSON", { [`${HOST}/v1/models`]: "<html>not json" }, "error"],
    ["a non-list body", { [`${HOST}/v1/models`]: { models: [] } }, "error"],
    ["a rejected key", { [`${HOST}/v1/models`]: { statusCode: 401 } }, "error"],
    ["a server error", { [`${HOST}/v1/models`]: { statusCode: 503 } }, "error"],
    ["an unreachable host", { [`${HOST}/v1/models`]: "unreachable" }, "unreachable"],
  ] as const)("reports %s with a message", ([, routes, status]) =>
    Effect.gen(function* () {
      const snapshot = yield* probe(routes);
      expect(snapshot?.status).toBe(status);
      expect(snapshot?.message).toBeTypeOf("string");
      expect(snapshot?.models).toEqual([]);
    }),
  );

  it.effect("gives up on a server that never answers", () =>
    Effect.gen(function* () {
      const fiber = yield* probe({ [`${HOST}/v1/models`]: "hang" }).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const snapshot = yield* Fiber.join(fiber);
      expect(snapshot?.status).toBe("unreachable");
    }),
  );

  it.effect.each([
    ["credentials", "http://user:hunter2@rtx.test:8888/v1"],
    ["a query string", "http://rtx.test:8888/v1?api_key=hunter2"],
  ] as const)("refuses a base URL carrying %s without calling it", ([, baseUrl]) =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const snapshot = yield* probe({}, { baseUrl }, seen);
      expect(snapshot?.status).toBe("error");
      expect(snapshot?.message).toBeTypeOf("string");
      expect(snapshot?.baseUrl).not.toContain("hunter2");
      expect(seen).toEqual([]);
    }),
  );

  it.effect("normalizes a trailing slash and reads a referenced API key", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const snapshot = yield* probe(
        { [`${HOST}/v1/models`]: tensorFoldModels },
        {
          baseUrl: `${HOST}/v1/`,
          apiKey: { provider: SecretProviderId.make("vault"), reference: "rtx#key" },
        },
        seen,
      );
      expect(snapshot?.status).toBe("ready");
      expect(snapshot?.baseUrl).toBe(`${HOST}/v1`);
      expect(seen[0]).toEqual({ url: `${HOST}/v1/models`, auth: "Bearer resolved-key" });
    }),
  );

  it.effect("does not call a server whose key cannot be read", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const snapshot = yield* probe(
        { [`${HOST}/v1/models`]: tensorFoldModels },
        { apiKey: { provider: SecretProviderId.make("vault"), reference: "missing#key" } },
        seen,
      );
      expect(snapshot?.status).toBe("error");
      expect(seen).toEqual([]);
    }),
  );

  it.effect("lists a turned-off server without probing it", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const snapshot = yield* probe(
        { [`${HOST}/v1/models`]: tensorFoldModels },
        { enabled: false },
        seen,
      );
      expect(snapshot).toMatchObject({ enabled: false, models: [] });
      expect(snapshot?.status).not.toBe("ready");
      expect(seen).toEqual([]);
    }),
  );
});

// The test settings layer never streams changes; this one publishes each update.
const layerLiveSettings = Layer.effect(
  ServerSettings.ServerSettingsService,
  Effect.gen(function* () {
    const base = yield* ServerSettings.ServerSettingsService;
    const changes = yield* PubSub.unbounded<ServerSettingsType>();
    return {
      ...base,
      updateSettings: (patch) =>
        base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
    } satisfies ServerSettings.ServerSettingsService["Service"];
  }),
).pipe(Layer.provide(ServerSettings.layerTest()));

describe("InferenceServerRegistry lifecycle", () => {
  it.effect("carries the gateway queue on the snapshot until it drains, across probes", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const registry = yield* InferenceServerRegistry.make;
      yield* settings.updateSettings({
        inferenceServers: { [rtx]: { baseUrl: `${HOST}/v1`, apiKey: "", enabled: true } },
      });
      yield* registry.refresh();
      const queue = {
        capacity: 1,
        active: [{ purpose: "background" as const }],
        waiting: [{ purpose: "interactive" as const, position: 1 }],
      };
      yield* registry.publishGatewayQueue(rtx, queue);
      expect((yield* registry.current)[0]?.gatewayQueue).toEqual(queue);
      yield* registry.refresh(rtx);
      expect((yield* registry.current)[0]?.gatewayQueue).toEqual(queue);
      yield* registry.publishGatewayQueue(rtx, { capacity: 1, active: [], waiting: [] });
      expect((yield* registry.current)[0]?.gatewayQueue).toBeUndefined();
    }).pipe(
      Effect.provide([
        layerLiveSettings,
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        Layer.mock(SecretResolver.SecretResolver)({}),
        layerFakeHttp({ [`${HOST}/v1/models`]: tensorFoldModels }, []),
      ]),
      Effect.scoped,
    ),
  );

  it.effect("probes a server added in settings and drops a removed one", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const registry = yield* InferenceServerRegistry.make;
      const updates = yield* registry.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots.some((snapshot) => snapshot.status === "ready")),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* settings.updateSettings({
        inferenceServers: { [rtx]: { baseUrl: `${HOST}/v1`, apiKey: "", enabled: true } },
      });
      const ready = yield* Fiber.join(updates).pipe(Effect.flatMap(Effect.fromOption));
      expect(ready.map((snapshot: InferenceServerSnapshot) => snapshot.id)).toEqual([rtx]);

      const removed = yield* registry.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots.length === 0),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* settings.updateSettings({ inferenceServers: { [rtx]: null } });
      expect(yield* Fiber.join(removed).pipe(Effect.flatMap(Effect.fromOption))).toEqual([]);
    }).pipe(
      Effect.provide([
        layerLiveSettings,
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        Layer.mock(SecretResolver.SecretResolver)({}),
        layerFakeHttp({ [`${HOST}/v1/models`]: tensorFoldModels }, []),
      ]),
      Effect.scoped,
    ),
  );

  it.effect("probes on the interval only while background work may run", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      let mayRun = false;
      const program = Effect.gen(function* () {
        const registry = yield* InferenceServerRegistry.make;
        yield* registry.refresh();
        yield* TestClock.adjust("10 minutes");
        const afterStartup = seen.length;
        yield* TestClock.adjust("10 minutes");
        expect(seen.length).toBe(afterStartup);
        mayRun = true;
        yield* TestClock.adjust("10 minutes");
        expect(seen.length).toBeGreaterThan(afterStartup);
      });
      yield* program.pipe(
        Effect.provide([
          ServerSettings.layerTest({
            inferenceServers: { [rtx]: { baseUrl: `${HOST}/v1`, apiKey: "", enabled: true } },
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.sync(() => mayRun),
          }),
          Layer.mock(SecretResolver.SecretResolver)({}),
          layerFakeHttp({ [`${HOST}/v1/models`]: tensorFoldModels }, seen),
        ]),
        Effect.scoped,
      );
    }),
  );
});

describe("servedContextWindowForModel", () => {
  const snapshot: InferenceServerSnapshot = {
    id: rtx,
    displayName: "rtx",
    baseUrl: `${HOST}/v1`,
    enabled: true,
    status: "ready",
    checkedAt: "2026-11-07T00:00:00.000Z",
    models: [
      { id: "GLM-5.3-Flash", servedContextWindow: 813056 },
      { id: "gemma.gguf", trainedContextWindow: 131072 },
    ],
  };
  const lookup = (model: string, options: { enabled?: boolean; linked?: boolean } = {}) =>
    InferenceServerRegistry.servedContextWindowForModel({
      instance: options.linked === false ? {} : { inferenceServerId: rtx },
      inferenceServers: {
        [rtx]: { baseUrl: `${HOST}/v1`, apiKey: "", enabled: options.enabled ?? true },
      },
      snapshots: [snapshot],
      model,
    });

  it.each([
    ["an exact id", "GLM-5.3-Flash", { window: 813056 }],
    ["a harness slug", "t3-rtx/GLM-5.3-Flash", { window: 813056 }],
    ["a model with only a trained window", "gemma.gguf", {}],
    ["a model the server does not list", "GLM-4", { unmatched: rtx }],
    ["a look-alike suffix", "notGLM-5.3-Flash", { unmatched: rtx }],
  ] as const)("matches %s", (_, model, expected) => {
    expect(lookup(model)).toEqual(expected);
  });

  it("knows nothing for an unlinked instance or a turned-off server", () => {
    expect(lookup("GLM-5.3-Flash", { linked: false })).toEqual({});
    expect(lookup("GLM-5.3-Flash", { enabled: false })).toEqual({});
  });
});

describe("readPromptCache", () => {
  const totals = (values: Readonly<Record<string, number>>) =>
    new Map(Object.entries(values).map(([name, value]) => [`tensorfold:${name}`, value]));
  const full = { prompt_cache_budget_bytes: 1_000, prompt_cache_bytes: 990 };
  const half = { prompt_cache_budget_bytes: 1_000, prompt_cache_bytes: 500 };
  const counted = (hits: number, queries: number) => ({
    prefix_cache_hits_total: hits,
    prefix_cache_queries_total: queries,
  });
  const before = { hits: 140, queries: 200, share: 0.9, falling: false };

  it.each([
    [
      "first sight has no share",
      full,
      counted(50, 100),
      undefined,
      { status: "ok" },
      { hits: 50, queries: 100 },
    ],
    [
      "an interval's share",
      full,
      counted(140, 200),
      { hits: 50, queries: 100 },
      { recentCachedShare: 0.9, status: "ok" },
      before,
    ],
    [
      "an idle interval keeps the last share",
      full,
      counted(140, 200),
      before,
      { recentCachedShare: 0.9, status: "ok" },
      before,
    ],
    [
      "a restart counts from zero",
      full,
      counted(30, 100),
      { hits: 900, queries: 1_000, share: 0.9, falling: false },
      { recentCachedShare: 0.3, status: "saturated-falling" },
      { hits: 30, queries: 100, share: 0.3, falling: true },
    ],
    [
      "a falling share in a full cache",
      full,
      counted(160, 300),
      before,
      { recentCachedShare: 0.2, status: "saturated-falling" },
      { hits: 160, queries: 300, share: 0.2, falling: true },
    ],
    [
      "a falling share with room to spare",
      half,
      counted(160, 300),
      before,
      { recentCachedShare: 0.2, status: "ok" },
      { hits: 160, queries: 300, share: 0.2, falling: true },
    ],
  ] as const)("%s", (_, cache, counters, previous, expected, next) => {
    const read = InferenceServerRegistry.readPromptCache(
      totals({ ...cache, ...counters }),
      previous,
    );
    expect(read.cache).toMatchObject(expected);
    if (!("recentCachedShare" in expected)) expect(read.cache?.recentCachedShare).toBeUndefined();
    expect(read.counters).toEqual(next);
  });

  it("knows nothing without a budget", () => {
    expect(InferenceServerRegistry.readPromptCache(totals(counted(1, 2)), undefined)).toEqual({});
  });
});
