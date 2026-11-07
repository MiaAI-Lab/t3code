// @effect-diagnostics globalFetchInEffect:off -- the test calls the gateway as an outside HTTP client.
// @effect-diagnostics abortControllerInEffect:off -- aborting fetch is how that client disconnects.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import { InferenceServerId, MessageId, RunId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as InferenceRequests from "../persistence/InferenceRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as InferenceAdmission from "./InferenceAdmission.ts";
import * as InferenceGateway from "./InferenceGateway.ts";

const thread = ThreadId.make("thread-1");
const encoder = new TextEncoder();
const sse = (events: ReadonlyArray<unknown>) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

const CHAT_STREAM = sse([
  { choices: [{ delta: { role: "assistant" } }] },
  { choices: [{ delta: { content: "Hi" } }] },
  {
    choices: [],
    usage: { prompt_tokens: 15, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } },
  },
]);

interface Seen {
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

/** Fake upstreams mounted beside the gateway on one in-process server. */
const makeHarness = Effect.fnUntraced(function* (threads: Layer.Layer<never> = Layer.empty) {
  const seen = yield* Queue.unbounded<Seen>();
  const records = yield* Queue.unbounded<InferenceRequests.InferenceRequestRecord>();
  const hangStarted = yield* Deferred.make<void>();
  const capture = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = request.method === "POST" ? yield* request.text : "";
    yield* Queue.offer(seen, {
      url: request.url,
      headers: request.headers,
      body: text === "" ? undefined : JSON.parse(text),
    });
  });
  const upstream = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/up/v1/chat/completions",
      capture.pipe(
        Effect.as(
          HttpServerResponse.text(CHAT_STREAM, {
            contentType: "text/event-stream",
            headers: { "set-cookie": "upstream=1" },
          }),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/up/v1/messages",
      capture.pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe({
            content: [{ type: "text", text: "Hi" }],
            usage: { input_tokens: 9, cache_read_input_tokens: 1, output_tokens: 3 },
          }),
        ),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/up/v1/models",
      capture.pipe(Effect.as(HttpServerResponse.jsonUnsafe({ object: "list", data: [] }))),
    ),
    HttpRouter.add(
      "POST",
      "/redirect/v1/chat/completions",
      HttpServerResponse.empty({ status: 307, headers: { location: "/up/v1/chat/completions" } }),
    ),
    HttpRouter.add(
      "POST",
      "/hang/v1/chat/completions",
      Effect.as(
        capture,
        HttpServerResponse.stream(
          Stream.concat(
            // Content but no terminal event: the response is still mid-stream.
            Stream.make(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\n`,
              ),
            ),
            Stream.fromEffect(Deferred.succeed(hangStarted, undefined)).pipe(
              Stream.flatMap(() => Stream.never),
            ),
          ),
          { contentType: "text/event-stream" },
        ),
      ),
    ),
  );

  const tokens: Record<string, McpSessionRegistry.InferenceCaller> = {
    "thread-token": { serverId: InferenceServerId.make("rtx"), threadId: thread },
    "background-token": { serverId: InferenceServerId.make("rtx") },
    "hang-token": { serverId: InferenceServerId.make("hang"), threadId: thread },
    "redirect-token": { serverId: InferenceServerId.make("redirect") },
  };
  const services = yield* Layer.build(
    HttpRouter.serve(Layer.mergeAll(InferenceGateway.routeLayer, upstream), {
      disableListenLog: true,
    }).pipe(
      // The test server's own client prefixes its origin; the gateway dials absolute URLs.
      Layer.provide(InferenceGateway.layer.pipe(Layer.provide(FetchHttpClient.layer))),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(ServerSettings.layerTest()),
      Layer.provide([
        NodeCrypto.layer,
        Layer.succeed(InferenceRequests.InferenceRequestLog, {
          record: (record) => Queue.offer(records, record).pipe(Effect.asVoid),
          summarize: () => Effect.die("unused"),
          latestForThread: () => Effect.die("unused"),
        }),
        Layer.effect(
          InferenceAdmission.InferenceAdmission,
          InferenceAdmission.__testing.make({
            capacity: () => Effect.succeed(1),
            publish: () => Effect.void,
          }),
        ),
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolveInference: (token) => Effect.succeed(tokens[token]),
        }),
        Layer.mock(SecretResolver.SecretResolver)({}),
        threads,
      ]),
    ),
  );
  const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
  const settings = Context.get(services, ServerSettings.ServerSettingsService);
  const server = (path: string) => ({
    baseUrl: `${origin}/${path}/v1`,
    apiKey: "upstream-secret",
    enabled: true,
  });
  yield* settings.updateSettings({
    inferenceServers: {
      [InferenceServerId.make("rtx")]: server("up"),
      [InferenceServerId.make("hang")]: server("hang"),
      [InferenceServerId.make("redirect")]: server("redirect"),
    },
  });
  const call = (path: string, init: RequestInit = {}) =>
    Effect.promise(() => fetch(`${origin}/inference/${path}`, init));
  return { call, seen, records, hangStarted };
});

const post = (token: string, body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

it.live("streams chat completions with only the server's key and records usage", () =>
  Effect.gen(function* () {
    const { call, seen, records } = yield* makeHarness();
    const response = yield* call(
      "rtx/v1/chat/completions",
      post(
        "thread-token",
        { model: "GLM-5.3-Flash", stream: true, messages: [] },
        { cookie: "t3=session", "x-api-key": "thread-token" },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(yield* Effect.promise(() => response.text())).toBe(CHAT_STREAM);

    const upstream = yield* Queue.take(seen);
    expect(upstream.headers.authorization).toBe("Bearer upstream-secret");
    expect(upstream.headers["x-api-key"]).toBe("upstream-secret");
    expect(upstream.headers.cookie).toBeUndefined();
    expect(upstream.body).toEqual({
      model: "GLM-5.3-Flash",
      stream: true,
      messages: [],
      stream_options: { include_usage: true },
    });

    const record = yield* Queue.take(records);
    expect(record).toMatchObject({
      serverId: "rtx",
      model: "GLM-5.3-Flash",
      threadId: thread,
      purpose: "interactive",
      status: "completed",
      promptTokens: 15,
      cachedPromptTokens: 3,
      completionTokens: 2,
    });
    expect(record.queueWaitMs).toBeTypeOf("number");
    expect(record.ttftMs).toBeTypeOf("number");
  }),
);

it.live("reads non-streaming Anthropic usage and attributes background credentials", () =>
  Effect.gen(function* () {
    const { call, records } = yield* makeHarness();
    const response = yield* call("rtx/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "background-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: 10, messages: [] }),
    });
    expect(response.status).toBe(200);
    yield* Effect.promise(() => response.json());
    expect(yield* Queue.take(records)).toMatchObject({
      purpose: "background",
      threadId: null,
      status: "completed",
      promptTokens: 10,
      cachedPromptTokens: 1,
      completionTokens: 3,
      ttftMs: null,
    });
  }),
);

it.live("refuses unknown credentials, other servers, and routes off the allowlist", () =>
  Effect.gen(function* () {
    const { call, seen } = yield* makeHarness();
    const statusOf = (path: string, init: RequestInit) =>
      call(path, init).pipe(Effect.map((response) => response.status));
    expect(yield* statusOf("rtx/v1/chat/completions", post("mcp-token", {}))).toBe(401);
    expect(yield* statusOf("hang/v1/chat/completions", post("thread-token", {}))).toBe(403);
    expect(yield* statusOf("rtx/v1/embeddings", post("thread-token", {}))).toBe(404);
    expect(yield* statusOf("rtx/v1/models", post("thread-token", {}))).toBe(405);
    const models = yield* call("rtx/v1/models", {
      headers: { authorization: "Bearer thread-token" },
    });
    expect(models.status).toBe(200);
    expect((yield* Queue.take(seen)).url).toBe("/up/v1/models");
  }),
);

it.live("answers an upstream redirect with an error instead of following it", () =>
  Effect.gen(function* () {
    const { call, seen, records } = yield* makeHarness();
    const response = yield* call(
      "redirect/v1/chat/completions",
      post("redirect-token", { model: "m", stream: true }),
    );
    expect(response.status).toBe(502);
    expect((yield* Queue.take(records)).status).toBe("failed");
    expect(yield* Queue.size(seen)).toBe(0);
  }),
);

it.live("records a client disconnect mid-stream and frees the slot", () =>
  Effect.gen(function* () {
    const { call, records, hangStarted } = yield* makeHarness();
    const abort = new AbortController();
    const response = yield* call("hang/v1/chat/completions", {
      ...post("hang-token", { model: "m", stream: true }),
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    yield* Effect.promise(() => reader.read());
    yield* Deferred.await(hangStarted);
    abort.abort();
    const record = yield* Queue.take(records);
    expect(record.status).toBe("cancelled");
    expect(record.ttftMs).toBeTypeOf("number");

    // Capacity is one, so this is admitted only if the cancelled request released its slot.
    const again = new AbortController();
    const next = yield* call("hang/v1/chat/completions", {
      ...post("hang-token", { model: "m", stream: true }),
      signal: again.signal,
    });
    expect(next.status).toBe(200);
    again.abort();
    expect((yield* Queue.take(records)).status).toBe("cancelled");
  }),
);

it.live("attributes a request to its active run, its delegating run and its scheduled origin", () =>
  Effect.gen(function* () {
    const runId = RunId.make("run-1");
    const userMessageId = MessageId.make("message-1");
    const { call, records } = yield* makeHarness(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            activeRunId: runId,
            lineage: { relationshipToParent: "subagent" },
          } as never),
        getThreadRecords: () =>
          Effect.succeed({
            runs: [{ id: runId, userMessageId }],
            messages: [{ id: userMessageId, scheduledTaskId: ScheduledTaskId.make("task-1") }],
            contextTransfers: [
              {
                type: "subagent_spawn",
                targetThreadId: thread,
                sourcePoint: { threadId: "parent", runId: "parent-run" },
              },
            ],
          } as never),
      }),
    );
    const response = yield* call(
      "rtx/v1/chat/completions",
      post("thread-token", { model: "m", stream: true }),
    );
    yield* Effect.promise(() => response.text());
    expect(yield* Queue.take(records)).toMatchObject({
      purpose: "scheduled",
      runId,
      parentRunId: "parent-run",
    });
  }),
);

interface Exchange {
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
  readonly aborted: Deferred.Deferred<void>;
  readonly reply: Deferred.Deferred<Response, Error>;
}

/** A web response whose body the test writes to, chunk by chunk. */
const controlledBody = (init: ResponseInit = {}) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (control) => {
      controller = control;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      ...init,
    }),
    push: (text: string) => Effect.sync(() => controller.enqueue(encoder.encode(text))),
    end: Effect.sync(() => controller.close()),
    fail: Effect.sync(() => controller.error(new Error("upstream reset"))),
  };
};

const makeLifecycle = Effect.fnUntraced(function* () {
  const exchanges = yield* Queue.unbounded<Exchange>();
  const records = yield* Queue.unbounded<InferenceRequests.InferenceRequestRecord>();
  const queued = yield* Queue.unbounded<InferenceServerId>();
  const gate = yield* Deferred.make<void>();
  let releases = 0;

  const upstream = HttpClient.make((request, url, signal) =>
    Effect.gen(function* () {
      const aborted = yield* Deferred.make<void>();
      if (signal.aborted) Deferred.doneUnsafe(aborted, Exit.void);
      signal.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Exit.void));
      const reply = yield* Deferred.make<Response, Error>();
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      yield* Queue.offer(exchanges, {
        url: url.toString(),
        headers: request.headers,
        body,
        aborted,
        reply,
      });
      const response = yield* Deferred.await(reply).pipe(
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause }),
            }),
        ),
      );
      return HttpClientResponse.fromWeb(request, response);
    }),
  );

  const gateway = yield* Layer.build(
    InferenceGateway.layer.pipe(
      Layer.provide([
        Layer.succeed(HttpClient.HttpClient, upstream),
        ServerSettings.layerTest({
          inferenceServers: {
            [InferenceServerId.make("rtx")]: {
              baseUrl: "http://rtx.test/v1",
              apiKey: "rtx-key",
              enabled: true,
            },
          },
        }),
        NodeCrypto.layer,
        Layer.succeed(InferenceRequests.InferenceRequestLog, {
          record: (record) => Queue.offer(records, record).pipe(Effect.asVoid),
          summarize: () => Effect.die("unused"),
          latestForThread: () => Effect.die("unused"),
        }),
        Layer.succeed(InferenceAdmission.InferenceAdmission, {
          // Mirrors the real queue: enqueueing is the acquire, waiting for a slot is interruptible.
          admit: (ticket) =>
            Effect.acquireRelease(Queue.offer(queued, ticket.serverId), () =>
              Effect.sync(() => {
                releases += 1;
              }),
            ).pipe(Effect.andThen(Deferred.await(gate))),
        }),
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolveInference: () =>
            Effect.succeed({ serverId: InferenceServerId.make("rtx"), threadId: thread }),
        }),
        Layer.mock(SecretResolver.SecretResolver)({}),
      ]),
    ),
  ).pipe(Effect.map((context) => Context.get(context, InferenceGateway.InferenceGateway)));

  /** Starts a request the way the HTTP server does: in a request scope the test closes. */
  const start = Effect.fnUntraced(function* (body: unknown = { model: "m", stream: true }) {
    const requestScope = yield* Scope.make();
    const handler = yield* gateway
      .handle(
        HttpServerRequest.fromWeb(
          new Request("http://gateway.test/inference/rtx/v1/chat/completions", {
            method: "POST",
            headers: { authorization: "Bearer thread-token", "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      )
      .pipe(Scope.provide(requestScope), Effect.forkChild({ startImmediately: true }));
    /** The client went away: the server interrupts the handler and closes the request scope. */
    const disconnect = Fiber.interrupt(handler).pipe(
      Effect.andThen(Scope.close(requestScope, Exit.void)),
    );
    return { handler, requestScope, disconnect };
  });

  /** Exactly one terminal record and one admission release once everything has settled. */
  const settledOnce = Effect.fnUntraced(function* () {
    const record = yield* Queue.take(records);
    expect(yield* Queue.size(records)).toBe(0);
    expect(releases).toBe(1);
    return record;
  });

  return { start, exchanges, queued, gate, settledOnce };
});

const bodyText = (response: HttpServerResponse.HttpServerResponse) =>
  (response.body._tag === "Stream" ? response.body.stream : Stream.empty).pipe(Stream.orDie);

it.effect("a client leaving while queued settles once and never dispatches", () =>
  Effect.gen(function* () {
    const { start, exchanges, queued, settledOnce } = yield* makeLifecycle();
    const { disconnect } = yield* start();
    yield* Queue.take(queued);
    yield* disconnect;
    expect((yield* settledOnce()).status).toBe("cancelled");
    expect(yield* Queue.size(exchanges)).toBe(0);
  }),
);

it.effect("a client leaving while upstream headers are pending aborts the upstream", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { disconnect } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    yield* disconnect;
    yield* Deferred.await(exchange.aborted);
    expect((yield* settledOnce()).status).toBe("cancelled");
  }),
);

it.effect("a client gone before the body is subscribed releases the lease and aborts", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { handler, requestScope } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    yield* Deferred.succeed(exchange.reply, controlledBody().response);
    expect((yield* Fiber.join(handler)).status).toBe(200);
    // A destroyed response is never written: the server closes the scope without reading the body.
    yield* Scope.close(requestScope, Exit.void);
    yield* Deferred.await(exchange.aborted);
    expect((yield* settledOnce()).status).toBe("cancelled");
  }),
);

it.effect("a client leaving mid-stream aborts the upstream and settles once", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { handler, requestScope } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    const upstream = controlledBody();
    yield* Deferred.succeed(exchange.reply, upstream.response);
    const response = yield* Fiber.join(handler);
    const received = yield* Queue.unbounded<Uint8Array>();
    const writer = yield* Stream.runForEach(bodyText(response), (chunk) =>
      Queue.offer(received, chunk),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* upstream.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\n`);
    yield* Queue.take(received);
    yield* Fiber.interrupt(writer);
    yield* Scope.close(requestScope, Exit.void);
    yield* Deferred.await(exchange.aborted);
    const record = yield* settledOnce();
    expect(record.status).toBe("cancelled");
    expect(record.ttftMs).toBeTypeOf("number");
  }),
);

it.effect("a client abort racing an upstream error records one terminal state", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { handler, requestScope } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    const upstream = controlledBody();
    yield* Deferred.succeed(exchange.reply, upstream.response);
    const writer = yield* Stream.runDrain(bodyText(yield* Fiber.join(handler))).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* upstream.fail;
    yield* Fiber.interrupt(writer);
    yield* Scope.close(requestScope, Exit.void);
    expect(["failed", "cancelled"]).toContain((yield* settledOnce()).status);
  }),
);

it.effect("a client abort racing body completion records one terminal state", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { handler, requestScope } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    const upstream = controlledBody();
    yield* Deferred.succeed(exchange.reply, upstream.response);
    const writer = yield* Stream.runDrain(bodyText(yield* Fiber.join(handler))).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* upstream.push(CHAT_STREAM);
    yield* upstream.end;
    yield* Fiber.interrupt(writer);
    yield* Scope.close(requestScope, Exit.void);
    expect(["completed", "cancelled"]).toContain((yield* settledOnce()).status);
  }),
);

it.effect("a completed request settles once with its usage", () =>
  Effect.gen(function* () {
    const { start, exchanges, gate, settledOnce } = yield* makeLifecycle();
    yield* Deferred.succeed(gate, undefined);
    const { handler, requestScope } = yield* start();
    const exchange = yield* Queue.take(exchanges);
    const upstream = controlledBody();
    yield* Deferred.succeed(exchange.reply, upstream.response);
    const writer = yield* Stream.runDrain(bodyText(yield* Fiber.join(handler))).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* upstream.push(CHAT_STREAM);
    yield* upstream.end;
    yield* Fiber.join(writer);
    yield* Scope.close(requestScope, Exit.void);
    expect(yield* settledOnce()).toMatchObject({
      status: "completed",
      promptTokens: 15,
      cachedPromptTokens: 3,
    });
  }),
);
