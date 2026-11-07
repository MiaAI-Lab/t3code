import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type InferenceApiProtocol,
  type InferenceGatewayQueue,
  type InferenceServerConfig,
  InferenceServerId,
  type InferenceServerLoad,
  type InferenceServerModel,
  type InferenceServerPromptCache,
  type InferenceServerSnapshot,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";

export class InferenceServerRegistry extends Context.Service<
  InferenceServerRegistry,
  {
    readonly current: Effect.Effect<ReadonlyArray<InferenceServerSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<InferenceServerSnapshot>>;
    /** Probes every enabled server, or only `id`, and returns every snapshot after it. */
    readonly refresh: (
      id?: InferenceServerId,
    ) => Effect.Effect<ReadonlyArray<InferenceServerSnapshot>>;
    /** The gateway's view of its own requests to `id`, carried on that server's snapshot. */
    readonly publishGatewayQueue: (
      id: InferenceServerId,
      queue: InferenceGatewayQueue,
    ) => Effect.Effect<void>;
  }
>()("t3/inference/InferenceServerRegistry") {}

const MODELS_TIMEOUT = Duration.seconds(5);
const ENRICHMENT_TIMEOUT = Duration.seconds(3);

type Endpoint =
  | { readonly base: string; readonly origin: string; readonly display: string }
  | { readonly error: string; readonly display: string };

/** Whether a credential pinned to `pinned` still routes where `current` would. */
export const routesAlike = (pinned: InferenceServerConfig, current: InferenceServerConfig) =>
  pinned.baseUrl === current.baseUrl &&
  JSON.stringify(pinned.apiKey) === JSON.stringify(current.apiKey) &&
  pinned.fallbackServerId === current.fallbackServerId;

export function parseBaseUrl(raw: string): Endpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      error: "The base URL is not a valid URL.",
      display: raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^/@]*@/i, "$1"),
    };
  }
  const display = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "The base URL must start with http:// or https://.", display };
  }
  if (url.username !== "" || url.password !== "") {
    return { error: "Put credentials in the API key, not the base URL.", display };
  }
  if (url.search !== "" || url.hash !== "") {
    return {
      error: "The base URL cannot carry a query string; put credentials in the API key.",
      display,
    };
  }
  return { base: display, origin: url.origin, display };
}

function displayNameOf(id: string, config: InferenceServerConfig): string {
  if (config.displayName) return config.displayName;
  try {
    return new URL(config.baseUrl).hostname || id;
  } catch {
    return id;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const nonEmptyStrings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === "string" && entry.trim() !== "" ? [entry.trim()] : [],
      )
    : [];

const ModelList = Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Unknown) }));
const decodeModelList = Schema.decodeUnknownOption(ModelList);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function readModel(raw: unknown): InferenceServerModel | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.trim() === "") return undefined;
  const served = positiveInt(raw.context_length) ?? positiveInt(raw.max_model_len);
  // llama.cpp reports what the weights were trained for, not the --ctx-size it serves.
  const trained = isRecord(raw.meta) ? positiveInt(raw.meta.n_ctx_train) : undefined;
  const efforts = isRecord(raw.reasoning) ? nonEmptyStrings(raw.reasoning.supported_efforts) : [];
  return {
    id: raw.id.trim(),
    ...(served === undefined ? {} : { servedContextWindow: served }),
    ...(trained === undefined ? {} : { trainedContextWindow: trained }),
    ...(efforts.length === 0 ? {} : { reasoningEfforts: efforts }),
  };
}

const ENGINE_BY_OWNER: Readonly<Record<string, string>> = {
  tensorfold: "TensorFold",
  vllm: "vLLM",
  llamacpp: "llama.cpp",
};

const METRICS = [
  {
    engine: "TensorFold",
    running: "tensorfold:requests_running",
    waiting: "tensorfold:requests_waiting",
  },
  { engine: "vLLM", running: "vllm:num_requests_running", waiting: "vllm:num_requests_waiting" },
  {
    engine: "llama.cpp",
    running: "llamacpp:requests_processing",
    waiting: "llamacpp:requests_deferred",
  },
] as const;

/** Sums each series across its labels. */
function sumMetrics(text: string): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(\S+)/.exec(line.trim());
    if (match === null) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0) continue;
    totals.set(match[1]!, (totals.get(match[1]!) ?? 0) + value);
  }
  return totals;
}

/** The first engine whose two load gauges are present. */
function readLoad(
  totals: ReadonlyMap<string, number>,
): { engine: string; load: InferenceServerLoad } | undefined {
  for (const family of METRICS) {
    const running = totals.get(family.running);
    const waiting = totals.get(family.waiting);
    if (running === undefined || waiting === undefined) continue;
    return {
      engine: family.engine,
      load: { running: Math.round(running), waiting: Math.round(waiting) },
    };
  }
  return undefined;
}

/** Cumulative prompt-token counters from the previous probe, and the share they last produced. */
export interface PromptCacheCounters {
  readonly hits: number;
  readonly queries: number;
  readonly share?: number;
  readonly falling?: boolean;
}

const FALLING_MARGIN = 0.1;
const SATURATED_SHARE = 0.95;

/**
 * TensorFold's prompt cache, with the cached share of the prompt tokens queried since `previous`.
 * Counters below `previous` mean the server restarted, so they count from zero.
 */
export function readPromptCache(
  totals: ReadonlyMap<string, number>,
  previous: PromptCacheCounters | undefined,
): { readonly cache?: InferenceServerPromptCache; readonly counters?: PromptCacheCounters } {
  const budget = totals.get("tensorfold:prompt_cache_budget_bytes");
  if (budget === undefined) return {};
  const budgetBytes = Math.round(budget);
  if (budgetBytes === 0) return { cache: { budgetBytes, status: "none" } };
  const retained = totals.get("tensorfold:prompt_cache_bytes");
  const states = totals.get("tensorfold:prompt_cache_states");
  const hits = totals.get("tensorfold:prefix_cache_hits_total");
  const queries = totals.get("tensorfold:prefix_cache_queries_total");

  let counters: PromptCacheCounters | undefined;
  if (hits !== undefined && queries !== undefined) {
    const reset = previous !== undefined && (hits < previous.hits || queries < previous.queries);
    const base = reset ? { hits: 0, queries: 0 } : previous;
    const queried = base === undefined ? 0 : queries - base.queries;
    if (base === undefined || queried <= 0) {
      counters = reset ? { hits, queries } : { ...previous, hits, queries };
    } else {
      const share = Math.min(1, Math.max(0, (hits - base.hits) / queried));
      const falling = previous?.share !== undefined && share < previous.share - FALLING_MARGIN;
      counters = { hits, queries, share, falling };
    }
  }

  // Full once there is no room for another state; without its size, past a fixed share.
  const room = totals.get("tensorfold:prompt_cache_minimum_state_bytes");
  const saturated =
    retained !== undefined &&
    budget - retained < (room !== undefined && room > 0 ? room : budget * (1 - SATURATED_SHARE));
  return {
    cache: {
      budgetBytes,
      ...(retained === undefined ? {} : { retainedBytes: Math.round(retained) }),
      ...(states === undefined ? {} : { states: Math.round(states) }),
      ...(counters?.share === undefined ? {} : { recentCachedShare: counters.share }),
      status: saturated && counters?.falling === true ? "saturated-falling" : "ok",
    },
    ...(counters === undefined ? {} : { counters }),
  };
}

/**
 * The served window of a linked instance's model, matched by exact id or a harness slug ending in
 * `/<id>`. `unmatched` names a ready server that does not list the model.
 */
export function servedContextWindowForModel(input: {
  readonly instance: Pick<ProviderInstanceConfig, "inferenceServerId"> | undefined;
  readonly inferenceServers: ServerSettings["inferenceServers"];
  readonly snapshots: ReadonlyArray<InferenceServerSnapshot>;
  readonly model: string;
}): { readonly window?: number; readonly unmatched?: InferenceServerId } {
  const serverId = input.instance?.inferenceServerId;
  if (serverId === undefined || input.inferenceServers[serverId]?.enabled !== true) return {};
  const snapshot = input.snapshots.find((candidate) => candidate.id === serverId);
  if (snapshot?.status !== "ready") return {};
  const model = snapshot.models.find(
    (candidate) => input.model === candidate.id || input.model.endsWith(`/${candidate.id}`),
  );
  if (model === undefined) return { unmatched: serverId };
  return model.servedContextWindow === undefined ? {} : { window: model.servedContextWindow };
}

const PROTOCOL_PATHS: ReadonlyArray<readonly [InferenceApiProtocol, string]> = [
  ["chat-completions", "chat/completions"],
  ["completions", "completions"],
  ["responses", "responses"],
  ["messages", "messages"],
];

type Fetched =
  | { readonly _tag: "Response"; readonly status: number; readonly body: string }
  | { readonly _tag: "Unreachable"; readonly timedOut: boolean };

/** @public */
export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<InferenceServerSnapshot>>([]);
  const cacheCounters = yield* Ref.make(new Map<InferenceServerId, PromptCacheCounters>());
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<InferenceServerSnapshot>>(),
    PubSub.shutdown,
  );

  const fetchText = Effect.fn("InferenceServerRegistry.fetch")(function* (
    url: string,
    apiKey: string,
    timeout: Duration.Duration,
  ) {
    const request = HttpClientRequest.get(url).pipe(
      apiKey === "" ? (request) => request : HttpClientRequest.bearerToken(apiKey),
    );
    return yield* client.execute(request).pipe(
      Effect.flatMap((response) =>
        Effect.map(response.text, (body): Fetched => ({
          _tag: "Response",
          status: response.status,
          body,
        })),
      ),
      Effect.timeoutOption(timeout),
      Effect.map((result) =>
        result._tag === "Some" ? result.value : ({ _tag: "Unreachable", timedOut: true } as const),
      ),
      Effect.orElseSucceed(() => ({ _tag: "Unreachable", timedOut: false }) as const),
    );
  });

  /**
   * An empty POST costs no generation: a served route rejects it as invalid (400/422), a missing
   * one answers 404/405. Anything else proves nothing either way.
   */
  const protocolServed = Effect.fn("InferenceServerRegistry.protocolServed")(function* (
    url: string,
    apiKey: string,
  ) {
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText("{}", "application/json"),
      apiKey === "" ? (request) => request : HttpClientRequest.bearerToken(apiKey),
    );
    return yield* client.execute(request).pipe(
      Effect.map(
        (response) =>
          response.status === 400 ||
          response.status === 422 ||
          (response.status >= 200 && response.status < 300),
      ),
      Effect.timeoutOption(ENRICHMENT_TIMEOUT),
      Effect.map((result) => result._tag === "Some" && result.value),
      Effect.orElseSucceed(() => false),
    );
  });

  const enrichmentJson = (url: string, apiKey: string) =>
    fetchText(url, apiKey, ENRICHMENT_TIMEOUT).pipe(
      Effect.map((fetched) =>
        fetched._tag === "Response" && fetched.status >= 200 && fetched.status < 300
          ? decodeJson(fetched.body).pipe((option) =>
              option._tag === "Some" ? option.value : undefined,
            )
          : undefined,
      ),
    );

  const probe = Effect.fn("InferenceServerRegistry.probe")(function* (
    id: InferenceServerId,
    config: InferenceServerConfig,
  ) {
    const endpoint = parseBaseUrl(config.baseUrl);
    const base = {
      id,
      displayName: displayNameOf(id, config),
      baseUrl: endpoint.display,
      enabled: config.enabled,
      models: [],
    } as const;
    if (!config.enabled) {
      return { ...base, status: "unreachable", checkedAt: null, message: "Turned off." } as const;
    }
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if ("error" in endpoint) {
      return { ...base, status: "error", checkedAt, message: endpoint.error } as const;
    }
    const apiKey = yield* requireSettingsSecret(secrets, config.apiKey).pipe(
      Effect.map((value) => value.trim()),
      Effect.option,
    );
    if (apiKey._tag === "None") {
      return {
        ...base,
        status: "error",
        checkedAt,
        message: "Could not read the API key from its secret provider.",
      } as const;
    }
    const key = apiKey.value;

    const listed = yield* fetchText(`${endpoint.base}/models`, key, MODELS_TIMEOUT);
    if (listed._tag === "Unreachable") {
      return {
        ...base,
        status: "unreachable",
        checkedAt,
        message: listed.timedOut
          ? "The server did not answer in time."
          : "Could not connect to the server.",
      } as const;
    }
    if (listed.status === 401 || listed.status === 403) {
      return {
        ...base,
        status: "error",
        checkedAt,
        message: "The server rejected the API key.",
      } as const;
    }
    if (listed.status < 200 || listed.status >= 300) {
      return {
        ...base,
        status: "error",
        checkedAt,
        message: `The server answered ${listed.status} when listing models.`,
      } as const;
    }
    const list = decodeModelList(listed.body);
    if (list._tag === "None") {
      return {
        ...base,
        status: "error",
        checkedAt,
        message: "The server's model list is not in the OpenAI format.",
      } as const;
    }
    const models = list.value.data.flatMap((raw) => readModel(raw) ?? []);
    const owner = list.value.data.find(isRecord)?.owned_by;
    const ownerEngine = typeof owner === "string" ? ENGINE_BY_OWNER[owner] : undefined;

    // Optional: a failure here never downgrades the model list above.
    const [health, metricsText, slots, protocols] = yield* Effect.all(
      [
        ownerEngine === "TensorFold"
          ? enrichmentJson(`${endpoint.origin}/health`, key)
          : Effect.undefined,
        fetchText(`${endpoint.origin}/metrics`, key, ENRICHMENT_TIMEOUT),
        ownerEngine === "llama.cpp"
          ? enrichmentJson(`${endpoint.origin}/slots`, key)
          : Effect.undefined,
        Effect.forEach(
          PROTOCOL_PATHS,
          ([protocol, path]) =>
            protocolServed(`${endpoint.base}/${path}`, key).pipe(
              Effect.map((served) => (served ? [protocol] : [])),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((found) => found.flat())),
      ],
      { concurrency: "unbounded" },
    );
    const totals =
      metricsText._tag === "Response" && metricsText.status >= 200 && metricsText.status < 300
        ? sumMetrics(metricsText.body)
        : undefined;
    const metrics = totals === undefined ? undefined : readLoad(totals);
    const { cache, counters } =
      totals === undefined ? {} : readPromptCache(totals, (yield* Ref.get(cacheCounters)).get(id));
    yield* Ref.update(cacheCounters, (all) => {
      const next = new Map(all);
      if (counters === undefined) next.delete(id);
      else next.set(id, counters);
      return next;
    });
    const engine = ownerEngine ?? metrics?.engine;
    // Batch size means concurrent requests only where that is verified for the engine.
    const maxConcurrentRequests =
      engine === "TensorFold" && isRecord(health)
        ? positiveInt(health.max_batch_size)
        : engine === "llama.cpp" && Array.isArray(slots) && slots.length > 0
          ? slots.length
          : undefined;
    return {
      ...base,
      status: "ready",
      checkedAt,
      models,
      ...(engine === undefined ? {} : { engine }),
      ...(metrics === undefined ? {} : { load: metrics.load }),
      ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
      ...(protocols.length === 0 ? {} : { apiProtocols: protocols }),
      ...(cache === undefined ? {} : { promptCache: cache }),
    } as const;
  });

  const gatewayQueues = yield* Ref.make(new Map<InferenceServerId, InferenceGatewayQueue>());
  const withGatewayQueues = (
    snapshots: ReadonlyArray<InferenceServerSnapshot>,
    queues: ReadonlyMap<InferenceServerId, InferenceGatewayQueue>,
  ) =>
    snapshots.map((snapshot) => {
      const queue = queues.get(snapshot.id);
      const { gatewayQueue: _previous, ...rest } = snapshot;
      return queue === undefined ? rest : { ...rest, gatewayQueue: queue };
    });

  const publish = Effect.fn("InferenceServerRegistry.publish")(function* (
    snapshots: ReadonlyArray<InferenceServerSnapshot>,
  ) {
    const next = withGatewayQueues(snapshots, yield* Ref.get(gatewayQueues));
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Untraced: it runs on every admission change; the gateway request span covers it.
  const publishGatewayQueue = Effect.fnUntraced(function* (
    id: InferenceServerId,
    queue: InferenceGatewayQueue,
  ) {
    const idle = queue.active.length === 0 && queue.waiting.length === 0;
    yield* Ref.update(gatewayQueues, (queues) => {
      const next = new Map(queues);
      if (idle) next.delete(id);
      else next.set(id, queue);
      return next;
    });
    yield* publish(yield* Ref.get(stateRef));
  });

  // Serialized so a slow probe of old settings cannot resurrect a removed server.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.fn("InferenceServerRegistry.refresh")(
    function* (only?: InferenceServerId) {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.orElseSucceed((): ServerSettings | null => null),
      );
      if (settings === null) return yield* Ref.get(stateRef);
      const previous = new Map(
        (yield* Ref.get(stateRef)).map((snapshot) => [snapshot.id, snapshot]),
      );
      const entries = Object.entries(settings.inferenceServers).map(
        ([rawId, config]) => [InferenceServerId.make(rawId), config] as const,
      );
      const isTarget = (id: InferenceServerId) => only === undefined || only === id;
      // New servers show as checking until their first probe lands.
      yield* publish(
        entries.map(
          ([id, config]) =>
            previous.get(id) ?? {
              id,
              displayName: displayNameOf(id, config),
              baseUrl: parseBaseUrl(config.baseUrl).display,
              enabled: config.enabled,
              status: "checking" as const,
              checkedAt: null,
              models: [],
            },
        ),
      );
      const snapshots = yield* Effect.forEach(
        entries,
        ([id, config]) =>
          isTarget(id) || previous.get(id) === undefined
            ? probe(id, config)
            : Effect.succeed(previous.get(id)!),
        { concurrency: 4 },
      );
      yield* publish(snapshots);
      return snapshots;
    },
    (effect) => refreshLock.withPermits(1)(effect),
    Effect.catchCause((cause) =>
      Effect.logError("inference server refresh failed", { cause }).pipe(
        Effect.andThen(Ref.get(stateRef)),
      ),
    ),
  );

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.inferenceServers),
    Stream.changes,
    Stream.runForEach(() => refresh()),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh() : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  // Startup never waits on a server that may be asleep or gone.
  yield* refresh().pipe(Effect.forkScoped);

  return InferenceServerRegistry.of({
    current: Ref.get(stateRef),
    refresh,
    publishGatewayQueue,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  });
});

export const layer = Layer.effect(InferenceServerRegistry, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);
