import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
});
export type InferenceServerSnapshot = typeof InferenceServerSnapshot.Type;
