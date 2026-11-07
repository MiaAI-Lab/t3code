import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { InferenceGatewayCredential } from "./mcpSession.ts";

export interface ManagedInferenceModel {
  readonly id: string;
  /** The window the server enforces, when it reports one. */
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEfforts?: ReadonlyArray<string>;
}

/** A linked server whose OpenAI chat route T3's gateway can carry for a harness. */
export interface ManagedInferenceServer {
  readonly serverId: string;
  readonly displayName: string;
  readonly models: ReadonlyArray<ManagedInferenceModel>;
}

/**
 * How harnesses reach a linked inference server through T3's gateway. Thread sessions take their
 * credential from their MCP session config; discovery and text generation borrow a background one.
 */
export class InferenceGatewayAccess extends Context.Service<
  InferenceGatewayAccess,
  {
    /** Undefined unless the instance's linked server is enabled, ready, and serves chat completions. */
    readonly managedServer: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ManagedInferenceServer | undefined>;
    /** A short-lived credential for the instance's managed server, revoked with the scope. */
    readonly backgroundCredential: (instanceId: ProviderInstanceId) => Effect.Effect<
      | {
          readonly server: ManagedInferenceServer;
          readonly credential: InferenceGatewayCredential;
        }
      | undefined,
      never,
      Scope.Scope
    >;
  }
>()("@t3tools/provider-core/server/inferenceGateway/InferenceGatewayAccess") {}
