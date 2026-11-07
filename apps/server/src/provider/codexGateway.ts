import type { ProviderInstanceId, ServerProviderModel } from "@t3tools/contracts";
import * as InferenceGateway from "@t3tools/provider-core/server/inferenceGateway";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import { CODEX_FALLBACK_BASE_INSTRUCTIONS } from "./codexFallbackInstructions.ts";

/** Codex reads the bearer from the variable `env_key` names, so it never reaches argv. */
export const CODEX_GATEWAY_TOKEN_ENV = "T3_INFERENCE_TOKEN";

export interface CodexGatewayLaunch {
  readonly args: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
}

const tomlString = (value: string) => JSON.stringify(value);

/** The oldest Codex verified to read `model_catalog_json`; older ones get only a context window. */
const CODEX_MODEL_CATALOG_MIN_VERSION = "0.166.0";

const CODEX_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

/**
 * Codex's model metadata for each served model. Beyond the served window and the efforts the
 * server reports, entries match what Codex assumes for an unknown model, minus image input.
 */
export function codexModelCatalog(server: InferenceGateway.ManagedInferenceServer) {
  return {
    models: server.models.map((model) => ({
      slug: model.id,
      display_name: model.id,
      ...(model.contextWindow === undefined ? {} : { context_window: model.contextWindow }),
      supported_reasoning_levels: (model.reasoningEfforts ?? [])
        .filter((effort) => CODEX_REASONING_EFFORTS.has(effort))
        .map((effort) => ({ effort, description: effort })),
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
      base_instructions: CODEX_FALLBACK_BASE_INSTRUCTIONS,
      support_verbosity: false,
      truncation_policy: { mode: "bytes", limit: 10_000 },
      supports_parallel_tool_calls: true,
      experimental_supported_tools: [],
      input_modalities: ["text"],
    })),
  };
}

const codexModelCatalogJson = (server: InferenceGateway.ManagedInferenceServer) =>
  JSON.stringify(codexModelCatalog(server));

/**
 * App-server takes only `-c` overrides. Web search is a hosted tool and multi-agent spawns agents
 * T3 does not route; servers that run function tools only reject the first.
 * Without a model catalog Codex has no metadata for local models, so it is told the smallest
 * window the server serves.
 */
export function codexGatewayLaunch(
  { server, credential }: InferenceGateway.ManagedServerCredential,
  modelCatalogPath?: string,
): CodexGatewayLaunch {
  const provider = `t3-${server.serverId}`;
  const windows = server.models.flatMap((model) => model.contextWindow ?? []);
  return {
    args: [
      "-c",
      `model_providers.${provider}={name=${tomlString(`${server.displayName} (T3)`)},base_url=${tomlString(credential.baseUrl)},wire_api="responses",env_key=${tomlString(CODEX_GATEWAY_TOKEN_ENV)}}`,
      "-c",
      `model_provider=${tomlString(provider)}`,
      "-c",
      "features.multi_agent=false",
      "-c",
      'web_search="disabled"',
      ...(modelCatalogPath !== undefined
        ? ["-c", `model_catalog_json=${tomlString(modelCatalogPath)}`]
        : windows.length === 0
          ? []
          : ["-c", `model_context_window=${Math.min(...windows)}`]),
    ],
    environment: { [CODEX_GATEWAY_TOKEN_ENV]: credential.token },
  };
}

export interface CodexGatewaySource {
  /** Undefined when the instance is not linked to an inference server. */
  readonly resolution: Effect.Effect<InferenceGateway.ManagedServerResolution | undefined>;
  /** An app-server is opened per thread session, so it uses that session's credential. */
  readonly forSession: (
    mcpSession: McpProviderSessionConfig | undefined,
  ) => Effect.Effect<CodexGatewayLaunch | undefined>;
  /** Text generation borrows a background credential for the scope. */
  readonly forBackground: Effect.Effect<CodexGatewayLaunch | undefined, never, Scope.Scope>;
}

export interface CodexModelCatalogTarget {
  readonly directory: string;
  /** The installed Codex version, when known; the catalog needs a version that reads it. */
  readonly codexVersion: Effect.Effect<string | undefined>;
}

/**
 * Named by content and staged under a temporary name, so a running app-server's catalog never
 * changes and concurrent sessions never see a partial file.
 */
const writeCodexModelCatalog = Effect.fn("CodexGateway.writeModelCatalog")(function* (
  target: CodexModelCatalogTarget,
  server: InferenceGateway.ManagedInferenceServer,
) {
  const version = yield* target.codexVersion;
  if (
    version === undefined ||
    compareSemverVersions(version, CODEX_MODEL_CATALOG_MIN_VERSION) < 0
  ) {
    return undefined;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const content = codexModelCatalogJson(server);
  const catalogPath = path.join(
    target.directory,
    `${encodeURIComponent(server.serverId)}-${(Hash.string(content) >>> 0).toString(16)}.json`,
  );
  if (yield* fileSystem.exists(catalogPath)) return catalogPath;
  yield* fileSystem.makeDirectory(target.directory, { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fileSystem.makeTempDirectoryScoped({
        directory: target.directory,
        prefix: ".catalog-",
      });
      const staged = path.join(staging, "catalog.json");
      yield* fileSystem.writeFileString(staged, content);
      yield* fileSystem.rename(staged, catalogPath);
    }),
  );
  return catalogPath;
});

const unmanaged: CodexGatewaySource = {
  resolution: Effect.undefined,
  forSession: () => Effect.undefined,
  forBackground: Effect.undefined,
};

/**
 * Without T3's gateway service (tests, other hosts) Codex runs unmanaged. Sessions get a model
 * catalog when given a target; otherwise, or if it cannot be written, they run as before.
 */
export const makeCodexGatewaySource = Effect.fn("makeCodexGatewaySource")(function* (
  instanceId: ProviderInstanceId,
  catalog?: CodexModelCatalogTarget,
) {
  const access = yield* Effect.serviceOption(InferenceGateway.InferenceGatewayAccess);
  if (Option.isNone(access)) return unmanaged;
  const gateway = access.value;
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  const catalogPathFor = (server: InferenceGateway.ManagedInferenceServer) =>
    catalog === undefined || Option.isNone(fileSystem) || Option.isNone(path)
      ? Effect.undefined
      : writeCodexModelCatalog(catalog, server).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem.value),
          Effect.provideService(Path.Path, path.value),
          Effect.catch((error) =>
            Effect.logWarning("Codex runs without a model catalog", error).pipe(
              Effect.as(undefined),
            ),
          ),
        );
  return {
    resolution: gateway.resolve(instanceId, "responses"),
    forSession: Effect.fn("CodexGateway.forSession")(function* (mcpSession) {
      const credential = mcpSession?.inferenceGateway;
      if (credential === undefined) return undefined;
      const server = yield* gateway.managedServer(instanceId, "responses");
      if (server?.serverId !== credential.serverId) return undefined;
      return codexGatewayLaunch({ server, credential }, yield* catalogPathFor(server));
    }),
    forBackground: gateway
      .backgroundCredential(instanceId, "responses")
      .pipe(Effect.map((held) => (held === undefined ? undefined : codexGatewayLaunch(held)))),
  } satisfies CodexGatewaySource;
});

/**
 * A managed instance offers only its server's models, since every thread it opens talks to that
 * server; otherwise the status says why the link is not used.
 */
export function withCodexGatewayStatus<
  Draft extends {
    readonly enabled: boolean;
    readonly message?: string | undefined;
    readonly models: ReadonlyArray<ServerProviderModel>;
  },
>(draft: Draft, resolution: InferenceGateway.ManagedServerResolution | undefined): Draft {
  if (resolution === undefined || !draft.enabled) return draft;
  if (!resolution.managed) {
    // Unmanaged Codex uses its own login, which is the cloud; a local instance waits instead.
    const note = resolution.local
      ? `${resolution.reason} Codex waits for it instead of running in the cloud.`
      : `${resolution.reason} Codex runs unmanaged.`;
    return {
      ...draft,
      message: draft.message ? `${draft.message} ${note}` : note,
      ...(resolution.local ? { models: [] } : {}),
    };
  }
  const { serverId, displayName, models } = resolution.server;
  return {
    ...draft,
    message: `Experimental: T3 Code runs Codex on ${displayName} as t3-${serverId}.`,
    models: models.map((model, index) => ({
      slug: model.id,
      name: model.id,
      subProvider: displayName,
      isCustom: false,
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
    })),
  };
}
