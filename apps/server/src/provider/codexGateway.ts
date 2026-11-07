import type { ProviderInstanceId, ServerProviderModel } from "@t3tools/contracts";
import * as InferenceGateway from "@t3tools/provider-core/server/inferenceGateway";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

/** Codex reads the bearer from the variable `env_key` names, so it never reaches argv. */
export const CODEX_GATEWAY_TOKEN_ENV = "T3_INFERENCE_TOKEN";

export interface CodexGatewayLaunch {
  readonly args: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
}

const tomlString = (value: string) => JSON.stringify(value);

/**
 * App-server takes only `-c` overrides. Web search is a hosted tool and multi-agent spawns agents
 * T3 does not route; servers that run function tools only reject the first.
 * Codex has no metadata for local models, so it is told the smallest window the server serves.
 */
export function codexGatewayLaunch({
  server,
  credential,
}: InferenceGateway.ManagedServerCredential): CodexGatewayLaunch {
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
      ...(windows.length === 0 ? [] : ["-c", `model_context_window=${Math.min(...windows)}`]),
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

const unmanaged: CodexGatewaySource = {
  resolution: Effect.undefined,
  forSession: () => Effect.undefined,
  forBackground: Effect.undefined,
};

/** Without T3's gateway service (tests, other hosts) Codex runs unmanaged. */
export const makeCodexGatewaySource = Effect.fn("makeCodexGatewaySource")(function* (
  instanceId: ProviderInstanceId,
) {
  const access = yield* Effect.serviceOption(InferenceGateway.InferenceGatewayAccess);
  if (Option.isNone(access)) return unmanaged;
  const gateway = access.value;
  return {
    resolution: gateway.resolve(instanceId, "responses"),
    forSession: Effect.fn("CodexGateway.forSession")(function* (mcpSession) {
      const credential = mcpSession?.inferenceGateway;
      if (credential === undefined) return undefined;
      const server = yield* gateway.managedServer(instanceId, "responses");
      return server?.serverId === credential.serverId
        ? codexGatewayLaunch({ server, credential })
        : undefined;
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
    const note = `${resolution.reason} Codex runs unmanaged.`;
    return { ...draft, message: draft.message ? `${draft.message} ${note}` : note };
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
