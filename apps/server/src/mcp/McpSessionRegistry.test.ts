import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, InferenceServerId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const pinned = { baseUrl: "http://localhost:8888/v1", apiKey: "", enabled: true };
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer, livenessWindowMs = 100) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.thread.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(
      new Set(["preview", "orchestration", "worktree", "pull-requests"]),
    );

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual([
      "orchestration",
      "preview",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual([
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withDevice)).toEqual([
      "device",
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
  }),
);

// regression: #3114 use bound host for MCP endpoint
it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("only a trusted touch restores an expired token with its original scope", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-idle");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const scope = yield* registry.resolve(token);
    expect(scope).toBeDefined();

    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
    const otherThreadId = ThreadId.make("thread-active");
    const other = yield* registry.issue({
      threadId: otherThreadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    yield* registry.touch(otherThreadId);
    expect(
      (yield* registry.resolve(other.config.authorizationHeader.replace(/^Bearer\s+/, "")))?.thread
        .threadId,
    ).toBe(otherThreadId);
    expect(yield* registry.resolve("unknown-token")).toBeUndefined();
    expect(yield* registry.resolve(token)).toBeUndefined();

    yield* registry.touch(threadId);
    expect(yield* registry.resolve(token)).toEqual(scope);
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect.each(["provider-session", "thread", "all"] as const)(
  "never restores an expired token after %s revocation",
  (revocation) =>
    Effect.gen(function* () {
      let timestamp = 1_000;
      const registry = yield* makeRegistry(() => timestamp);
      const threadId = ThreadId.make("thread-revoked");
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

      timestamp += 101;
      yield* {
        "provider-session": registry.revokeProviderSession(issued.config.providerSessionId),
        thread: registry.revokeThread(threadId),
        all: registry.revokeAll,
      }[revocation];
      yield* registry.touch(threadId);
      expect(yield* registry.resolve(token)).toBeUndefined();
    }),
);

it.effect("keeps inference credentials apart from MCP and revokes them with the session", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("thread-local");
    const serverId = InferenceServerId.make("rtx");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("pi"),
      capabilities: new Set(),
      inferenceServer: { id: serverId, config: pinned },
    });
    const gateway = issued.config.inferenceGateway;
    expect(gateway?.baseUrl).toBe("http://127.0.0.1:43123/inference/rtx/v1");
    const mcpToken = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const inferenceToken = gateway!.token;
    expect(inferenceToken).not.toBe(mcpToken);

    expect(yield* registry.resolve(inferenceToken)).toBeUndefined();
    expect(yield* registry.resolveInference(mcpToken)).toBeUndefined();
    expect(yield* registry.resolveInference(inferenceToken)).toEqual({
      serverId,
      pinned,
      threadId,
      providerSessionId: issued.config.providerSessionId,
      providerInstanceId: ProviderInstanceId.make("pi"),
    });

    yield* registry.revokeProviderSession(issued.config.providerSessionId);
    expect(yield* registry.resolveInference(inferenceToken)).toBeUndefined();

    const reissued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("pi"),
      inferenceServer: { id: serverId, config: pinned },
    });
    yield* registry.revokeThread(threadId);
    expect(
      yield* registry.resolveInference(reissued.config.inferenceGateway!.token),
    ).toBeUndefined();

    const unlinked = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("pi"),
    });
    expect(unlinked.config.inferenceGateway).toBeUndefined();
  }),
);

it.effect(
  "background inference credentials have no thread, expire unless an instance holds them, and end with their scope",
  () =>
    Effect.gen(function* () {
      let timestamp = 1_000;
      const registry = yield* makeRegistry(
        () => timestamp,
        fakeHttpServer,
        2 * McpSessionRegistry.BACKGROUND_INFERENCE_TTL_MS,
      );
      const serverId = InferenceServerId.make("rtx");
      const scope = yield* Scope.make();
      const background = yield* registry
        .issueBackgroundInference({ id: serverId, config: pinned })
        .pipe(Scope.provide(scope));
      expect(background.baseUrl).toBe("http://127.0.0.1:43123/inference/rtx/v1");
      expect(yield* registry.resolve(background.token)).toBeUndefined();
      expect(yield* registry.resolveInference(background.token)).toEqual({ serverId, pinned });
      yield* Scope.close(scope, Exit.void);
      expect(yield* registry.resolveInference(background.token)).toBeUndefined();

      const lingering = yield* registry
        .issueBackgroundInference({ id: serverId, config: pinned })
        .pipe(Scope.provide(yield* Scope.make()));
      const instanceId = ProviderInstanceId.make("opencode");
      const processScope = yield* Scope.make();
      const instance = yield* registry
        .issueBackgroundInference({ id: serverId, config: pinned }, instanceId)
        .pipe(Scope.provide(processScope));
      timestamp += McpSessionRegistry.BACKGROUND_INFERENCE_TTL_MS + 1;
      expect(yield* registry.resolveInference(lingering.token)).toBeUndefined();
      expect(yield* registry.resolveInference(instance.token)).toEqual({
        serverId,
        pinned,
        providerInstanceId: instanceId,
      });
      yield* Scope.close(processScope, Exit.void);
      expect(yield* registry.resolveInference(instance.token)).toBeUndefined();
    }),
);

it.effect("names a harness session's thread only within its instance, until released", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const opencode = ProviderInstanceId.make("opencode");
    const other = ProviderInstanceId.make("opencode_work");
    const thread = ThreadId.make("thread-1");
    const scope = yield* Scope.make();
    yield* registry
      .attributeHarnessSessions(opencode, (sessionId) =>
        sessionId === "ses_a" ? thread : undefined,
      )
      .pipe(Scope.provide(scope));
    expect(yield* registry.harnessSessionThread(opencode, "ses_a")).toBe(thread);
    expect(yield* registry.harnessSessionThread(opencode, "ses_b")).toBeUndefined();
    expect(yield* registry.harnessSessionThread(other, "ses_a")).toBeUndefined();
    yield* Scope.close(scope, Exit.void);
    expect(yield* registry.harnessSessionThread(opencode, "ses_a")).toBeUndefined();
  }),
);
