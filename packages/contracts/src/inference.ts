import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const INFERENCE_SERVER_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** A user-registered model server (Ollama, LM Studio, llama.cpp, vLLM, ...) this environment can reach. */
export const InferenceServerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(INFERENCE_SERVER_ID_PATTERN),
).pipe(Schema.brand("InferenceServerId"));
export type InferenceServerId = typeof InferenceServerId.Type;

export const InferenceServerStatus = Schema.Literals(["checking", "ready", "unreachable", "error"]);
export type InferenceServerStatus = typeof InferenceServerStatus.Type;

export const InferenceServerModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The limit the server enforces for requests; only this drives budgets. */
  servedContextWindow: Schema.optional(NonNegativeInt),
  /** What the weights were trained for; informational only. */
  trainedContextWindow: Schema.optional(NonNegativeInt),
  maxOutputTokens: Schema.optional(NonNegativeInt),
  reasoningEfforts: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type InferenceServerModel = typeof InferenceServerModel.Type;

export const InferenceServerLoad = Schema.Struct({
  running: NonNegativeInt,
  waiting: NonNegativeInt,
});
export type InferenceServerLoad = typeof InferenceServerLoad.Type;

/** Request protocols a server serves under its base URL, as T3's gateway forwards them. */
export const InferenceApiProtocol = Schema.Literals([
  "chat-completions",
  "completions",
  "responses",
  "messages",
]);
export type InferenceApiProtocol = typeof InferenceApiProtocol.Type;

/** Who asked: a user's turn, a scheduled task, or T3's own background writing. */
export const InferenceRequestPurpose = Schema.Literals(["interactive", "scheduled", "background"]);
export type InferenceRequestPurpose = typeof InferenceRequestPurpose.Type;

/** Requests T3's gateway is holding or running against this server; other clients are not counted. */
export const InferenceGatewayQueue = Schema.Struct({
  capacity: NonNegativeInt,
  active: Schema.Array(
    Schema.Struct({ threadId: Schema.optional(ThreadId), purpose: InferenceRequestPurpose }),
  ),
  waiting: Schema.Array(
    Schema.Struct({
      threadId: Schema.optional(ThreadId),
      purpose: InferenceRequestPurpose,
      position: NonNegativeInt,
    }),
  ),
});
export type InferenceGatewayQueue = typeof InferenceGatewayQueue.Type;

export const InferenceServerSnapshot = Schema.Struct({
  id: InferenceServerId,
  displayName: TrimmedNonEmptyString,
  baseUrl: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  status: InferenceServerStatus,
  checkedAt: Schema.NullOr(IsoDateTime),
  message: Schema.optional(TrimmedNonEmptyString),
  engine: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(InferenceServerModel),
  load: Schema.optional(InferenceServerLoad),
  /** Requests the server says it runs at once; reported only for engines where that meaning is verified. */
  maxConcurrentRequests: Schema.optional(NonNegativeInt),
  /** Protocols the probe saw the server route; absent when none were confirmed. */
  apiProtocols: Schema.optional(Schema.Array(InferenceApiProtocol)),
  gatewayQueue: Schema.optional(InferenceGatewayQueue),
});
export type InferenceServerSnapshot = typeof InferenceServerSnapshot.Type;

const Distribution = Schema.Struct({
  n: NonNegativeInt,
  p50: Schema.NullOr(Schema.Number),
  p95: Schema.NullOr(Schema.Number),
});

export const InferenceUsageWindow = Schema.Literals(["24h", "7d"]);
export type InferenceUsageWindow = typeof InferenceUsageWindow.Type;

/** Measured by T3's gateway; requests that bypass it are not included. Missing measurements are excluded from n. */
export const InferenceUsageRow = Schema.Struct({
  serverId: InferenceServerId,
  model: TrimmedNonEmptyString,
  purpose: InferenceRequestPurpose,
  requests: NonNegativeInt,
  failed: NonNegativeInt,
  promptTokens: NonNegativeInt,
  cachedPromptTokens: NonNegativeInt,
  /** Prompt tokens of the requests whose server reported cache usage; the denominator for a cached share. */
  promptTokensWithCacheData: Schema.optional(NonNegativeInt),
  completionTokens: NonNegativeInt,
  queueWaitMs: Distribution,
  ttftMs: Distribution,
  decodeTokensPerSecond: Distribution,
});
export type InferenceUsageRow = typeof InferenceUsageRow.Type;

export const InferenceUsageSummary = Schema.Struct({
  window: InferenceUsageWindow,
  generatedAt: IsoDateTime,
  rows: Schema.Array(InferenceUsageRow),
});
export type InferenceUsageSummary = typeof InferenceUsageSummary.Type;

/** The latest gateway request a thread made, for its prompt budget. */
export const InferenceThreadLastRequest = Schema.Struct({
  serverId: InferenceServerId,
  model: TrimmedNonEmptyString,
  completedAt: IsoDateTime,
  promptTokens: Schema.NullOr(NonNegativeInt),
  cachedPromptTokens: Schema.NullOr(NonNegativeInt),
  completionTokens: Schema.NullOr(NonNegativeInt),
  queueWaitMs: Schema.NullOr(NonNegativeInt),
  ttftMs: Schema.NullOr(NonNegativeInt),
  decodeTokensPerSecond: Schema.NullOr(Schema.Number),
  /** Set when the request went to a fallback because this server could not take it. */
  fallbackFrom: Schema.optional(InferenceServerId),
  /** Compared with the thread's previous request; absent when there is none or it was not measured. */
  staticPrefixChanged: Schema.optional(Schema.Boolean),
  serverChanged: Schema.optional(Schema.Boolean),
});
export type InferenceThreadLastRequest = typeof InferenceThreadLastRequest.Type;
