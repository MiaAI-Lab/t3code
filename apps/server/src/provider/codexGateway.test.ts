import { it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProviderModel } from "@t3tools/contracts";
import * as InferenceGateway from "@t3tools/provider-core/server/inferenceGateway";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import {
  CODEX_GATEWAY_TOKEN_ENV,
  codexGatewayLaunch,
  makeCodexGatewaySource,
  withCodexGatewayStatus,
} from "./codexGateway.ts";

const server: InferenceGateway.ManagedInferenceServer = {
  serverId: "rtx",
  displayName: "rtx",
  models: [{ id: "GLM-5.3-Flash", contextWindow: 813056 }, { id: "tiny" }],
};
const credential = { serverId: "rtx", baseUrl: "http://t3/inference/rtx/v1", token: "secret" };

it("points app-server at the gateway's Responses route with the token only in env", () => {
  const launch = codexGatewayLaunch({ server, credential });
  expect(launch).toEqual({
    args: [
      "-c",
      'model_providers.t3-rtx={name="rtx (T3)",base_url="http://t3/inference/rtx/v1",wire_api="responses",env_key="T3_INFERENCE_TOKEN"}',
      "-c",
      'model_provider="t3-rtx"',
      "-c",
      "features.multi_agent=false",
      "-c",
      'web_search="disabled"',
      "-c",
      "model_context_window=813056",
    ],
    environment: { [CODEX_GATEWAY_TOKEN_ENV]: "secret" },
  });
  expect(launch.args.join(" ")).not.toContain("secret");
  const unsized = codexGatewayLaunch({
    server: { ...server, models: [{ id: "tiny" }] },
    credential,
  });
  expect(unsized.args.some((arg) => arg.startsWith("model_context_window"))).toBe(false);
});

it.effect("a session launches managed only with its own credential for a Responses server", () =>
  Effect.gen(function* () {
    const sourceFor = (resolution: InferenceGateway.ManagedServerResolution) =>
      makeCodexGatewaySource(ProviderInstanceId.make("codex_local")).pipe(
        Effect.provideService(
          InferenceGateway.InferenceGatewayAccess,
          InferenceGateway.InferenceGatewayAccess.of({
            resolve: () => Effect.succeed(resolution),
            managedServer: (_, protocol) =>
              Effect.succeed(
                resolution.managed && protocol === "responses" ? resolution.server : undefined,
              ),
            backgroundCredential: () => Effect.die("unused"),
            instanceCredential: () => Effect.die("unused"),
          }),
        ),
      );
    type Session = McpProviderSessionConfig;
    const session = { inferenceGateway: credential } as Session;

    const managed = yield* sourceFor({ managed: true, server });
    expect((yield* managed.forSession(session))?.environment).toEqual({
      [CODEX_GATEWAY_TOKEN_ENV]: "secret",
    });
    expect(yield* managed.forSession(undefined)).toBeUndefined();
    expect(
      yield* managed.forSession({
        inferenceGateway: { ...credential, serverId: "spark1" },
      } as Session),
    ).toBeUndefined();

    const noResponses = yield* sourceFor({ managed: false, reason: "No Responses API." });
    expect(yield* noResponses.forSession(session)).toBeUndefined();
  }),
);

it("a managed status offers the server's models; an unmanaged one says why", () => {
  const draft = { enabled: true, message: "Signed in.", models: [] as ServerProviderModel[] };
  const managed = withCodexGatewayStatus(draft, { managed: true, server });
  expect(managed.message).toMatch(/^Experimental: /);
  expect(managed.models.map((model) => [model.slug, model.isDefault])).toEqual([
    ["GLM-5.3-Flash", true],
    ["tiny", undefined],
  ]);
  expect(
    withCodexGatewayStatus(draft, { managed: false, reason: "No Responses API." }).message,
  ).toBe("Signed in. No Responses API. Codex runs unmanaged.");
  expect(withCodexGatewayStatus(draft, undefined)).toBe(draft);
});
