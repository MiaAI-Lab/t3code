import { expect, it } from "@effect/vitest";
import {
  type InferenceServerSnapshot,
  InferenceServerId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as InferenceGateway from "@t3tools/provider-core/server/inferenceGateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as InferenceGatewayAccess from "./InferenceGatewayAccess.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

const rtx = InferenceServerId.make("rtx");
const pi = ProviderInstanceId.make("pi_local");

const ready: InferenceServerSnapshot = {
  id: rtx,
  displayName: "rtx",
  baseUrl: "http://localhost:8888/v1",
  enabled: true,
  status: "ready",
  checkedAt: null,
  models: [
    {
      id: "GLM-5.3-Flash",
      servedContextWindow: 813056,
      trainedContextWindow: 1_000_000,
      reasoningEfforts: ["high", "low"],
    },
  ],
  apiProtocols: ["chat-completions", "messages"],
};

const access = (snapshot: InferenceServerSnapshot, enabled = true) =>
  Effect.gen(function* () {
    const service = yield* InferenceGateway.InferenceGatewayAccess;
    const managed = yield* service.managedServer(pi);
    const background = yield* Effect.scoped(service.backgroundCredential(pi));
    return { managed, background };
  }).pipe(
    Effect.provide(
      InferenceGatewayAccess.layer.pipe(
        Layer.provide([
          ServerSettings.layerTest({
            inferenceServers: {
              [rtx]: { baseUrl: "http://localhost:8888/v1", apiKey: "", enabled },
            },
            providerInstances: {
              [pi]: { driver: ProviderDriverKind.make("pi"), inferenceServerId: rtx },
            },
          }),
          Layer.mock(InferenceServerRegistry.InferenceServerRegistry)({
            current: Effect.succeed([snapshot]),
          }),
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            issueBackgroundInference: (serverId) =>
              Effect.succeed({ serverId, baseUrl: "http://t3/inference/rtx/v1", token: "bg" }),
          }),
        ]),
      ),
    ),
  );

it.effect(
  "manages a linked server only while it is enabled, ready, and serves chat completions",
  () =>
    Effect.gen(function* () {
      const managed = yield* access(ready);
      expect(managed.managed).toEqual({
        serverId: rtx,
        displayName: "rtx",
        models: [{ id: "GLM-5.3-Flash", contextWindow: 813056, reasoningEfforts: ["high", "low"] }],
      });
      expect(managed.background?.credential.token).toBe("bg");

      for (const unmanaged of [
        yield* access(ready, false),
        yield* access({ ...ready, status: "unreachable" }),
        yield* access({ ...ready, apiProtocols: ["messages"] }),
        yield* access({ ...ready, models: [] }),
      ]) {
        expect(unmanaged).toEqual({ managed: undefined, background: undefined });
      }
    }),
);
