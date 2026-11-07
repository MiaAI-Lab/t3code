import {
  type InferenceApiProtocol,
  type InferenceRequestPurpose,
  InferenceServerId,
  type RunId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as InferenceRequests from "../persistence/InferenceRequests.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import * as InferenceAdmission from "./InferenceAdmission.ts";
import { parseBaseUrl } from "./InferenceServerRegistry.ts";
import { makeUsageMeter } from "./inferenceUsage.ts";

const INFERENCE_ROUTE_PREFIX = "/inference";

const GENERATION_PATHS: Readonly<Record<string, InferenceApiProtocol>> = {
  "chat/completions": "chat-completions",
  completions: "completions",
  responses: "responses",
  messages: "messages",
};

/** Prompts with inline images can be large; anything past this is refused before buffering more. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

// Only what the protocols need crosses; cookies, client credentials and proxy headers never do.
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
];
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
]);

const errorResponse = (status: number, type: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: { type, message } },
    { status, headers: { "cache-control": "no-store" } },
  );

const presentedToken = (request: HttpServerRequest.HttpServerRequest): string => {
  const authorization = request.headers.authorization;
  if (authorization !== undefined && /^bearer\s+/i.test(authorization)) {
    return authorization.replace(/^bearer\s+/i, "").trim();
  }
  return request.headers["x-api-key"]?.trim() ?? "";
};

const readBounded = (request: HttpServerRequest.HttpServerRequest) =>
  Stream.runFoldEffect(
    request.stream,
    () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
    (state, chunk) =>
      state.size + chunk.length > MAX_REQUEST_BYTES
        ? Effect.fail("too_large" as const)
        : Effect.succeed({ chunks: [...state.chunks, chunk], size: state.size + chunk.length }),
  ).pipe(Effect.map(({ chunks }) => Buffer.concat(chunks)));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Model and stream flag for accounting, plus the body to send: OpenAI streams ask for usage. */
function prepareBody(protocol: InferenceApiProtocol, raw: Uint8Array) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    return { model: "unknown", streaming: false, body: raw };
  }
  if (!isRecord(parsed)) return { model: "unknown", streaming: false, body: raw };
  const model =
    typeof parsed.model === "string" && parsed.model.trim() !== ""
      ? parsed.model.trim()
      : "unknown";
  const streaming = parsed.stream === true;
  const options = parsed.stream_options;
  if (
    streaming &&
    (protocol === "chat-completions" || protocol === "completions") &&
    (options === undefined || (isRecord(options) && options.include_usage === undefined))
  ) {
    const body = {
      ...parsed,
      stream_options: { ...(isRecord(options) ? options : {}), include_usage: true },
    };
    return { model, streaming, body: new TextEncoder().encode(JSON.stringify(body)) };
  }
  return { model, streaming, body: raw };
}

export class InferenceGateway extends Context.Service<
  InferenceGateway,
  {
    readonly handle: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("t3/inference/InferenceGateway") {}

const make = Effect.gen(function* () {
  const credentials = yield* McpSessionRegistry.McpSessionRegistry;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const admission = yield* InferenceAdmission.InferenceAdmission;
  const requestLog = yield* InferenceRequests.InferenceRequestLog;
  const random = yield* SecureRandom.SecureRandom;
  const threads = yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService);
  // Redirects are refused, not followed, so the upstream key never reaches another origin.
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    ),
  );

  /** Server-side only: a run started by a scheduled task is scheduled, any other run interactive. */
  const attribute = Effect.fn("InferenceGateway.attribute")(function* (
    caller: McpSessionRegistry.InferenceCaller,
  ) {
    if (caller.threadId === undefined) {
      return { purpose: "background" as InferenceRequestPurpose, runId: null };
    }
    if (Option.isNone(threads)) return { purpose: "interactive" as const, runId: null };
    const threadId = caller.threadId;
    const runId: RunId | null = yield* threads.value.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell?.activeRunId ?? null),
      Effect.orElseSucceed(() => null),
    );
    if (runId === null) return { purpose: "interactive" as const, runId };
    const scheduled = yield* threads.value
      .getThreadRecords(threadId, ["runs", "messages"], {
        runIds: [runId],
        messageRoles: ["user"],
      })
      .pipe(
        Effect.map((records) => {
          const run = records.runs.find((candidate) => candidate.id === runId);
          return records.messages.some(
            (message) => message.id === run?.userMessageId && message.scheduledTaskId !== undefined,
          );
        }),
        Effect.orElseSucceed(() => false),
      );
    return { purpose: scheduled ? ("scheduled" as const) : ("interactive" as const), runId };
  });

  const upstreamHeaders = (request: HttpServerRequest.HttpServerRequest, apiKey: string) => {
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    if (apiKey !== "") {
      headers.authorization = `Bearer ${apiKey}`;
      headers["x-api-key"] = apiKey;
    }
    return headers;
  };

  const responseHeaders = (headers: Readonly<Record<string, string | undefined>>) => {
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) kept[name] = value;
    }
    // Generation streams must reach the agent token by token, never buffered or compressed.
    kept["cache-control"] = "no-store, no-transform";
    return kept;
  };

  const handle = Effect.fn("InferenceGateway.handle")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const receivedAt = yield* Clock.currentTimeMillis;
    const path = new URL(request.url, "http://gateway").pathname;
    const match = /^\/inference\/([^/]+)\/v1\/(.+)$/.exec(path);
    if (match === null) return errorResponse(404, "not_found", "Unknown inference route.");
    const serverId = InferenceServerId.make(decodeURIComponent(match[1]!));
    const route = match[2]!;
    const protocol = GENERATION_PATHS[route];
    const listsModels = route === "models";
    if (!listsModels && protocol === undefined) {
      return errorResponse(404, "not_found", "T3's gateway does not forward this route.");
    }
    if ((listsModels && request.method !== "GET") || (!listsModels && request.method !== "POST")) {
      return errorResponse(405, "method_not_allowed", "Method not allowed.");
    }

    const caller = yield* credentials.resolveInference(presentedToken(request));
    if (caller === undefined) {
      return errorResponse(401, "authentication_error", "Missing or unknown gateway credential.");
    }
    if (caller.serverId !== serverId) {
      return errorResponse(403, "permission_error", "This credential is for another server.");
    }
    const config = yield* settingsService.getSettings.pipe(
      Effect.map((settings) => settings.inferenceServers[serverId]),
      Effect.orElseSucceed(() => undefined),
    );
    const endpoint = config?.enabled === true ? parseBaseUrl(config.baseUrl) : undefined;
    if (config === undefined || endpoint === undefined || "error" in endpoint) {
      return errorResponse(404, "not_found", "This inference server is off or not registered.");
    }
    const apiKey = yield* requireSettingsSecret(secrets, config.apiKey).pipe(
      Effect.map((value) => value.trim()),
      Effect.option,
    );
    if (Option.isNone(apiKey)) {
      return errorResponse(502, "upstream_error", "Could not read the server's API key.");
    }
    const upstreamUrl = `${endpoint.base}/${route}`;

    if (listsModels) {
      // Listing costs no generation, so it bypasses admission and the request log.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* HttpClient.withScope(client).execute(
            HttpClientRequest.get(upstreamUrl).pipe(
              HttpClientRequest.setHeaders(upstreamHeaders(request, apiKey.value)),
            ),
          );
          return HttpServerResponse.text(yield* response.text, {
            status: response.status,
            headers: responseHeaders(response.headers),
          });
        }),
      ).pipe(
        Effect.catchCause(() =>
          Effect.succeed(errorResponse(502, "upstream_error", "The server did not answer.")),
        ),
      );
    }

    const raw = yield* readBounded(request).pipe(Effect.result);
    if (raw._tag === "Failure") {
      return raw.failure === "too_large"
        ? errorResponse(413, "request_too_large", "The request body is too large.")
        : errorResponse(400, "invalid_request_error", "Could not read the request body.");
    }
    const prepared = prepareBody(protocol!, raw.success);
    const { purpose, runId } = yield* attribute(caller);
    const requestId = yield* random.uuidV4();
    const meter = makeUsageMeter(protocol!, prepared.streaming);
    const milestones = yield* Ref.make<{
      admittedAt?: number;
      dispatchedAt?: number;
      firstContentAt?: number;
    }>({});
    const lifetime = yield* Scope.make();

    const settled = yield* Ref.make(false);
    // Runs once: on completion, upstream failure, refusal, or the client going away.
    const finish = Effect.fnUntraced(function* (status: InferenceRequests.InferenceRequestStatus) {
      if (yield* Ref.getAndSet(settled, true)) return;
      const completedAt = yield* Clock.currentTimeMillis;
      const marks = yield* Ref.get(milestones);
      yield* Scope.close(lifetime, Exit.void);
      yield* requestLog.record({
        requestId,
        serverId,
        model: prepared.model,
        threadId: caller.threadId ?? null,
        runId,
        purpose,
        status,
        receivedAt,
        queueWaitMs: marks.admittedAt === undefined ? null : marks.admittedAt - receivedAt,
        ttftMs:
          marks.firstContentAt === undefined || marks.dispatchedAt === undefined
            ? null
            : marks.firstContentAt - marks.dispatchedAt,
        decodeMs:
          marks.firstContentAt === undefined || status !== "completed"
            ? null
            : completedAt - marks.firstContentAt,
        durationMs: completedAt - receivedAt,
        ...meter.finish(),
      });
    });

    const admitted = yield* admission.admit({ serverId, purpose, threadId: caller.threadId }).pipe(
      Scope.provide(lifetime),
      Effect.onInterrupt(() => finish("cancelled")),
      Effect.result,
    );
    if (admitted._tag === "Failure") {
      yield* finish("rejected");
      return errorResponse(503, "overloaded_error", admitted.failure.message);
    }
    const dispatchedAt = yield* Clock.currentTimeMillis;
    yield* Ref.set(milestones, { admittedAt: dispatchedAt, dispatchedAt });

    const response = yield* HttpClient.withScope(client)
      .execute(
        HttpClientRequest.post(upstreamUrl).pipe(
          HttpClientRequest.setHeaders(upstreamHeaders(request, apiKey.value)),
          HttpClientRequest.bodyUint8Array(prepared.body, "application/json"),
        ),
      )
      .pipe(
        Scope.provide(lifetime),
        Effect.onInterrupt(() => finish("cancelled")),
        Effect.result,
      );
    if (response._tag === "Failure") {
      yield* finish("failed");
      return errorResponse(502, "upstream_error", "Could not reach the inference server.");
    }
    const upstream = response.success;
    if (upstream.status >= 300 && upstream.status < 400) {
      yield* finish("failed");
      return errorResponse(502, "upstream_error", "The inference server answered with a redirect.");
    }
    const succeeded = upstream.status < 400;
    const body = upstream.stream.pipe(
      // Untraced per chunk: the request span already covers the stream.
      Stream.tap((chunk) =>
        meter.push(chunk)
          ? Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                Ref.update(milestones, (marks) => ({ ...marks, firstContentAt: now })),
              ),
            )
          : Effect.void,
      ),
      Stream.onExit((exit) =>
        finish(
          Exit.isSuccess(exit)
            ? succeeded
              ? "completed"
              : "failed"
            : Exit.hasInterrupts(exit)
              ? "cancelled"
              : "failed",
        ),
      ),
    );
    return HttpServerResponse.stream(body, {
      status: upstream.status,
      headers: responseHeaders(upstream.headers),
      ...(upstream.headers["content-type"] === undefined
        ? {}
        : { contentType: upstream.headers["content-type"] }),
    });
  });

  return InferenceGateway.of({ handle });
});

export const layer = Layer.effect(InferenceGateway, make);

/** Outside environment auth: the gateway credential is the only key, as with /mcp. */
export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const gateway = yield* InferenceGateway;
    return HttpRouter.add("*", `${INFERENCE_ROUTE_PREFIX}/*`, (request) => gateway.handle(request));
  }),
);
