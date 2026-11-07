import type {
  InferenceServerId,
  InferenceServerSnapshot,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";
import * as InferenceGateway from "@t3tools/provider-core/server/inferenceGateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

/** What a harness can use through the gateway; undefined unless verified for chat completions. */
function managedServerOf(
  settings: ServerSettings,
  snapshots: ReadonlyArray<InferenceServerSnapshot>,
  serverId: InferenceServerId | undefined,
): InferenceGateway.ManagedInferenceServer | undefined {
  if (serverId === undefined || settings.inferenceServers[serverId]?.enabled !== true) {
    return undefined;
  }
  const snapshot = snapshots.find((candidate) => candidate.id === serverId);
  if (
    snapshot?.status !== "ready" ||
    snapshot.apiProtocols?.includes("chat-completions") !== true ||
    snapshot.models.length === 0
  ) {
    return undefined;
  }
  return {
    serverId,
    displayName: snapshot.displayName,
    models: snapshot.models.map((model) => ({
      id: model.id,
      ...(model.servedContextWindow === undefined
        ? {}
        : { contextWindow: model.servedContextWindow }),
      ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
      ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts }),
    })),
  };
}

const make = Effect.gen(function* () {
  const settingsService = yield* Settings.ServerSettingsService;
  const registry = yield* InferenceServerRegistry.InferenceServerRegistry;
  const credentials = yield* McpSessionRegistry.McpSessionRegistry;

  const managedServer = Effect.fn("InferenceGatewayAccess.managedServer")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    if (settings._tag === "None") return undefined;
    return managedServerOf(
      settings.value,
      yield* registry.current,
      settings.value.providerInstances[instanceId]?.inferenceServerId,
    );
  });

  return InferenceGateway.InferenceGatewayAccess.of({
    managedServer,
    backgroundCredential: Effect.fn("InferenceGatewayAccess.backgroundCredential")(
      function* (instanceId) {
        const server = yield* managedServer(instanceId);
        if (server === undefined) return undefined;
        const credential = yield* credentials.issueBackgroundInference(
          server.serverId as InferenceServerId,
        );
        return { server, credential };
      },
    ),
  });
});

export const layer = Layer.effect(InferenceGateway.InferenceGatewayAccess, make);

/**
 * Pi lists a managed server's models only after discovery runs with its gateway, so a linked
 * instance re-discovers when what its server offers through the gateway changes.
 */
export const layerRefreshLinkedInstances = Layer.effectDiscard(
  Effect.gen(function* () {
    const settingsService = yield* Settings.ServerSettingsService;
    const registry = yield* InferenceServerRegistry.InferenceServerRegistry;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    let previous = new Map<string, string>();
    yield* registry.streamChanges.pipe(
      Stream.mapEffect((snapshots) =>
        settingsService.getSettings.pipe(
          Effect.map((settings) => {
            const offers = new Map(
              snapshots.map((snapshot) => [
                snapshot.id as string,
                JSON.stringify(managedServerOf(settings, snapshots, snapshot.id) ?? null),
              ]),
            );
            const changed = new Set(
              [...offers.keys(), ...previous.keys()].filter(
                (id) => (offers.get(id) ?? "null") !== (previous.get(id) ?? "null"),
              ),
            );
            previous = offers;
            return Object.entries(settings.providerInstances).flatMap(([instanceId, config]) =>
              config.inferenceServerId !== undefined && changed.has(config.inferenceServerId)
                ? [instanceId as ProviderInstanceId]
                : [],
            );
          }),
          Effect.orElseSucceed((): ReadonlyArray<ProviderInstanceId> => []),
        ),
      ),
      Stream.runForEach((linked) =>
        Effect.forEach(
          linked,
          (instanceId) =>
            instances.getInstance(instanceId).pipe(
              Effect.flatMap((instance) =>
                instance === undefined ? Effect.void : instance.snapshot.refresh,
              ),
              Effect.ignoreCause({ log: true }),
            ),
          { discard: true },
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
